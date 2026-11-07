// v3.6 lite install (spec 2026-07-18 v5 §3·§6b): BackfillCoordinator owns
// DB-side embedding recovery — nothing else (A′ boundary).
//
// Two phases share one eligibility barrier:
//   reconciliation  hash-only pass over legacy rows (provenance NULL). Runs in
//                   the background after connect; the model is NOT required.
//   backfill        re-embeds missing/stale rows via the gate. Automatic
//                   backfill (and vector search, enforced by callers) requires
//                   model_ready AND reconciliation ∈ {complete, n/a} — the
//                   barrier that prevents the "re-embed the whole legacy DB"
//                   race when the model becomes ready first (5R must-fix 1).
//
// Work queue = the DB itself (a row is "queued" iff it has no valid vector);
// kick() merely triggers a debounced scan. All reconciliation writes are
// per-row transactions with a CAS re-check so a foreground embed that lands
// first is never downgraded (6R note 3).

import type Database from 'better-sqlite3';
import { searchableVectorSql, VecSlotError, deleteVector } from './vecSlots.js';


// A handle closed by the engine's reopen (wal-sidecar-guard), or an I/O error from a sidecar the
// sync client swapped out: the run was cut, not broken.
const CONN_LOSS_RERUN_MAX = 3;
function isConnectionLoss(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.startsWith('SQLITE_IOERR')) return true;
  return e instanceof Error && /database connection is not open/i.test(e.message);
}

export type ReconState = 'pending' | 'running' | 'complete' | 'failed' | 'deferred' | 'n/a';

export interface CoverageSnapshot {
  // embedded = searchable vectors only (vec-slot-reuse D1c): a _rowids row with validity 0 is missing.
  // error = the slot map of that table could not be resolved; the counts are then not reported.
  // orphan_vectors = searchable vectors with no metadata row (sanitation deletes them · not part of missing).
  chunk: { total: number; embedded: number; verified: number; legacy_assumed: number; orphan_vectors?: number; error?: string };
  entity: { total: number; embedded: number; verified: number; legacy_assumed: number; orphan_vectors?: number; error?: string };
}

export interface CoordinatorDeps {
  db: () => Database.Database | null;
  // Gate access is late-bound: tests swap manager.gate after initialize.
  gateIsReady: () => boolean;
  gateIsDisabled: () => boolean;
  mode: () => 'lazy' | 'eager' | 'off';
  grandfatherAllowed: () => boolean;
  currentProfileId: () => number;
  // Rebuild the CURRENT entity embedding input hash (text-builder version mixed
  // in). Returns null when the entity row is missing or observations are
  // malformed — reconciliation treats that as delete-to-missing (fail-closed).
  buildEntityInputHash: (entityId: string) => string | null;
  // Hash a STORED entity embedding_text with the same function (builder version
  // included) so stored-vs-rebuilt comparison is apples-to-apples.
  hashEntityText: (text: string) => string;
  // Chunk hashes never include the entity text-builder version (spec §6c N2).
  chunkInputHash: (text: string) => string;
  // T6: re-embed callbacks (backfill phase). Return true on success.
  reembedEntity: (entityId: string) => Promise<boolean>;
  reembedChunk: (rowid: number) => Promise<boolean>;
}

const RECON_BATCH = 50;
const KICK_DEBOUNCE_MS = 200;
const SWEEP_MS = 5 * 60_000;

export class BackfillCoordinator {
  private recon: ReconState = 'pending';
  private reconError?: string;
  private reconPromise: Promise<void> | null = null;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private connLossReruns = 0;
  private scanning = false;
  // vec-slot-reuse: rows whose vec0 slot has validity 0 cannot be rewritten in place (sqlite-vec refuses
  // to DELETE many of them); the backfill skips them and asks for the verified rebuild instead.
  private repairWanted = false;
  readonly slotErrors = new Map<string, string>();     // table -> unresolvable slot map message
  repairRequestedAt = 0;
  requestRepair(): void { if (!this.repairWanted) this.repairRequestedAt = Date.now(); this.repairWanted = true; }
  takeRepairRequest(): boolean { const w = this.repairWanted; this.repairWanted = false; return w; }
  get repairRequested(): boolean { return this.repairWanted; }
  private scanPromise: Promise<void> | null = null;
  private rerunRequested = false;
  private snapshot: CoverageSnapshot | null = null;

  constructor(private readonly deps: CoordinatorDeps) {}

  get reconState(): ReconState { return this.recon; }
  // vec-slot-reuse D1b: the idle vector rebuild must not overlap a backfill scan or a reconciliation pass.
  get busy(): boolean { return this.scanning || !!this.scanPromise || this.reconActive || this.recon === 'running'; }
  get reconLastError(): string | undefined { return this.reconError; }

  // Shared eligibility barrier (spec §3): vector search AND automatic backfill.
  // 'n/a' (fresh DB — nothing to reconcile) counts as satisfied (6R note 1).
  get eligible(): boolean {
    return this.deps.gateIsReady() && (this.recon === 'complete' || this.recon === 'n/a');
  }

  // "Unreconciled vector" = a row that actually HAS a vector and no provenance.
  // Entity metadata is joined against entity_embeddings (beta B3): pre-v3.6
  // non-atomic writes can leave metadata-without-vector and vector-without-
  // metadata split states, and neither must be miscounted as reconciled work.
  private countNullWithVector(db: Database.Database): number {
    const ent = db.prepare(
      `SELECT COUNT(*) c FROM entity_embedding_metadata m
       WHERE m.provenance_state IS NULL AND ${searchableVectorSql('entity_embeddings', 'm.rowid')}`
    ).get() as { c: number };
    const chk = db.prepare(
      `SELECT COUNT(*) c FROM chunk_metadata m
       WHERE m.provenance_state IS NULL AND ${searchableVectorSql('chunks', 'm.rowid')}`
    ).get() as { c: number };
    return ent.c + chk.c;
  }

  // Sanitation (beta B3·B4) — runs on EVERY reconciliation entry, even when no
  // NULL rows exist, so profile changes and legacy split states are repaired
  // before vector eligibility can open:
  //   1. entity vectors without metadata (orphans)      -> delete vector
  //   2. stamped entity metadata whose vector row is gone -> normalized to missing, NOT deleted: the row keeps
  //      its rowid and becomes a backfill target (vec-slot-reuse r3 M2; validity-0 vector rows are repaired
  //      inline by deleteVector/writeVector or by the idle rebuild, never DELETEd here)
  //   3. provenance-stamped rows whose compatibility profile != current
  //      (old engine/model profile)                     -> delete-to-missing
  //   4. chunk metadata stamped but vectorless          -> normalize to missing (NULL provenance)
  // Read-only repair check — used by off mode to classify deferred vs n/a
  // without writing (beta 2R residual: split states and old profiles also
  // count as pending repair work, not only provenance-NULL vectors).
  private countRepairables(db: Database.Database): number {
    const profileId = this.deps.currentProfileId();
    const q = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;
    return this.countNullWithVector(db)
      // vec-slot-reuse r3 M2: searchable orphans only (validity-0 rows belong to the rebuild); vectorless
      // metadata counts only while still stamped (it is normalized to missing, not deleted, to keep its rowid).
      + q(`SELECT COUNT(*) c FROM entity_embeddings_rowids m WHERE m.rowid NOT IN (SELECT rowid FROM entity_embedding_metadata) AND ${searchableVectorSql('entity_embeddings', 'm.rowid')}`)
      // IN-42: searchable chunk vectors without chunk_metadata (same rule as entity orphans)
      + q(`SELECT COUNT(*) c FROM chunks_rowids m WHERE m.rowid NOT IN (SELECT rowid FROM chunk_metadata) AND ${searchableVectorSql('chunks', 'm.rowid')}`)
      + q(`SELECT COUNT(*) c FROM entity_embedding_metadata WHERE provenance_state IS NOT NULL AND rowid NOT IN (SELECT rowid FROM entity_embeddings_rowids)`)
      + q(`SELECT COUNT(*) c FROM entity_embedding_metadata WHERE provenance_state IS NOT NULL AND profile_id IS NOT ?`, profileId)
      + q(`SELECT COUNT(*) c FROM chunk_metadata m WHERE m.provenance_state IS NOT NULL AND m.profile_id IS NOT ? AND m.rowid IN (SELECT rowid FROM chunks_rowids)`, profileId)
      // stamped chunk metadata whose vector is gone (beta 3R M3)
      + q(`SELECT COUNT(*) c FROM chunk_metadata WHERE provenance_state IS NOT NULL AND rowid NOT IN (SELECT rowid FROM chunks_rowids)`);
  }

  // Batched (beta 2R residual): each batch commits its own transaction and
  // yields the event loop — a large DB or a profile switch must not stall the
  // freshly connected server (the lite-install point of it all).
  private async sanitize(db: Database.Database): Promise<number> {
    const profileId = this.deps.currentProfileId();
    let touched = 0;
    const batchTx = db.transaction((fn: () => void) => fn());
    // Split-state cleanup, LIMIT-batched with yields (beta 3R non-blocker): a
    // pathological DB must not stall the freshly connected server even here.
    const batchedRun = async (sql: string) => {
      for (;;) {
        if (this.shuttingDown) throw new Error('shutdown during sanitation');
        let changes = 0;
        batchTx(() => { changes = db.prepare(sql).run().changes; });
        touched += changes;
        if (changes < RECON_BATCH) return;
        await new Promise(r => setImmediate(r));
      }
    };
    // 1. searchable entity vectors without metadata -> delete (validity-0 orphans are left to the rebuild:
    //    vec0 refuses to DELETE most of them, vec-slot-reuse r3 M2)
    for (;;) {
      if (this.shuttingDown) throw new Error('shutdown during sanitation');
      const orphans = db.prepare(
        `SELECT m.rowid FROM entity_embeddings_rowids m
         WHERE m.rowid NOT IN (SELECT rowid FROM entity_embedding_metadata) AND ${searchableVectorSql('entity_embeddings', 'm.rowid')} LIMIT ${RECON_BATCH}`
      ).all() as Array<{ rowid: number }>;
      if (orphans.length === 0) break;
      batchTx(() => { for (const r of orphans) { deleteVector(db, 'entity_embeddings', r.rowid); touched++; } });
      if (orphans.length < RECON_BATCH) break;
      await new Promise(r => setImmediate(r));
    }
    // 1b. searchable chunk vectors without metadata -> delete (IN-42 · same batching and validity rule as 1)
    for (;;) {
      if (this.shuttingDown) throw new Error('shutdown during sanitation');
      const orphans = db.prepare(
        `SELECT m.rowid FROM chunks_rowids m
         WHERE m.rowid NOT IN (SELECT rowid FROM chunk_metadata) AND ${searchableVectorSql('chunks', 'm.rowid')} LIMIT ${RECON_BATCH}`
      ).safeIntegers(true).all() as Array<{ rowid: bigint }>;
      if (orphans.length === 0) break;
      batchTx(() => { for (const r of orphans) { deleteVector(db, 'chunks', r.rowid); touched++; } });
      if (orphans.length < RECON_BATCH) break;
      await new Promise(r => setImmediate(r));
    }
    // 2. stamped entity metadata whose vector row is gone -> normalize to missing (was: delete). Keeping the
    //    row keeps its rowid, so the backfill re-inserts at the same rowid (r3 M2 case C: restart after repair).
    await batchedRun(
      `UPDATE entity_embedding_metadata SET input_hash = NULL, profile_id = NULL, provenance_state = NULL
       WHERE rowid IN (
         SELECT rowid FROM entity_embedding_metadata
         WHERE provenance_state IS NOT NULL AND rowid NOT IN (SELECT rowid FROM entity_embeddings_rowids) LIMIT ${RECON_BATCH})`);
    await batchedRun(
      `UPDATE chunk_metadata SET input_hash = NULL, profile_id = NULL, provenance_state = NULL
       WHERE rowid IN (
         SELECT rowid FROM chunk_metadata WHERE provenance_state IS NOT NULL AND rowid NOT IN (SELECT rowid FROM chunks_rowids) LIMIT ${RECON_BATCH})`);
    // Old-profile rows: row deletes in bounded batches with yields.
    for (;;) {
      if (this.shuttingDown) throw new Error('shutdown during sanitation');
      const staleEnt = db.prepare(
        `SELECT m.rowid FROM entity_embedding_metadata m
         WHERE m.provenance_state IS NOT NULL AND m.profile_id IS NOT ? LIMIT ${RECON_BATCH}`
      ).all(profileId) as Array<{ rowid: number }>;
      if (staleEnt.length === 0) break;
      batchTx(() => {
        for (const r of staleEnt) {
          deleteVector(db, 'entity_embeddings', r.rowid);   // validity-0: left to the rebuild
          db.prepare(`UPDATE entity_embedding_metadata SET input_hash = NULL, profile_id = NULL, provenance_state = NULL WHERE rowid = ?`).run(r.rowid);
          touched++;
        }
      });
      await new Promise(r => setImmediate(r));
    }
    for (;;) {
      if (this.shuttingDown) throw new Error('shutdown during sanitation');
      const staleChunk = db.prepare(
        `SELECT m.rowid FROM chunk_metadata m
         WHERE m.provenance_state IS NOT NULL AND m.profile_id IS NOT ? AND m.rowid IN (SELECT rowid FROM chunks_rowids) LIMIT ${RECON_BATCH}`
      ).all(profileId) as Array<{ rowid: number }>;
      if (staleChunk.length === 0) break;
      batchTx(() => {
        for (const r of staleChunk) {
          deleteVector(db, 'chunks', r.rowid);   // validity-0: left to the rebuild
          db.prepare(`UPDATE chunk_metadata SET input_hash = NULL, profile_id = NULL, provenance_state = NULL WHERE rowid = ?`).run(r.rowid);
          touched++;
        }
      });
      await new Promise(r => setImmediate(r));
    }
    if (touched > 0) {
      this.snapshot = null;   // cached coverage (incl. orphan_vectors) is stale — also on the legacy=0 early return (2_ r1 R2)
      console.error(`🧾 provenance sanitation: ${touched} split-state/old-profile/orphan rows invalidated`);
    }
    return touched;
  }

  // Single-flight, idempotent. off mode defers (spec §9); fresh DBs go straight
  // to 'n/a'. Row-level errors are fail-closed (vector deleted -> missing);
  // systemic errors transition to 'failed' and keep eligibility shut.
  runReconciliation(): Promise<void> {
    if (!this.reconPromise) {
      // r3 M4: busy for the whole pass (sanitize included), not only while recon === 'running'.
      this.reconActive = true;
      this.reconPromise = this.reconcileOnce().finally(() => { this.reconActive = false; });
    }
    return this.reconPromise;
  }
  private reconActive = false;

  private async reconcileOnce(): Promise<void> {
    const db = this.deps.db();
    if (!db) { this.recon = 'failed'; this.reconError = 'db not initialized'; return; }
    if (this.recon === 'complete' || this.recon === 'n/a') return;
    if (this.deps.mode() === 'off') {
      // No writes in off mode — classification only (spec §3 N4). "Repair
      // needed" includes split states and old profiles, not just NULL vectors
      // (beta 2R residual).
      this.recon = this.countRepairables(db) > 0 ? 'deferred' : 'n/a';
      this.reconPromise = null; // a later lazy/eager restart may re-run
      return;
    }
    await this.sanitize(db); // split states + old profiles first (beta B3·B4)
    const legacy = this.countNullWithVector(db);
    if (legacy === 0) { this.recon = 'n/a'; this.kick(); return; }
    this.recon = 'running';
    console.error(`🧾 provenance reconciliation: ${legacy} legacy vector rows to examine...`);
    try {
      await this.reconcileEntities(db);
      await this.reconcileChunks(db);
      const remaining = this.countNullWithVector(db);
      if (remaining !== 0) throw new Error(`complete invariant violated: ${remaining} unreconciled vectors remain`);
      this.recon = 'complete';
      this.connLossReruns = 0;
      this.snapshot = null;
      console.error('✅ provenance reconciliation complete');
      this.kick();
    } catch (e) {
      if (this.shuttingDown) {
        // Interrupted by shutdown, not broken: next boot resumes the remaining
        // NULL rows (per-row transactions make this crash-safe).
        this.recon = 'pending';
        this.reconPromise = null;
        return;
      }
      if (isConnectionLoss(e) && this.connLossReruns < CONN_LOSS_RERUN_MAX) {
        // The engine reopened the connection under us (wal-sidecar-guard). Not broken: run
        // again on the new handle. If there is no handle right now (reopen failed), the engine
        // starts reconciliation itself once it reopens.
        this.connLossReruns++;
        this.recon = 'pending';
        this.reconPromise = null;
        if (this.deps.db()) setTimeout(() => { void this.runReconciliation(); }, 0).unref?.();
        console.error(`↻ reconciliation interrupted by a reconnect — rerun ${this.connLossReruns}/${CONN_LOSS_RERUN_MAX}`);
        return;
      }
      this.recon = 'failed';
      this.reconError = e instanceof Error ? e.message : String(e);
      console.error(`❌ reconciliation failed — vector search stays disabled: ${this.reconError}`);
    }
  }

  private async reconcileEntities(db: Database.Database): Promise<void> {
    const profileId = this.deps.currentProfileId();
    const allow = this.deps.grandfatherAllowed();
    // Malformed rows (NULL embedding_text / unbuildable current text) are
    // dropped fail-closed AND recorded (spec §6b — beta 1R supplement).
    const recordMalformed = db.prepare(
      `INSERT INTO embedding_backfill_failures (kind, target_id, input_hash, profile_id, attempts, last_error, updated_at)
       VALUES ('entity', ?, NULL, ?, 0, ?, datetime('now'))
       ON CONFLICT(kind, target_id) DO UPDATE SET last_error = excluded.last_error, updated_at = datetime('now')`);
    for (;;) {
      if (this.shuttingDown) throw new Error('shutdown during reconciliation');
      // Vector-join (beta B3): only rows that actually have a vector are
      // grandfather candidates — metadata-without-vector was already removed by
      // sanitize().
      const rows = db.prepare(
        `SELECT m.rowid, m.entity_id, m.embedding_text FROM entity_embedding_metadata m
         WHERE m.provenance_state IS NULL AND ${searchableVectorSql('entity_embeddings', 'm.rowid')} LIMIT ${RECON_BATCH}`
      ).all() as Array<{ rowid: number; entity_id: string; embedding_text: string | null }>;
      if (rows.length === 0) return;
      for (const row of rows) {
        const dropTx = db.transaction(() => {
          // CAS re-check inside the transaction: a foreground embed may have
          // replaced this row with a verified vector in the meantime.
          const cur = db.prepare(
            `SELECT provenance_state FROM entity_embedding_metadata WHERE rowid = ?`
          ).get(row.rowid) as { provenance_state: string | null } | undefined;
          if (!cur || cur.provenance_state !== null) return;
          deleteVector(db, 'entity_embeddings', row.rowid);
          db.prepare(`DELETE FROM entity_embedding_metadata WHERE rowid = ?`).run(row.rowid);
        });
        const stampTx = db.transaction((hash: string) => {
          const cur = db.prepare(
            `SELECT provenance_state, embedding_text FROM entity_embedding_metadata WHERE rowid = ?`
          ).get(row.rowid) as { provenance_state: string | null; embedding_text: string | null } | undefined;
          if (!cur || cur.provenance_state !== null || cur.embedding_text !== row.embedding_text) return;
          db.prepare(
            `UPDATE entity_embedding_metadata
             SET input_hash = ?, profile_id = ?, provenance_state = 'legacy_assumed' WHERE rowid = ?`
          ).run(hash, profileId, row.rowid);
        });
        // Malformed-row observability (beta 2R residual): the vector drop and
        // the failure record commit in ONE transaction — a crash between the
        // two cannot lose the record.
        const dropAndRecord = db.transaction((reason: string) => {
          dropTx();
          recordMalformed.run(row.entity_id, profileId, reason);
        });
        try {
          if (!allow) { dropTx(); continue; }
          if (row.embedding_text === null) {
            dropAndRecord('reconciliation: stored embedding_text is NULL');
            continue;
          }
          const currentHash = this.deps.buildEntityInputHash(row.entity_id);
          if (currentHash === null) {
            dropAndRecord('reconciliation: current entity text unbuildable (malformed observations?)');
            continue;
          }
          const storedHash = this.deps.hashEntityText(row.embedding_text);
          if (storedHash === currentHash) stampTx(currentHash);
          else dropTx(); // stale (e.g. old deleteObservations residue) -> missing, normal backfill target
        } catch (rowErr) {
          // Row-level isolation: try to invalidate; if even that fails, escalate.
          try { dropTx(); } catch {
            throw new Error(`row-level reconciliation failure on ${row.entity_id}: ${rowErr instanceof Error ? rowErr.message : rowErr}`);
          }
        }
      }
      await new Promise(r => setImmediate(r));
    }
  }

  private async reconcileChunks(db: Database.Database): Promise<void> {
    const profileId = this.deps.currentProfileId();
    const allow = this.deps.grandfatherAllowed();
    for (;;) {
      if (this.shuttingDown) throw new Error('shutdown during reconciliation');
      const rows = db.prepare(
        `SELECT m.rowid, m.text FROM chunk_metadata m
         WHERE m.provenance_state IS NULL AND ${searchableVectorSql('chunks', 'm.rowid')} LIMIT ${RECON_BATCH}`
      ).all() as Array<{ rowid: number; text: string | null }>;
      if (rows.length === 0) return;
      for (const row of rows) {
        const dropTx = db.transaction(() => {
          const cur = db.prepare(`SELECT provenance_state FROM chunk_metadata WHERE rowid = ?`)
            .get(row.rowid) as { provenance_state: string | null } | undefined;
          if (!cur || cur.provenance_state !== null) return;
          // Vector removed; provenance stays NULL. The barrier only protects
          // VECTOR-BEARING NULL rows — vectorless rows are always legitimate
          // backfill targets (spec §6c "벡터 없음").
          deleteVector(db, 'chunks', row.rowid);
          db.prepare(`UPDATE chunk_metadata SET input_hash = NULL, profile_id = NULL WHERE rowid = ?`)
            .run(row.rowid);
        });
        try {
          if (!allow || row.text === null) { dropTx(); continue; }
          // chunk_metadata.text is never updated in place (runtime code is
          // INSERT/DELETE only — regression-locked in migration12 test), so the
          // stored vector's input IS the current text (spec §6b).
          const hash = this.deps.chunkInputHash(row.text);
          const stampTx = db.transaction(() => {
            const cur = db.prepare(`SELECT provenance_state FROM chunk_metadata WHERE rowid = ?`)
              .get(row.rowid) as { provenance_state: string | null } | undefined;
            if (!cur || cur.provenance_state !== null) return;
            db.prepare(
              `UPDATE chunk_metadata SET input_hash = ?, profile_id = ?, provenance_state = 'legacy_assumed'
               WHERE rowid = ?`
            ).run(hash, profileId, row.rowid);
          });
          stampTx();
        } catch (rowErr) {
          try { dropTx(); } catch {
            throw new Error(`row-level chunk reconciliation failure on rowid ${row.rowid}: ${rowErr instanceof Error ? rowErr.message : rowErr}`);
          }
        }
      }
      await new Promise(r => setImmediate(r));
    }
  }

  // Debounced automatic-backfill trigger. No-op unless the shared barrier is
  // open; disabled mode never scans, never records failures (spec §3 N4).
  kick(): void {
    if (this.shuttingDown || this.deps.gateIsDisabled()) return;
    if (!this.eligible) return;
    // A kick landing during a running scan must not be LOST (beta 4R M2): the
    // running scan works from a snapshot and may miss rows created after it —
    // record the wake-up and re-run once the current scan settles, without
    // overwriting the tracked scanPromise.
    if (this.scanPromise || this.scanning) { this.rerunRequested = true; return; }
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      // Tracked so shutdown can await the whole scan, not just poll `scanning`
      // (beta 2R B2).
      this.scanPromise = this.scanAndBackfill()
        .catch(e => console.error(`⚠️ backfill scan error: ${e instanceof Error ? e.message : e}`))
        .finally(() => {
          this.scanPromise = null;
          if (this.rerunRequested && !this.shuttingDown) {
            this.rerunRequested = false;
            this.kick();
          }
        });
    }, KICK_DEBOUNCE_MS);
    this.kickTimer.unref?.();
  }

  sweepStart(): void {
    if (this.deps.mode() === 'off') return;
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.kick(), SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  // Automatic backfill (spec §6c): targets = no vector ∪ input-hash mismatch ∪
  // compatibility-profile mismatch — but NEVER a vector-bearing provenance-NULL
  // row (those belong to reconciliation; 5R barrier). Chunks first (hybridSearch
  // coverage recovers before entity/graph quality). Failures are recorded with
  // a per-target attempts cap; 3 consecutive DISTINCT-target failures abort the
  // batch as a systemic model problem (the gate's retry policy owns recovery).
  protected async scanAndBackfill(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const db = this.deps.db();
      if (!db || !this.eligible) return;
      const profileId = this.deps.currentProfileId();

      const capStmt = db.prepare(
        `SELECT attempts, input_hash, profile_id FROM embedding_backfill_failures WHERE kind = ? AND target_id = ?`);
      const failStmt = db.prepare(
        `INSERT INTO embedding_backfill_failures (kind, target_id, input_hash, profile_id, attempts, last_error, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, datetime('now'))
         ON CONFLICT(kind, target_id) DO UPDATE SET
           attempts = attempts + 1, input_hash = excluded.input_hash,
           profile_id = excluded.profile_id, last_error = excluded.last_error, updated_at = datetime('now')`);
      const clearStmt = db.prepare(`DELETE FROM embedding_backfill_failures WHERE kind = ? AND target_id = ?`);
      const FAIL_CAP = 5;
      let consecutive = 0;
      let lastFailedTarget: string | null = null;

      const shouldSkip = (kind: string, targetId: string, currentHash: string | null): boolean => {
        const f = capStmt.get(kind, targetId) as { attempts: number; input_hash: string | null; profile_id: number | null } | undefined;
        if (!f) return false;
        // Reset-on-change: content or profile moved on -> the failure record is stale.
        if (f.input_hash !== currentHash || f.profile_id !== profileId) {
          clearStmt.run(kind, targetId);
          return false;
        }
        return f.attempts >= FAIL_CAP;
      };
      const recordResult = async (kind: string, targetId: string, currentHash: string | null,
        run: () => Promise<boolean>): Promise<'ok' | 'fail' | 'abort'> => {
        try {
          const ok = await run();
          // beta 2R B2: an inference can outlive both settle deadlines. After
          // ANY await, no DB statement may run once shutdown started — the DB
          // handle may already be closed.
          if (this.shuttingDown) return 'abort';
          if (ok) { clearStmt.run(kind, targetId); consecutive = 0; return 'ok'; }
          failStmt.run(kind, targetId, currentHash, profileId, 'reembed returned false');
        } catch (e) {
          if (this.shuttingDown) return 'abort';
          failStmt.run(kind, targetId, currentHash, profileId,
            e instanceof Error ? e.message.slice(0, 300) : String(e));
        }
        if (lastFailedTarget !== targetId) { consecutive++; lastFailedTarget = targetId; }
        return consecutive >= 3 ? 'abort' : 'fail';
      };

      // Phase 1: chunks.
      let sawInvalid = false;
      const errorsBefore = JSON.stringify([...this.slotErrors]);
      const slotErrorsChanged = () => JSON.stringify([...this.slotErrors]) !== errorsBefore;
      // has_vec = searchable (D1c) · has_row = a _rowids row exists (valid or validity 0).
      // An unresolvable slot map stops only this phase; the entity phase still runs.
      type ChunkScanRow = { rowid: number; text: string; input_hash: string | null; profile_id: number | null; provenance_state: string | null; has_vec: number; has_row: number };
      let chunkRows: ChunkScanRow[] = [];
      try {
        chunkRows = db.prepare(
          `SELECT m.rowid, m.text, m.input_hash, m.profile_id, m.provenance_state,
                  ${searchableVectorSql('chunks', 'm.rowid')} AS has_vec,
                  EXISTS(SELECT 1 FROM chunks_rowids r WHERE r.rowid = m.rowid) AS has_row
           FROM chunk_metadata m WHERE m.text IS NOT NULL`
        ).all() as ChunkScanRow[];
        this.slotErrors.delete('chunks');
      } catch (e) {
        if (!(e instanceof VecSlotError) && !String((e as Error).message).includes('vec0 slot')) throw e;
        this.slotErrors.set('chunks', (e as Error).message);
        console.error(`⚠️ backfill: chunk slot map unresolvable, chunk phase held: ${(e as Error).message}`);
      }
      let processed = 0;
      for (const row of chunkRows) {
        if (this.shuttingDown || !this.eligible) return;
        if (row.has_row && !row.has_vec) { this.requestRepair(); sawInvalid = true; continue; }   // validity 0 -> rebuild
        const currentHash = this.deps.chunkInputHash(row.text);
        const isTarget = !row.has_vec
          || (row.provenance_state !== null && (row.profile_id !== profileId || row.input_hash !== currentHash));
        if (!isTarget) continue;
        const targetId = String(row.rowid);
        if (shouldSkip('chunk', targetId, currentHash)) continue;
        const outcome = await recordResult('chunk', targetId, currentHash,
          () => this.deps.reembedChunk(row.rowid));
        if (outcome === 'abort') { console.error('⚠️ backfill aborted: 3 consecutive distinct-target failures (systemic)'); return; }
        if (++processed % 8 === 0) await new Promise(r => setImmediate(r));
      }

      // Phase 2: entities.
      type EntityScanRow = { id: string; input_hash: string | null; profile_id: number | null; provenance_state: string | null; meta_rowid: number | null; has_vec: number; has_row: number };
      let entityRows: EntityScanRow[] = [];
      try {
        entityRows = db.prepare(
          `SELECT e.id, m.input_hash, m.profile_id, m.provenance_state, m.rowid AS meta_rowid,
                  CASE WHEN m.rowid IS NOT NULL AND ${searchableVectorSql('entity_embeddings', 'm.rowid')} THEN 1 ELSE 0 END AS has_vec,
                  CASE WHEN m.rowid IS NOT NULL AND EXISTS(SELECT 1 FROM entity_embeddings_rowids r WHERE r.rowid = m.rowid) THEN 1 ELSE 0 END AS has_row
           FROM entities e LEFT JOIN entity_embedding_metadata m ON m.entity_id = e.id`
        ).all() as EntityScanRow[];
        this.slotErrors.delete('entity_embeddings');
      } catch (e) {
        if (!(e instanceof VecSlotError) && !String((e as Error).message).includes('vec0 slot')) throw e;
        this.slotErrors.set('entity_embeddings', (e as Error).message);
        console.error(`⚠️ backfill: entity slot map unresolvable, entity phase held: ${(e as Error).message}`);
      }
      for (const row of entityRows) {
        if (this.shuttingDown || !this.eligible) return;
        if (row.has_row && !row.has_vec) { this.requestRepair(); sawInvalid = true; continue; }   // validity 0 -> rebuild
        const currentHash = this.deps.buildEntityInputHash(row.id);
        if (currentHash === null) continue;                      // malformed entity: leave to explicit repair
        // Vector existence checked explicitly (beta B3): metadata alone is not
        // proof of an embedded row.
        const isTarget = row.meta_rowid === null || !row.has_vec
          || (row.provenance_state !== null && (row.profile_id !== profileId || row.input_hash !== currentHash));
        if (!isTarget) continue;
        if (shouldSkip('entity', row.id, currentHash)) continue;
        const outcome = await recordResult('entity', row.id, currentHash,
          () => this.deps.reembedEntity(row.id));
        if (outcome === 'abort') { console.error('⚠️ backfill aborted: 3 consecutive distinct-target failures (systemic)'); return; }
        if (++processed % 8 === 0) await new Promise(r => setImmediate(r));
      }

      if (sawInvalid || slotErrorsChanged()) this.snapshot = null;   // r3 M3: coverage reflects what the scan saw
      if (processed > 0) {
        this.snapshot = null;
        console.error(`✅ backfill pass complete (${processed} rows examined for re-embedding)`);
      }
    } finally {
      this.scanning = false;
    }
  }

  invalidateCoverage(): void { this.snapshot = null; }

  coverage(): CoverageSnapshot {
    const db = this.deps.db();
    if (!db) return { chunk: { total: 0, embedded: 0, verified: 0, legacy_assumed: 0 },
                      entity: { total: 0, embedded: 0, verified: 0, legacy_assumed: 0 } };
    if (this.snapshot) return this.snapshot;
    const chunkTotal = (db.prepare(`SELECT COUNT(*) c FROM chunk_metadata`).get() as { c: number }).c;
    // Searchable only (D1c). A slot map error is reported per table instead of a count.
    const byState = (sql: string): { rows: Array<{ s: string | null; c: number }>; error?: string } => {
      try { return { rows: db.prepare(sql).all() as Array<{ s: string | null; c: number }> }; }
      catch (e) {
        if (!(e instanceof VecSlotError) && !String((e as Error).message).includes('vec0 slot')) throw e;
        return { rows: [], error: (e as Error).message };
      }
    };
    const chunkQ = byState(
      `SELECT m.provenance_state s, COUNT(*) c FROM chunk_metadata m
       WHERE ${searchableVectorSql('chunks', 'm.rowid')} GROUP BY m.provenance_state`);
    const chunkBy = chunkQ.rows;
    const entTotal = (db.prepare(`SELECT COUNT(*) c FROM entities`).get() as { c: number }).c;
    // Vector-join (beta B3): metadata without an actual vector is missing, not embedded.
    const entQ = byState(
      `SELECT m.provenance_state s, COUNT(*) c FROM entity_embedding_metadata m
       WHERE ${searchableVectorSql('entity_embeddings', 'm.rowid')} GROUP BY m.provenance_state`);
    const entBy = entQ.rows;
    const orphanQ = (t: 'chunks' | 'entity_embeddings', meta: string): number | undefined => {
      try { return (db.prepare(`SELECT COUNT(*) c FROM ${t}_rowids m WHERE m.rowid NOT IN (SELECT rowid FROM ${meta}) AND ${searchableVectorSql(t, 'm.rowid')}`).get() as { c: number }).c; }
      catch (e) { if (!(e instanceof VecSlotError) && !String((e as Error).message).includes('vec0 slot')) throw e; return undefined; }
    };
    const chunkOrphans = orphanQ('chunks', 'chunk_metadata');
    const entOrphans = orphanQ('entity_embeddings', 'entity_embedding_metadata');
    const pick = (rows: Array<{ s: string | null; c: number }>, s: string) =>
      rows.find(r => r.s === s)?.c ?? 0;
    // Searchable = verified + legacy_assumed. NULL rows (pre-reconciliation or
    // deferred in off mode) are NOT counted as embedded (6R note 4).
    const chunkVerified = pick(chunkBy, 'verified');
    const chunkLegacy = pick(chunkBy, 'legacy_assumed');
    const entVerified = pick(entBy, 'verified');
    const entLegacy = pick(entBy, 'legacy_assumed');
    this.snapshot = {
      chunk: { total: chunkTotal, embedded: chunkVerified + chunkLegacy, verified: chunkVerified, legacy_assumed: chunkLegacy, orphan_vectors: chunkOrphans,
               ...(chunkQ.error ? { error: chunkQ.error } : {}) },
      entity: { total: entTotal, embedded: entVerified + entLegacy, verified: entVerified, legacy_assumed: entLegacy, orphan_vectors: entOrphans,
                ...(entQ.error ? { error: entQ.error } : {}) },
    };
    return this.snapshot;
  }

  // spec §3 shutdown order (beta B1): block new batches, let the current row
  // transaction finish, settle BOTH the backfill loop and an in-flight
  // reconciliation pass, then the caller closes the DB — nothing may touch a
  // closed handle afterwards.
  async shutdown(deadlineMs = 5000): Promise<void> {
    this.shuttingDown = true;
    if (this.kickTimer) { clearTimeout(this.kickTimer); this.kickTimer = null; }
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    const deadline = Date.now() + deadlineMs;
    if (this.reconPromise) {
      await Promise.race([
        this.reconPromise.catch(() => { /* settled */ }),
        new Promise(r => setTimeout(r, Math.max(0, deadline - Date.now()))),
      ]);
    }
    if (this.scanPromise) {
      await Promise.race([
        this.scanPromise,
        new Promise(r => setTimeout(r, Math.max(0, deadline - Date.now()))),
      ]);
    }
    while (this.scanning && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 20));
    }
    // Past the deadline a scan may still be pending on a slow inference — the
    // shuttingDown guards inside recordResult() make any late completion a
    // DB-write no-op (beta 2R B2).
  }
}
