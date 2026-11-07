// vec-slot-reuse (specs/changes/vec-slot-reuse): same-rowid re-embeds must rewrite the vector in
// place (no new vec0 slot), a validity-0 row must count as missing and be re-embedded back to a
// searchable state. Contract 1·2·3·4.
//
// Why fillers: sqlite-vec puts a new row only into a free slot of the LATEST 1,024-slot chunk, so a
// DELETE + INSERT inside the latest chunk lands back in the same slot and hides the leak. The rows
// under test are pushed into an older chunk by inserting > 1,024 filler vectors after them.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const { manager: mgr, dbPath, cleanup } = await makeManager();
process.on('uncaughtException', (e) => { try { cleanup(); } catch {} console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { try { cleanup(); } catch {} console.error(e); process.exit(1); });
installFakeEmbedder(mgr);
// A real engine reconciles the empty DB at boot (single-flight: later calls return n/a). Do that first so the
// metadata-less filler vectors stay a test device: reconciled later, the orphan-vector sanitation (IN-42) would
// delete them and the chunk-side repair rebuild under test (Contract 4) would never be reached.
{ const mode = mgr.embeddingsMode; mgr.embeddingsMode = 'lazy'; await mgr.startReconciliation(); mgr.embeddingsMode = mode; }
const db = mgr.db;
let failed = 0;
const check = (cond, msg) => { if (cond) console.log(`  OK: ${msg}`); else { failed++; console.log(`  FAIL: ${msg}`); } };

const vec = (seed) => { const v = new Float32Array(1024); for (let i = 0; i < 1024; i++) v[i] = Math.sin(seed * 0.7 + i); return Buffer.from(v.buffer); };
const fill = (table, from, n) => {
  const ins = db.prepare(`INSERT INTO ${table}(rowid, embedding) VALUES (?, ?)`);
  db.transaction(() => { for (let i = 0; i < n; i++) ins.run(BigInt(from + i), vec(from + i)); })();
};
const pos = (table, rowid) => db.prepare(`SELECT chunk_id, chunk_offset FROM ${table}_rowids WHERE rowid = ?`).get(BigInt(rowid)) ?? null;
// Holes = unset validity bits in every chunk except the latest one (the latest one still takes inserts).
const holes = (table) => {
  const rows = db.prepare(`SELECT chunk_id, size, validity FROM ${table}_chunks ORDER BY chunk_id`).all();
  let n = 0;
  for (const r of rows.slice(0, -1)) for (let i = 0; i < r.size; i++) if (!((r.validity[i >> 3] >> (i & 7)) & 1)) n++;
  return n;
};
const selfHit = (table, rowid) => {
  const e = db.prepare(`SELECT embedding FROM ${table} WHERE rowid = ?`).get(BigInt(rowid));
  if (!e) return false;
  const hit = db.prepare(`SELECT rowid FROM ${table} WHERE embedding MATCH ? AND k = 1`).get(e.embedding);
  return !!hit && Number(hit.rowid) === Number(rowid);
};
// Clear one validity bit through a connection that has NOT loaded sqlite-vec (the engine connection
// refuses writes to vec0 shadow tables). Same shape as the 5 hub rows found 2026-11-02.
const clearValidity = (table, rowid) => {
  const p = pos(table, rowid);
  const raw = new Database(dbPath);
  try {
    const c = raw.prepare(`SELECT validity FROM ${table}_chunks WHERE chunk_id = ?`).get(p.chunk_id);
    const b = Buffer.from(c.validity);
    b[p.chunk_offset >> 3] &= ~(1 << (p.chunk_offset & 7));
    raw.prepare(`UPDATE ${table}_chunks SET validity = ? WHERE chunk_id = ?`).run(b, p.chunk_id);
  } finally { raw.close(); }
};

// ---- setup: one document (chunk vectors) and one entity (entity vector) ---------------------------
await mgr.syncDocumentFromFile('/nonexistent.md', 'slot-doc', { content: 'slot reuse body text one. second sentence here for a chunk.' });
await mgr.createEntities([{ name: 'Slot Entity', entityType: 'CONCEPT', observations: ['slot observation'] }]);
const chunkRow = db.prepare(`SELECT rowid FROM chunk_metadata WHERE document_id = 'slot-doc' ORDER BY rowid LIMIT 1`).get();
const entMeta = db.prepare(`SELECT rowid FROM entity_embedding_metadata WHERE entity_id = 'entity_slot_entity'`).get();
assert.ok(chunkRow && pos('chunks', chunkRow.rowid), 'setup: document chunk has no vector');
assert.ok(entMeta && pos('entity_embeddings', entMeta.rowid), 'setup: entity has no vector');
fill('chunks', 1_000_000, 1100);
// Entity fillers must be real entities: reconciliation deletes entity vectors without metadata, and
// a chunk left holding only a validity-0 row is dropped by vec0 while its _rowids entry stays behind.
await mgr.createEntities(Array.from({ length: 1100 }, (_, i) => ({ name: `Filler ${i}`, entityType: 'CONCEPT', observations: [`filler ${i}`] })));

// ---- Contract 1: valid-row re-embed rewrites in place --------------------------------------------
{
  const before = pos('chunks', chunkRow.rowid), h0 = holes('chunks');
  const ok = await mgr.reembedChunkByRowid(chunkRow.rowid);
  check(ok === true, 'chunk re-embed reported written');
  const after = pos('chunks', chunkRow.rowid);
  check(after && after.chunk_id === before.chunk_id && after.chunk_offset === before.chunk_offset,
    `chunk re-embed kept its slot (before ${JSON.stringify(before)} after ${JSON.stringify(after)})`);
  check(holes('chunks') === h0, `chunk re-embed left no hole in an older chunk (${h0} -> ${holes('chunks')})`);
  check(selfHit('chunks', chunkRow.rowid), 'chunk still self-hits after re-embed');
}
{
  const before = pos('entity_embeddings', entMeta.rowid), h0 = holes('entity_embeddings');
  const ok = await mgr.embedEntity('entity_slot_entity', 'bulk');
  check(ok === true, 'entity re-embed reported written');
  const meta = db.prepare(`SELECT rowid FROM entity_embedding_metadata WHERE entity_id = 'entity_slot_entity'`).get();
  check(meta && Number(meta.rowid) === Number(entMeta.rowid), `entity re-embed kept metadata rowid (${entMeta.rowid} -> ${meta?.rowid})`);
  const after = meta ? pos('entity_embeddings', meta.rowid) : null;
  check(after && after.chunk_id === before.chunk_id && after.chunk_offset === before.chunk_offset,
    `entity re-embed kept its slot (before ${JSON.stringify(before)} after ${JSON.stringify(after)})`);
  check(holes('entity_embeddings') === h0, `entity re-embed left no hole in an older chunk (${h0} -> ${holes('entity_embeddings')})`);
  check(meta && selfHit('entity_embeddings', meta.rowid), 'entity still self-hits after re-embed');
}

// ---- Contract 1 (other write sites): bulk embedChunks and KG write-back keep the slot ---------------
{
  const before = pos('chunks', chunkRow.rowid), h0 = holes('chunks');
  const res = await mgr.embedChunks('slot-doc');
  const after = pos('chunks', chunkRow.rowid);
  check(res.embeddedChunks >= 1 && after && after.chunk_id === before.chunk_id && after.chunk_offset === before.chunk_offset && holes('chunks') === h0,
    `embedChunks rewrote in place (before ${JSON.stringify(before)} after ${JSON.stringify(after)}, holes ${h0} -> ${holes('chunks')})`);
  await mgr.generateKnowledgeGraphChunks();
  await mgr.embedKnowledgeGraphChunks();
  const kg = db.prepare(`SELECT rowid FROM chunk_metadata WHERE chunk_type = 'entity' ORDER BY rowid LIMIT 1`).get();
  fill('chunks', 2_000_000, 1100);                                          // push the KG chunk into an older chunk
  const kb = pos('chunks', kg.rowid), kh = holes('chunks');
  const ok = await mgr.reembedChunkByRowid(kg.rowid);                       // KG branch -> writeKgVectorIfCurrent
  const ka = pos('chunks', kg.rowid);
  check(ok === true && ka && ka.chunk_id === kb.chunk_id && ka.chunk_offset === kb.chunk_offset && holes('chunks') === kh,
    `KG write-back rewrote in place (before ${JSON.stringify(kb)} after ${JSON.stringify(ka)})`);
}

// ---- Contract 4: a validity-0 row is missing, and backfill makes it searchable again ---------------
{
  clearValidity('chunks', chunkRow.rowid);
  const entNow = db.prepare(`SELECT rowid FROM entity_embedding_metadata WHERE entity_id = 'entity_slot_entity'`).get();
  clearValidity('entity_embeddings', entNow.rowid);
  check(!selfHit('chunks', chunkRow.rowid) && !selfHit('entity_embeddings', entNow.rowid), 'setup: validity-0 rows are invisible to KNN');
  mgr.coordinator.invalidateCoverage();
  const cov = mgr.coordinator.coverage();
  const chunkTotal = db.prepare(`SELECT COUNT(*) c FROM chunk_metadata`).get().c;
  check(cov.chunk.embedded === chunkTotal - 1, `coverage counts the validity-0 chunk as missing (embedded ${cov.chunk.embedded} of ${chunkTotal})`);
  check(cov.entity.embedded === cov.entity.total - 1, `coverage counts the validity-0 entity as missing (embedded ${cov.entity.embedded} of ${cov.entity.total})`);

  // The real path: reconciliation settles, then the backfill scan picks up missing rows.
  mgr.embeddingsMode = 'lazy';
  await mgr.startReconciliation();
  check(mgr.coordinator.eligible === true, `backfill eligible after reconciliation (recon ${mgr.coordinator.reconState})`);
  await mgr.coordinator.scanAndBackfill();
  // sqlite-vec refuses to DELETE many validity-0 rows, so the backfill must not try: it skips them and
  // asks for the verified rebuild (repair), which drops them; the next pass re-embeds at the same rowid.
  check(!selfHit('chunks', chunkRow.rowid), 'backfill alone does not touch the validity-0 rows');
  check(db.prepare(`SELECT COUNT(*) c FROM embedding_backfill_failures`).get().c === 0,
    'backfill did not attempt (and fail) the validity-0 rows');
  check(mgr.coordinator.repairRequested === true, 'backfill requested a repair rebuild');
  const later = Date.now() + 2 * 3600_000;                                   // past the quiet window
  const results = mgr.maybeRebuildVectors(later) ?? [];
  const byTable = Object.fromEntries(results.map(r => [r.table, r]));
  check(byTable.chunks?.status === 'rebuilt' && byTable.chunks?.reason === 'repair' && byTable.chunks?.before?.invalid === 1,
    `chunks repair rebuild (${JSON.stringify({ s: byTable.chunks?.status, r: byTable.chunks?.reason, inv: byTable.chunks?.before?.invalid, e: byTable.chunks?.error })})`);
  check(byTable.entity_embeddings?.status === 'rebuilt' && byTable.entity_embeddings?.before?.invalid === 1,
    `entity repair rebuild (${JSON.stringify({ s: byTable.entity_embeddings?.status, r: byTable.entity_embeddings?.reason, e: byTable.entity_embeddings?.error })})`);
  check(mgr.coordinator.repairRequested === false, 'repair request cleared after a successful rebuild');
  await mgr.coordinator.scanAndBackfill();
  // Contract 2: searchable again, no validity-0 row left behind, rowids kept
  const ent = db.prepare(`SELECT rowid FROM entity_embedding_metadata WHERE entity_id = 'entity_slot_entity'`).get();
  check(ent && Number(ent.rowid) === Number(entNow.rowid), `entity repaired at its own rowid (${entNow.rowid} -> ${ent?.rowid})`);
  check(db.prepare(`SELECT COUNT(*) c FROM chunks_rowids WHERE rowid = ?`).get(chunkRow.rowid).c === 1, 'chunk repaired at its own rowid');
  check(selfHit('chunks', chunkRow.rowid), 'backfill made the validity-0 chunk searchable again');
  check(ent && selfHit('entity_embeddings', ent.rowid), 'backfill made the validity-0 entity searchable again');
  mgr.coordinator.invalidateCoverage();
  const cov2 = mgr.coordinator.coverage();
  check(cov2.chunk.embedded === chunkTotal && cov2.entity.embedded === cov2.entity.total, 'coverage back to fully embedded');
  check(db.prepare(`SELECT chunk_metadata.text IS NOT NULL ok FROM chunk_metadata WHERE rowid = ?`).get(chunkRow.rowid)?.ok === 1,
    'chunk_metadata text kept through the repair');
}

if (failed) { cleanup(); console.log(`vec-slot-reuse: ${failed} FAILED`); process.exit(1); }
cleanup();
console.log('vec-slot-reuse: all OK');
