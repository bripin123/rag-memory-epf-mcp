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

export type ReconState = 'pending' | 'running' | 'complete' | 'failed' | 'deferred' | 'n/a';

export interface CoverageSnapshot {
  chunk: { total: number; embedded: number; verified: number; legacy_assumed: number };
  entity: { total: number; embedded: number; verified: number; legacy_assumed: number };
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
  private scanning = false;
  private snapshot: CoverageSnapshot | null = null;

  constructor(private readonly deps: CoordinatorDeps) {}

  get reconState(): ReconState { return this.recon; }
  get reconLastError(): string | undefined { return this.reconError; }

  // Shared eligibility barrier (spec §3): vector search AND automatic backfill.
  // 'n/a' (fresh DB — nothing to reconcile) counts as satisfied (6R note 1).
  get eligible(): boolean {
    return this.deps.gateIsReady() && (this.recon === 'complete' || this.recon === 'n/a');
  }

  private countNullWithVector(db: Database.Database): number {
    const ent = db.prepare(
      `SELECT COUNT(*) c FROM entity_embedding_metadata WHERE provenance_state IS NULL`
    ).get() as { c: number };
    const chk = db.prepare(
      `SELECT COUNT(*) c FROM chunk_metadata m JOIN chunks v ON v.rowid = m.rowid
       WHERE m.provenance_state IS NULL`
    ).get() as { c: number };
    return ent.c + chk.c;
  }

  // Single-flight, idempotent. off mode defers (spec §9); fresh DBs go straight
  // to 'n/a'. Row-level errors are fail-closed (vector deleted -> missing);
  // systemic errors transition to 'failed' and keep eligibility shut.
  runReconciliation(): Promise<void> {
    if (!this.reconPromise) this.reconPromise = this.reconcileOnce();
    return this.reconPromise;
  }

  private async reconcileOnce(): Promise<void> {
    const db = this.deps.db();
    if (!db) { this.recon = 'failed'; this.reconError = 'db not initialized'; return; }
    if (this.recon === 'complete' || this.recon === 'n/a') return;
    const legacy = this.countNullWithVector(db);
    if (this.deps.mode() === 'off') {
      this.recon = legacy > 0 ? 'deferred' : 'n/a';
      this.reconPromise = null; // a later lazy/eager restart may re-run
      return;
    }
    if (legacy === 0) { this.recon = 'n/a'; this.kick(); return; }
    this.recon = 'running';
    console.error(`🧾 provenance reconciliation: ${legacy} legacy vector rows to examine...`);
    try {
      await this.reconcileEntities(db);
      await this.reconcileChunks(db);
      const remaining = this.countNullWithVector(db);
      if (remaining !== 0) throw new Error(`complete invariant violated: ${remaining} unreconciled vectors remain`);
      this.recon = 'complete';
      this.snapshot = null;
      console.error('✅ provenance reconciliation complete');
      this.kick();
    } catch (e) {
      this.recon = 'failed';
      this.reconError = e instanceof Error ? e.message : String(e);
      console.error(`❌ reconciliation failed — vector search stays disabled: ${this.reconError}`);
    }
  }

  private async reconcileEntities(db: Database.Database): Promise<void> {
    const profileId = this.deps.currentProfileId();
    const allow = this.deps.grandfatherAllowed();
    for (;;) {
      if (this.shuttingDown) throw new Error('shutdown during reconciliation');
      const rows = db.prepare(
        `SELECT rowid, entity_id, embedding_text FROM entity_embedding_metadata
         WHERE provenance_state IS NULL LIMIT ${RECON_BATCH}`
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
          db.exec(`DELETE FROM entity_embeddings WHERE rowid = ${row.rowid}`);
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
        try {
          if (!allow || row.embedding_text === null) { dropTx(); continue; }
          const currentHash = this.deps.buildEntityInputHash(row.entity_id);
          const storedHash = this.deps.hashEntityText(row.embedding_text);
          if (currentHash !== null && storedHash === currentHash) stampTx(currentHash);
          else dropTx(); // stale (e.g. old deleteObservations residue) or malformed -> missing
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
        `SELECT m.rowid, m.text FROM chunk_metadata m JOIN chunks v ON v.rowid = m.rowid
         WHERE m.provenance_state IS NULL LIMIT ${RECON_BATCH}`
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
          db.exec(`DELETE FROM chunks WHERE rowid = ${row.rowid}`);
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
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.scanAndBackfill().catch(e =>
        console.error(`⚠️ backfill scan error: ${e instanceof Error ? e.message : e}`));
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
          if (ok) { clearStmt.run(kind, targetId); consecutive = 0; return 'ok'; }
          failStmt.run(kind, targetId, currentHash, profileId, 'reembed returned false');
        } catch (e) {
          failStmt.run(kind, targetId, currentHash, profileId,
            e instanceof Error ? e.message.slice(0, 300) : String(e));
        }
        if (lastFailedTarget !== targetId) { consecutive++; lastFailedTarget = targetId; }
        return consecutive >= 3 ? 'abort' : 'fail';
      };

      // Phase 1: chunks.
      const chunkRows = db.prepare(
        `SELECT m.rowid, m.text, m.input_hash, m.profile_id, m.provenance_state,
                EXISTS(SELECT 1 FROM chunks v WHERE v.rowid = m.rowid) AS has_vec
         FROM chunk_metadata m WHERE m.text IS NOT NULL`
      ).all() as Array<{ rowid: number; text: string; input_hash: string | null; profile_id: number | null; provenance_state: string | null; has_vec: number }>;
      let processed = 0;
      for (const row of chunkRows) {
        if (this.shuttingDown || !this.eligible) return;
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
      const entityRows = db.prepare(
        `SELECT e.id, m.input_hash, m.profile_id, m.provenance_state, m.rowid AS meta_rowid
         FROM entities e LEFT JOIN entity_embedding_metadata m ON m.entity_id = e.id`
      ).all() as Array<{ id: string; input_hash: string | null; profile_id: number | null; provenance_state: string | null; meta_rowid: number | null }>;
      for (const row of entityRows) {
        if (this.shuttingDown || !this.eligible) return;
        const currentHash = this.deps.buildEntityInputHash(row.id);
        if (currentHash === null) continue;                      // malformed entity: leave to explicit repair
        const isTarget = row.meta_rowid === null
          || (row.provenance_state !== null && (row.profile_id !== profileId || row.input_hash !== currentHash));
        if (!isTarget) continue;
        if (shouldSkip('entity', row.id, currentHash)) continue;
        const outcome = await recordResult('entity', row.id, currentHash,
          () => this.deps.reembedEntity(row.id));
        if (outcome === 'abort') { console.error('⚠️ backfill aborted: 3 consecutive distinct-target failures (systemic)'); return; }
        if (++processed % 8 === 0) await new Promise(r => setImmediate(r));
      }

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
    const chunkBy = db.prepare(
      `SELECT m.provenance_state s, COUNT(*) c FROM chunk_metadata m JOIN chunks v ON v.rowid = m.rowid
       GROUP BY m.provenance_state`).all() as Array<{ s: string | null; c: number }>;
    const entTotal = (db.prepare(`SELECT COUNT(*) c FROM entities`).get() as { c: number }).c;
    const entBy = db.prepare(
      `SELECT provenance_state s, COUNT(*) c FROM entity_embedding_metadata GROUP BY provenance_state`
    ).all() as Array<{ s: string | null; c: number }>;
    const pick = (rows: Array<{ s: string | null; c: number }>, s: string) =>
      rows.find(r => r.s === s)?.c ?? 0;
    // Searchable = verified + legacy_assumed. NULL rows (pre-reconciliation or
    // deferred in off mode) are NOT counted as embedded (6R note 4).
    const chunkVerified = pick(chunkBy, 'verified');
    const chunkLegacy = pick(chunkBy, 'legacy_assumed');
    const entVerified = pick(entBy, 'verified');
    const entLegacy = pick(entBy, 'legacy_assumed');
    this.snapshot = {
      chunk: { total: chunkTotal, embedded: chunkVerified + chunkLegacy, verified: chunkVerified, legacy_assumed: chunkLegacy },
      entity: { total: entTotal, embedded: entVerified + entLegacy, verified: entVerified, legacy_assumed: entLegacy },
    };
    return this.snapshot;
  }

  // spec §3 shutdown order: block new batches, let the current row transaction
  // finish, settle the loop, then the caller closes the DB.
  async shutdown(deadlineMs = 5000): Promise<void> {
    this.shuttingDown = true;
    if (this.kickTimer) { clearTimeout(this.kickTimer); this.kickTimer = null; }
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    const deadline = Date.now() + deadlineMs;
    while (this.scanning && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 20));
    }
  }
}
