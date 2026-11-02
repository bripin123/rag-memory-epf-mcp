// vec-slot-reuse D1b·D1c (specs/changes/vec-slot-reuse): verified idle rebuild of vec0 tables, its
// run conditions, fault rollback, lock behaviour, stats, and position errors surfacing as errors.
// Contract 5·6.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const { rebuildVecTable, slotSummary } = await import('../dist/src/vecSlots.js');

const { manager: mgr, dbPath, cleanup } = await makeManager();
process.on('uncaughtException', (e) => { try { cleanup(); } catch {} console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { try { cleanup(); } catch {} console.error(e); process.exit(1); });
installFakeEmbedder(mgr);
let db = mgr.db;
let failed = 0;
const check = (cond, msg) => { if (cond) console.log(`  OK: ${msg}`); else { failed++; console.log(`  FAIL: ${msg}`); } };

const vec = (seed) => { const v = new Float32Array(1024); for (let i = 0; i < 1024; i++) v[i] = Math.sin(seed * 0.7 + i); return Buffer.from(v.buffer); };
// Fingerprint of everything a rebuild must keep: every searchable rowid with its exact bytes.
const keepDigest = (table) => {
  const h = createHash('sha256');
  for (const r of db.prepare(`SELECT rowid FROM ${table}_rowids ORDER BY rowid`).all()) {
    const e = db.prepare(`SELECT embedding FROM ${table} WHERE rowid = ?`).get(BigInt(r.rowid));
    h.update(String(r.rowid)); h.update(Buffer.from(e.embedding));
  }
  return h.digest('hex');
};
const tableDigest = (sql) => createHash('sha256').update(JSON.stringify(db.prepare(sql).all())).digest('hex');

// ---- setup: real chunks + 9 chunks of vectors with 90% holes ---------------------------------------
await mgr.syncDocumentFromFile('/nonexistent.md', 'rb-doc', { content: 'rebuild test body. another sentence for the chunker.' });
const ins = db.prepare(`INSERT INTO chunks(rowid, embedding) VALUES (?, ?)`);
const del = db.prepare(`DELETE FROM chunks WHERE rowid = ?`);
db.transaction(() => { for (let i = 0; i < 10 * 1024; i++) ins.run(BigInt(500_000 + i), vec(i)); })();
db.transaction(() => { for (let i = 0; i < 10 * 1024; i++) if (i % 10 !== 0) del.run(BigInt(500_000 + i)); })();
const s0 = slotSummary(db, 'chunks');
check(s0.chunks >= 10 && s0.reclaimable >= 8 && s0.invalid === 0, `setup: holes made (${JSON.stringify({ c: s0.chunks, v: s0.valid, r: s0.reclaimable })})`);
const digest0 = keepDigest('chunks');
const metaDigest0 = tableDigest(`SELECT rowid, chunk_id, text, input_hash FROM chunk_metadata ORDER BY rowid`);
const ftsCount0 = db.prepare(`SELECT COUNT(*) c FROM chunks_fts`).get().c;

// ---- Contract 6: fault injection rolls back to the original state ----------------------------------
for (const fault of ['after-drop', 'after-create', 'after-partial', 'corrupt-one']) {
  const r = rebuildVecTable(db, 'chunks', { fault });
  const s = slotSummary(db, 'chunks');
  check(r.status === 'failed' && s.chunks === s0.chunks && s.valid === s0.valid && keepDigest('chunks') === digest0,
    `fault ${fault}: rolled back (status ${r.status}, chunks ${s.chunks}/${s0.chunks}, bytes ${keepDigest('chunks') === digest0 ? 'same' : 'DIFFERENT'})`);
}

// ---- Contract 6: another connection holding the write lock -> skip at once, no 5 s wait -----------
{
  const other = new Database(dbPath); sqliteVec.load(other);
  other.prepare('BEGIN IMMEDIATE').run();
  const t0 = Date.now();
  const r = rebuildVecTable(db, 'chunks');
  const waited = Date.now() - t0;
  other.prepare('ROLLBACK').run(); other.close();
  check(r.status === 'busy' && waited < 1000, `locked by another connection -> busy without waiting (${r.status}, ${waited} ms)`);
  check(Number(db.pragma('busy_timeout', { simple: true })) === 5000, 'busy_timeout restored to 5000 after the attempt');
}

// ---- run conditions of the idle scheduler ----------------------------------------------------------
{
  const far = Date.now() + 2 * 3600_000;
  mgr.inFlight = 1;
  check(mgr.maybeRebuildVectors(far) === null, 'no rebuild while a tool call is in flight');
  mgr.inFlight = 0;
  check(mgr.maybeRebuildVectors(Date.now()) === null, 'no rebuild inside the quiet window');
  db.pragma('cache_size = -2000');               // small cache -> the rebuild must raise it, then put it back
  const r = mgr.maybeRebuildVectors(far) ?? [];
  const c = r.find(x => x.table === 'chunks');
  check(c?.status === 'rebuilt' && c?.reason === 'reclaim', `idle check rebuilt chunks for reclaim (${c?.status} ${c?.reason} ${c?.error ?? ''})`);
  check(Number(db.pragma('cache_size', { simple: true })) === -2000, `cache_size restored after a rebuild (${db.pragma('cache_size', { simple: true })})`);
  db.pragma('cache_size = -32000');
  check(mgr.maybeRebuildVectors(far + 1000) === null, 'next check waits for the check interval');
}

// ---- Contract 6: result = minimal chunks, every rowid and byte kept, metadata and FTS untouched -----
{
  const s1 = slotSummary(db, 'chunks');
  check(s1.chunks === Math.ceil(s1.valid / s1.chunkSize) && s1.valid === s0.valid && s1.invalid === 0,
    `chunks ${s0.chunks} -> ${s1.chunks} for ${s1.valid} valid`);
  check(keepDigest('chunks') === digest0, 'every searchable rowid -> vector bytes identical');
  check(tableDigest(`SELECT rowid, chunk_id, text, input_hash FROM chunk_metadata ORDER BY rowid`) === metaDigest0, 'chunk_metadata unchanged');
  check(db.prepare(`SELECT COUNT(*) c FROM chunks_fts`).get().c === ftsCount0, 'FTS rows unchanged');
  const probe = db.prepare(`SELECT embedding FROM chunks WHERE rowid = ?`).get(BigInt(500_010)).embedding;
  check(Number(db.prepare(`SELECT rowid FROM chunks WHERE embedding MATCH ? AND k = 1`).get(probe).rowid) === 500_010, 'KNN finds a kept vector');
  // A fresh connection sees the rebuilt table.
  const fresh = new Database(dbPath, { readonly: true }); sqliteVec.load(fresh);
  check(fresh.prepare(`SELECT COUNT(*) c FROM chunks_chunks`).get().c === s1.chunks, 'a new connection sees the rebuilt table');
  fresh.close();
}

// ---- stats: vector_slots fields --------------------------------------------------------------------
{
  const st = await mgr.getKnowledgeGraphStats();
  const vs = st.server?.vector_slots;
  check(vs && vs.chunks && typeof vs.chunks.valid === 'number' && typeof vs.chunks.invalid === 'number'
    && typeof vs.chunks.reclaimable === 'number' && 'due' in vs.chunks && vs.chunks.last_attempt?.status === 'rebuilt',
    `stats vector_slots.chunks (${JSON.stringify(vs?.chunks && { v: vs.chunks.valid, i: vs.chunks.invalid, r: vs.chunks.reclaimable, due: vs.chunks.due, last: vs.chunks.last_attempt?.status })})`);
  check(vs?.policy?.maxLive > 0 && vs?.policy?.vacuum, 'stats vector_slots.policy present');
}

// ---- Contract 5: an unresolvable position is an error, not "missing" or "valid" ---------------------
{
  const row = db.prepare(`SELECT rowid FROM chunk_metadata WHERE document_id = 'rb-doc' LIMIT 1`).get();
  const p = db.prepare(`SELECT chunk_offset FROM chunks_rowids WHERE rowid = ?`).get(BigInt(row.rowid));
  const raw = new Database(dbPath);                     // no sqlite-vec: shadow tables writable
  raw.prepare(`UPDATE chunks_rowids SET chunk_offset = 999999 WHERE rowid = ?`).run(row.rowid);
  raw.close();
  mgr.coordinator.invalidateCoverage();
  const st = await mgr.getKnowledgeGraphStats();
  const cc = st.server?.coverage?.chunk;
  check(cc && cc.error && cc.missing === null && cc.embedded === null, `coverage reports the position error (${JSON.stringify(cc)})`);
  check(st.server?.vector_slots?.chunks?.error && st.server.vector_slots.chunks.due === 'position-error', 'vector_slots reports the position error');
  const r = rebuildVecTable(db, 'chunks', { force: true });
  check(r.status === 'position-error', `rebuild refuses an unresolvable slot map (${r.status})`);
  const ec = st.server?.coverage?.entity;
  check(ec && !ec.error && typeof ec.missing === 'number', 'the entity table is still reported normally');
  const raw2 = new Database(dbPath);
  raw2.prepare(`UPDATE chunks_rowids SET chunk_offset = ? WHERE rowid = ?`).run(p.chunk_offset, row.rowid);
  // second shape: the rowid points at a chunk that no longer exists (an INNER JOIN would hide it)
  const pc = raw2.prepare(`SELECT chunk_id FROM chunks_rowids WHERE rowid = ?`).get(row.rowid);
  raw2.prepare(`UPDATE chunks_rowids SET chunk_id = 99999 WHERE rowid = ?`).run(row.rowid);
  raw2.close();
  mgr.coordinator.invalidateCoverage();
  const st2 = await mgr.getKnowledgeGraphStats();
  check(st2.server?.coverage?.chunk?.error && st2.server.coverage.chunk.missing === null,
    `coverage reports a missing chunk as an error (${JSON.stringify(st2.server?.coverage?.chunk)})`);
  const raw3 = new Database(dbPath);
  raw3.prepare(`UPDATE chunks_rowids SET chunk_id = ? WHERE rowid = ?`).run(pc.chunk_id, row.rowid);
  raw3.close();
}

if (failed) { cleanup(); console.log(`vec-rebuild: ${failed} FAILED`); process.exit(1); }
cleanup();
console.log('vec-rebuild: all OK');
