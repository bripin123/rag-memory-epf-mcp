// vec-slot-reuse r3 counterexamples (2_ review, 2026-11-02): validity-0 rows through sanitize, reconciliation,
// restart, coverage caching, scheduler busy/retry, exact rowids and strict slot positions.
import { createRequire } from 'node:module';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const { bitIsSet, rebuildVecTable, VecSlotError } = await import('../dist/src/vecSlots.js');

// makeManager() must run before anything imports dist/index.js: the engine reads DB_FILE_PATH once at
// module load, and an earlier import falls back to the default DB next to the module (dist/rag-memory.db).
const { manager: first, dbPath, cleanup } = await makeManager();
const mod = await import('../dist/index.js');
let mgr = first;
let failed = 0;
const check = (cond, msg) => { if (cond) console.log(`  OK: ${msg}`); else { failed++; console.log(`  FAIL: ${msg}`); } };
const throwsSlot = (f) => { try { f(); return false; } catch (e) { return e instanceof VecSlotError; } };
const metaRowid = (eid) => mgr.db.prepare(`SELECT rowid FROM entity_embedding_metadata WHERE entity_id = ?`).get(eid)?.rowid;
const selfHit = (table, rowid) => {
  const e = mgr.db.prepare(`SELECT embedding FROM ${table} WHERE rowid = ?`).get(BigInt(rowid));
  if (!e) return false;
  const hit = mgr.db.prepare(`SELECT rowid FROM ${table} WHERE embedding MATCH ? AND k = 1`).get(e.embedding);
  return !!hit && Number(hit.rowid) === Number(rowid);
};
const clearValidity = (table, rowid) => {
  const p = mgr.db.prepare(`SELECT chunk_id, chunk_offset FROM ${table}_rowids WHERE rowid = ?`).get(BigInt(rowid));
  const raw = new Database(dbPath);
  try {
    const c = raw.prepare(`SELECT validity FROM ${table}_chunks WHERE chunk_id = ?`).get(p.chunk_id);
    const b = Buffer.from(c.validity); b[p.chunk_offset >> 3] &= ~(1 << (p.chunk_offset & 7));
    raw.prepare(`UPDATE ${table}_chunks SET validity = ? WHERE chunk_id = ?`).run(b, p.chunk_id);
  } finally { raw.close(); }
};
const far = () => Date.now() + 2 * 3600_000;

try {
  // ---- M6: strict positions ------------------------------------------------------------------------
  check(throwsSlot(() => bitIsSet(Buffer.from([1]), 0, 0.5)), 'size 0.5 is a position error');
  check(throwsSlot(() => bitIsSet(Buffer.from([1]), 0, NaN)), 'size NaN is a position error');
  check(throwsSlot(() => bitIsSet(Buffer.from([1]), 4294967296, 4294967297)), 'offset 2^32 is a position error (no 32-bit wrap)');
  check(throwsSlot(() => bitIsSet(Buffer.from([1]), 0, 16)), 'size larger than the bitmap is a position error');
  check(bitIsSet(Buffer.from([1]), 0, 8) === true && bitIsSet(Buffer.from([1]), 1, 8) === false, 'normal positions still read');

  // ---- M1: a rowid above 2^53 survives a rebuild exactly ---------------------------------------------
  {
    const t = new Database(':memory:'); sqliteVec.load(t);
    t.exec('CREATE VIRTUAL TABLE chunks USING vec0(embedding FLOAT[4])');
    const big = 9007199254740993n;
    t.prepare('INSERT INTO chunks(rowid, embedding) VALUES (?, ?)').run(big, Buffer.from(new Float32Array([1, 2, 3, 4]).buffer));
    t.prepare('INSERT INTO chunks(rowid, embedding) VALUES (?, ?)').run(5n, Buffer.from(new Float32Array([4, 3, 2, 1]).buffer));
    const r = rebuildVecTable(t, 'chunks', { force: true, dims: 4 });
    const ids = t.prepare('SELECT rowid FROM chunks_rowids ORDER BY rowid').safeIntegers(true).all().map(x => x.rowid);
    check(r.status === 'rebuilt' && ids.length === 2 && ids[0] === 5n && ids[1] === big, `rowid 2^53+1 kept exactly (${r.status} ${ids.join(',')})`);
    t.close();
  }

  // ---- r4 M3 / A1 on a two-row table: the exact shapes, without other rows in the chunk -----------------
  {
    const { deleteVector, slotSummary, registerVecSlotFunctions } = await import('../dist/src/vecSlots.js');
    const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vecslot-two-'));
    try {
      const make = (name, n) => {
        const file = path.join(dir, name);
        let t = new Database(file); sqliteVec.load(t);
        t.exec('CREATE VIRTUAL TABLE entity_embeddings USING vec0(embedding FLOAT[4])');
        for (let i = 1; i <= n; i++) t.prepare('INSERT INTO entity_embeddings(rowid, embedding) VALUES (?, ?)').run(BigInt(i), Buffer.from(new Float32Array([i, 1, 2, 3]).buffer));
        t.close();
        const raw = new Database(file);                       // row 1 -> validity 0 (no sqlite-vec on this connection)
        const c = raw.prepare('SELECT validity FROM entity_embeddings_chunks WHERE chunk_id = 1').get();
        const b = Buffer.from(c.validity); b[0] &= ~1; raw.prepare('UPDATE entity_embeddings_chunks SET validity = ? WHERE chunk_id = 1').run(b);
        raw.close();
        t = new Database(file); sqliteVec.load(t); registerVecSlotFunctions(t);
        return t;
      };
      const t = make('m3.db', 2);                             // row 2 = the last valid row of the chunk
      deleteVector(t, 'entity_embeddings', 2);
      let sum = null, e = null; try { sum = slotSummary(t, 'entity_embeddings', 4); } catch (x) { e = x; }
      check(!e && sum.invalid === 0 && t.prepare('SELECT COUNT(*) c FROM entity_embeddings_rowids').get().c === 0,
        `deleting the last valid row of a chunk with a validity-0 row leaves no orphan position (${e?.message ?? JSON.stringify(sum && { i: sum.invalid })})`);
      t.close();
      const u = make('a1.db', 2);                             // shared slot by an insert, repaired by the idle rebuild
      u.prepare('INSERT INTO entity_embeddings(rowid, embedding) VALUES (?, ?)').run(3n, Buffer.from(new Float32Array([9, 9, 9, 9]).buffer));
      const shared = slotSummary(u, 'entity_embeddings', 4).aliased;
      const r = rebuildVecTable(u, 'entity_embeddings', { dims: 4 });
      const left = u.prepare('SELECT rowid FROM entity_embeddings_rowids ORDER BY rowid').all().map(x => Number(x.rowid));
      check(shared === 2 && r.status === 'rebuilt' && r.reason === 'repair' && left.join(',') === '2',
        `idle repair drops both rowids of a shared slot (shared ${shared}, ${r.status}/${r.reason}, left ${left.join(',')})`);
      u.close();
      // r5 M1: a broken position shared by two rows is a position error, never a repairable shared slot
      for (const [label, sql] of [['offset NULL', 'UPDATE entity_embeddings_rowids SET chunk_offset = NULL'],
                                  ['size 0.5', 'UPDATE entity_embeddings_chunks SET size = 0.5']]) {
        const w = make(`m1-${label.replace(/\W/g, '')}.db`, 2);
        w.close();
        const file = path.join(dir, `m1-${label.replace(/\W/g, '')}.db`);
        const raw = new Database(file);
        raw.prepare('UPDATE entity_embeddings_rowids SET chunk_offset = 0').run();          // both rows -> one slot
        raw.prepare(sql).run();
        raw.close();
        const x = new Database(file); sqliteVec.load(x); registerVecSlotFunctions(x);
        let se = null; try { slotSummary(x, 'entity_embeddings', 4); } catch (e) { se = e; }
        const rr = rebuildVecTable(x, 'entity_embeddings', { dims: 4 });
        const n = x.prepare('SELECT COUNT(*) c FROM entity_embeddings_rowids').get().c;
        check(se instanceof VecSlotError && rr.status === 'position-error' && n === 2,
          `shared + ${label}: position error, rebuild refuses, rows kept (${se?.name ?? 'no error'}, ${rr.status}, rows ${n})`);
        x.close();
      }
      // r5 M2: an inline repair inside a write respects the live-vector cap
      {
        const file = path.join(dir, 'cap.db');
        let t2 = new Database(file); sqliteVec.load(t2);
        t2.exec('CREATE VIRTUAL TABLE entity_embeddings USING vec0(embedding FLOAT[4])');
        const ins2 = t2.prepare('INSERT INTO entity_embeddings(rowid, embedding) VALUES (?, ?)');
        t2.transaction(() => { for (let i = 1; i <= 20_002; i++) ins2.run(BigInt(i), Buffer.from(new Float32Array([i, 1, 2, 3]).buffer)); })();
        t2.close();
        const raw = new Database(file);
        const c = raw.prepare('SELECT validity FROM entity_embeddings_chunks WHERE chunk_id = 1').get();
        const bb = Buffer.from(c.validity); bb[0] &= ~1; raw.prepare('UPDATE entity_embeddings_chunks SET validity = ? WHERE chunk_id = 1').run(bb);
        raw.close();
        t2 = new Database(file); sqliteVec.load(t2); registerVecSlotFunctions(t2);
        const { writeVector } = await import('../dist/src/vecSlots.js');
        let we = null; try { writeVector(t2, 'entity_embeddings', 1, Buffer.from(new Float32Array([7, 7, 7, 7]).buffer)); } catch (e) { we = e; }
        const sum2 = slotSummary(t2, 'entity_embeddings', 4);
        check(we instanceof VecSlotError && /over-cap/.test(we.message) && sum2.invalid === 1 && sum2.valid === 20_001,
          `write above the cap refuses the inline rebuild (${we?.message?.slice(0, 80) ?? 'no error'}; valid ${sum2.valid}, invalid ${sum2.invalid})`);
        t2.close();
      }
      // should 2: an inline repair inside an outer transaction rolls back with it
      {
        const y = make('nested.db', 3);
        y.exec('CREATE TABLE marker (x INTEGER)');
        const { writeVector } = await import('../dist/src/vecSlots.js');
        const before = slotSummary(y, 'entity_embeddings', 4);
        try {
          y.transaction(() => {
            y.prepare('INSERT INTO marker VALUES (1)').run();
            writeVector(y, 'entity_embeddings', 1, Buffer.from(new Float32Array([5, 5, 5, 5]).buffer));   // repairs inline
            throw new Error('caller fails after the repair');
          })();
        } catch { /* expected */ }
        const after = slotSummary(y, 'entity_embeddings', 4);
        check(before.invalid === 1 && after.invalid === 1 && after.valid === before.valid
          && y.prepare('SELECT COUNT(*) c FROM marker').get().c === 0, 'outer rollback undoes the inline repair too');
        y.close();
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  installFakeEmbedder(mgr);
  mgr.embeddingsMode = 'lazy';
  await mgr.createEntities([
    { name: 'Guard', entityType: 'CONCEPT', observations: ['guard obs'] },
    { name: 'Target', entityType: 'CONCEPT', observations: ['target obs'] },
  ]);
  const targetRowid = metaRowid('entity_target');
  await mgr.startReconciliation();

  // ---- M3: coverage cache follows what the scan saw (no manual invalidate) ---------------------------
  {
    const c0 = mgr.coordinator.coverage();                       // cached: 2 embedded
    clearValidity('entity_embeddings', targetRowid);             // Target = the highest set bit of its byte
    await mgr.coordinator.scanAndBackfill();
    const c1 = mgr.coordinator.coverage();
    check(c0.entity.embedded === 2 && c1.entity.embedded === 1, `coverage refreshed by the scan (${c0.entity.embedded} -> ${c1.entity.embedded})`);
    check(mgr.coordinator.repairRequested === true, 'scan requested a repair');
  }

  // ---- M2 A/B: sanitize and reconciliation leave a validity-0 row alone (no vec0 DELETE error) -------
  {
    mgr.db.prepare(`UPDATE entity_embedding_metadata SET profile_id = NULL WHERE rowid = ?`).run(targetRowid);   // A: stale profile
    mgr.coordinator.reconPromise = null; mgr.coordinator.recon = 'pending';
    let err = null;
    try { await mgr.startReconciliation(); } catch (e) { err = e; }
    check(!err && ['n/a', 'complete'].includes(mgr.coordinator.reconState), `stale-profile sanitize passes a validity-0 row (${mgr.coordinator.reconState} ${err?.message ?? mgr.coordinator.reconLastError ?? ''})`);
    check(metaRowid('entity_target') === targetRowid, 'its metadata row (rowid) is kept');
    mgr.db.prepare(`UPDATE entity_embedding_metadata SET provenance_state = NULL, embedding_text = 'changed' WHERE rowid = ?`).run(targetRowid);  // B: legacy NULL row
    mgr.coordinator.reconPromise = null; mgr.coordinator.recon = 'pending';
    err = null;
    try { await mgr.startReconciliation(); } catch (e) { err = e; }
    check(!err && mgr.coordinator.reconState !== 'failed', `legacy reconciliation passes a validity-0 row (${mgr.coordinator.reconState} ${mgr.coordinator.reconLastError ?? ''})`);
  }

  // ---- M5: a busy repair attempt is not retried on the next tick --------------------------------------
  {
    const other = new Database(dbPath); sqliteVec.load(other);
    other.prepare('BEGIN IMMEDIATE').run();
    const t = far();
    const r1 = mgr.maybeRebuildVectors(t);
    const r2 = mgr.maybeRebuildVectors(t + 1000);
    other.prepare('ROLLBACK').run(); other.close();
    check(Array.isArray(r1) && r1.every(x => x.status === 'busy'), `first repair attempt ran and met the lock (${r1?.map(x => x.status)})`);
    check(r2 === null, 'not retried one tick later');
    check(mgr.coordinator.repairRequested === true, 'repair still wanted');
  }

  // ---- M2 C: Target's validity-0 row was repaired inline by the sanitize step above; its stamped metadata
  //      survives a restart and the backfill re-inserts at the same rowid ------------------------------------
  {
    mgr.db.prepare(`UPDATE entity_embedding_metadata SET provenance_state = 'verified', profile_id = ? WHERE rowid = ?`)
      .run(mgr.currentProfileId, targetRowid);
    await mgr.createEntities([{ name: 'Tail', entityType: 'CONCEPT', observations: ['tail obs'] }]);
    check(metaRowid('entity_tail') > targetRowid, `setup: a later rowid exists (${metaRowid('entity_tail')} > ${targetRowid})`);
    const present = (rowid) => mgr.db.prepare(`SELECT COUNT(*) c FROM entity_embeddings_rowids WHERE rowid = ?`).get(BigInt(rowid)).c;
    check(present(targetRowid) === 0, 'setup: Target has stamped metadata and no vector row (repaired inline)');
    mgr.cleanup();
    mgr = new mod.RAGKnowledgeGraphManager();
    await mgr.initialize({ skipModel: true });
    installFakeEmbedder(mgr);
    mgr.embeddingsMode = 'lazy';
    await mgr.startReconciliation();
    await mgr.coordinator.scanAndBackfill();
    const rid = metaRowid('entity_target');
    check(rid === targetRowid && selfHit('entity_embeddings', rid), `after restart Target is searchable at its own rowid (${targetRowid} -> ${rid})`);
  }
  // ---- M4: reconciliation (sanitize batches included) counts as busy ----------------------------------
  {
    const ins = mgr.db.prepare(`INSERT INTO entity_embeddings(rowid, embedding) VALUES (?, ?)`);
    mgr.db.transaction(() => { for (let i = 0; i < 200; i++) ins.run(BigInt(800_000 + i), Buffer.from(new Float32Array(1024).fill(0.1 + i).buffer)); })();
    mgr.coordinator.reconPromise = null; mgr.coordinator.recon = 'pending';
    const p = mgr.coordinator.runReconciliation();
    await new Promise(r => setImmediate(r));                     // inside sanitize, between batches
    const busyNow = mgr.coordinator.busy;
    const left = mgr.db.prepare(`SELECT COUNT(*) c FROM entity_embeddings_rowids WHERE rowid >= 800000`).get().c;
    const rb = mgr.maybeRebuildVectors(far() * 2);
    check(left > 0 && busyNow === true && rb === null, `no rebuild while sanitize is between batches (orphans left ${left}, busy ${busyNow}, rebuild ${rb === null ? 'held' : rb.map(x => x.status)})`);
    await p;
    check(mgr.coordinator.busy === false, 'not busy after the pass');
  }

  // ---- r4 M1: a validity-0 slot handed to a new insert (shared slot) is owned by neither row --------------
  {
    const { slotSummary } = await import('../dist/src/vecSlots.js');
    await mgr.createEntities([{ name: 'S Guard', entityType: 'CONCEPT', observations: ['sg'] }, { name: 'S Target', entityType: 'CONCEPT', observations: ['st'] }]);
    const st = metaRowid('entity_s_target');
    clearValidity('entity_embeddings', st);
    await mgr.createEntities([{ name: 'S Tail', entityType: 'CONCEPT', observations: ['stail'] }]);
    const tl = metaRowid('entity_s_tail');
    const sum = slotSummary(mgr.db, 'entity_embeddings');
    check(sum.aliased === 2, `shared slot made by the insert (aliased ${sum.aliased})`);
    mgr.coordinator.invalidateCoverage();
    const cov = mgr.coordinator.coverage();
    check(cov.entity.embedded === cov.entity.total - 2, `coverage counts neither shared row (embedded ${cov.entity.embedded}/${cov.entity.total})`);
    const tailBytes = Buffer.from(mgr.db.prepare(`SELECT embedding FROM entity_embeddings WHERE rowid = ?`).get(BigInt(tl)).embedding);
    const ok = await mgr.embedEntity('entity_s_target', 'bulk');             // write meets a shared slot -> inline repair
    const sum2 = slotSummary(mgr.db, 'entity_embeddings');
    check(ok === true && sum2.aliased === 0 && sum2.invalid === 0, `re-embed repaired the table first (aliased ${sum2.aliased}, invalid ${sum2.invalid})`);
    const tailNow = mgr.db.prepare(`SELECT embedding FROM entity_embeddings WHERE rowid = ?`).get(BigInt(tl));
    check(!tailNow || !Buffer.from(tailNow.embedding).equals(Buffer.from(mgr.db.prepare(`SELECT embedding FROM entity_embeddings WHERE rowid = ?`).get(BigInt(st)).embedding)),
      'Target write did not overwrite Tail\'s vector');
    await mgr.coordinator.scanAndBackfill();
    check(selfHit('entity_embeddings', st) && selfHit('entity_embeddings', tl) && metaRowid('entity_s_tail') === tl,
      `both re-embedded at their own rowids (${st}, ${tl})`);
    void tailBytes;
  }

  // ---- r4 M3: deleting a valid row next to a validity-0 row never leaves a rowid without its chunk ------
  {
    const { slotSummary } = await import('../dist/src/vecSlots.js');
    await mgr.createEntities([{ name: 'D Target', entityType: 'CONCEPT', observations: ['dt'] }, { name: 'D Guard', entityType: 'CONCEPT', observations: ['dg'] }]);
    clearValidity('entity_embeddings', metaRowid('entity_d_target'));
    let err = null;
    try { await mgr.deleteEntities(['D Guard']); await mgr.deleteEntities(['D Target']); } catch (e) { err = e; }
    let sumErr = null; let sum = null;
    try { sum = slotSummary(mgr.db, 'entity_embeddings'); } catch (e) { sumErr = e; }
    check(!err && !sumErr && sum.invalid === 0 && sum.aliased === 0, `deletes next to a validity-0 row leave a consistent table (${err?.message ?? sumErr?.message ?? JSON.stringify({ i: sum.invalid, a: sum.aliased })})`);
  }

  // ---- r4 M2: a new entity after a repair does not take a kept metadata rowid ---------------------------
  {
    await mgr.createEntities([{ name: 'N Target', entityType: 'CONCEPT', observations: ['nt'] }]);
    const nt = metaRowid('entity_n_target');
    clearValidity('entity_embeddings', nt);
    mgr.maybeRebuildVectors(Date.now() + 10 * 3600_000);                    // idle repair: vector dropped, metadata kept
    const kept = mgr.db.prepare(`SELECT COUNT(*) c FROM entity_embeddings_rowids WHERE rowid = ?`).get(BigInt(nt)).c;
    let err = null; let res = null;
    try { res = await mgr.createEntities([{ name: 'Newbie', entityType: 'CONCEPT', observations: ['nb'] }]); } catch (e) { err = e; }
    const nb = metaRowid('entity_newbie');
    check(kept === 0 && !err && res?.[0]?.embedding_status !== 'queued' && nb && nb !== nt && selfHit('entity_embeddings', nb),
      `new entity got its own rowid (kept vector rows ${kept}, newbie ${nb}, target ${nt}, status ${res?.[0]?.embedding_status} ${err?.message ?? ''})`);
    await mgr.coordinator.scanAndBackfill();
    check(metaRowid('entity_n_target') === nt && selfHit('entity_embeddings', nt), 'the repaired entity is back at its own rowid');
  }
} finally {
  try { mgr.cleanup(); } catch {}
  cleanup();
}
if (failed) { console.log(`vec-slot-invalid: ${failed} FAILED`); process.exit(1); }
console.log('vec-slot-invalid: all OK');
