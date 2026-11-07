// chunk-orphan-vectors (IN-42 request 1): searchable chunk vectors with no chunk_metadata row are
// cleaned by the reconciliation sanitation (same path as entity orphans: deleteVector, batched), the
// stats expose the count separately (coverage.chunk.missing keeps its meaning), off mode only
// classifies (no writes), and normal chunk vectors are kept.
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';

const { manager: mgr, cleanup } = await makeManager();
let failed = 0;
const check = (cond, msg) => { if (cond) console.log(`  OK: ${msg}`); else { failed++; console.log(`  FAIL: ${msg}`); } };
const vec = (seed) => { const v = new Float32Array(1024); for (let i = 0; i < 1024; i++) v[i] = Math.sin(seed + i); return Buffer.from(v.buffer); };
const count = (sql, ...a) => mgr.db.prepare(sql).get(...a).c;

try {
  installFakeEmbedder(mgr);
  mgr.embeddingsMode = 'lazy';
  await mgr.storeDocument('doc-a', 'Alpha paragraph about apples.\n\nBeta paragraph about bananas.');
  await mgr.chunkDocument('doc-a');
  await mgr.embedChunks('doc-a');
  const normal = count(`SELECT COUNT(*) c FROM chunk_metadata m JOIN chunks_rowids r ON r.rowid = m.rowid`);
  check(normal > 0, `setup: normal chunk vectors exist (${normal})`);
  // orphans: vectors whose metadata row does not exist (large rowids, past 2^53 too)
  const ORPH = [9_000_001n, 9_000_002n, 9_007_199_254_740_993n];
  const ins = mgr.db.prepare(`INSERT INTO chunks(rowid, embedding) VALUES (?, ?)`);
  mgr.db.transaction(() => { ORPH.forEach((r, i) => ins.run(r, vec(i))); })();
  const orphanCount = () => count(`SELECT COUNT(*) c FROM chunks_rowids WHERE rowid NOT IN (SELECT rowid FROM chunk_metadata)`);
  check(orphanCount() === 3, 'setup: 3 orphan chunk vectors');

  // stats show the orphans separately; missing keeps its meaning (metadata-based)
  mgr.coordinator.invalidateCoverage();
  let st = await mgr.getKnowledgeGraphStats();
  const missingBefore = st.server.coverage.chunk.missing;
  check(st.server.coverage.chunk.orphan_vectors === 3, `stats: chunk orphan_vectors = 3 (got ${st.server.coverage.chunk.orphan_vectors})`);
  check(st.server.coverage.entity.orphan_vectors === 0, `stats: entity orphan_vectors = 0 (got ${st.server.coverage.entity.orphan_vectors})`);

  // off mode: classified as repair work (deferred), nothing written
  mgr.embeddingsMode = 'off';
  mgr.coordinator.reconPromise = null; mgr.coordinator.recon = 'pending';
  await mgr.coordinator.runReconciliation();
  check(mgr.coordinator.recon === 'deferred', `off mode: recon deferred (got ${mgr.coordinator.recon})`);
  check(orphanCount() === 3, 'off mode: no orphan deleted');

  // lazy: sanitation removes searchable orphans, keeps normal vectors
  mgr.embeddingsMode = 'lazy';
  mgr.coordinator.reconPromise = null; mgr.coordinator.recon = 'pending';
  await mgr.coordinator.runReconciliation();
  check(orphanCount() === 0, `lazy: orphans removed (left ${orphanCount()})`);
  const normalAfter = count(`SELECT COUNT(*) c FROM chunk_metadata m JOIN chunks_rowids r ON r.rowid = m.rowid`);
  check(normalAfter === normal, `normal chunk vectors kept (${normal} -> ${normalAfter})`);
  st = await mgr.getKnowledgeGraphStats();   // no manual invalidate: the sanitation must refresh the cached count (2_ r1 R2)
  check(st.server.coverage.chunk.orphan_vectors === 0, 'stats: orphan_vectors 0 after');
  check(st.server.coverage.chunk.missing === missingBefore, `missing unchanged by orphan cleanup (${missingBefore} -> ${st.server.coverage.chunk.missing})`);

  // idempotent: a second pass changes nothing
  mgr.coordinator.reconPromise = null; mgr.coordinator.recon = 'pending';
  await mgr.coordinator.runReconciliation();
  const normal2 = count(`SELECT COUNT(*) c FROM chunk_metadata m JOIN chunks_rowids r ON r.rowid = m.rowid`);
  check(orphanCount() === 0 && normal2 === normal, 'second pass: no change');

  // producer (P42): importGraph must not leave chunk vectors behind — checked BEFORE any reconciliation
  const docVectors = (id) => count(`SELECT COUNT(*) c FROM chunk_metadata m JOIN chunks_rowids r ON r.rowid = m.rowid WHERE m.document_id = ?`, id);
  await mgr.storeDocument('doc-b', 'Gamma paragraph about grapes.\n\nDelta paragraph about dates.');
  await mgr.chunkDocument('doc-b');
  await mgr.embedChunks('doc-b');
  check(docVectors('doc-b') > 0, `setup: doc-b has chunk vectors (${docVectors('doc-b')})`);
  await mgr.importGraph({ documents: [{ id: 'doc-b', content: 'replaced content', metadata: {} }] }, { merge: true });
  check(orphanCount() === 0, `importGraph merge (same document id replaced): no orphan chunk vectors (got ${orphanCount()})`);
  await mgr.chunkDocument('doc-a'); await mgr.embedChunks('doc-a');
  check(docVectors('doc-a') > 0, 'setup: doc-a re-embedded');
  await mgr.importGraph({ entities: [], relations: [], documents: [] }, { merge: false });
  check(orphanCount() === 0, `importGraph merge=false (full replace): no orphan chunk vectors (got ${orphanCount()})`);

  // R1 (2_ r1): producers must keep rowids past 2^53 exact — a Number cast deletes the wrong vector or misses it
  const big = 9_007_199_254_740_993n, big2 = 9_007_199_254_740_995n;
  const bigOrphans = () => mgr.db.prepare(`SELECT rowid FROM chunks_rowids WHERE rowid NOT IN (SELECT rowid FROM chunk_metadata)`).safeIntegers(true).all().map(r => String(r.rowid));
  const putChunk = (doc, rowid, i) => {
    mgr.db.prepare(`INSERT OR IGNORE INTO documents (id, content, metadata) VALUES (?, 'x', '{}')`).run(doc);
    mgr.db.prepare(`INSERT INTO chunk_metadata (rowid, chunk_id, document_id, chunk_index, text) VALUES (?, ?, ?, 0, 'x')`).run(rowid, `${doc}_c${i}`, doc);
    mgr.db.prepare(`INSERT INTO chunks(rowid, embedding) VALUES (?, ?)`).run(rowid, vec(100 + i));
  };
  putChunk('large', big, 1);
  await mgr.importGraph({ documents: [{ id: 'large', content: 'new', metadata: {} }] }, { merge: true });
  check(bigOrphans().length === 0, `importGraph merge keeps a rowid past 2^53 exact (orphans ${JSON.stringify(bigOrphans())})`);
  putChunk('large2', big2, 2);
  await mgr.importGraph({ entities: [], relations: [], documents: [] }, { merge: false });
  check(bigOrphans().length === 0, `importGraph merge=false keeps a rowid past 2^53 exact (orphans ${JSON.stringify(bigOrphans())})`);

  // R3 (2_ r1): an unresolvable slot map reports orphan_vectors: null, not a missing key
  const realCov = mgr.coordinator.coverage.bind(mgr.coordinator);
  mgr.coordinator.coverage = () => ({ chunk: { total: 1, embedded: 0, verified: 0, legacy_assumed: 0, error: 'unresolvable vec0 slot' },
                                      entity: { total: 0, embedded: 0, verified: 0, legacy_assumed: 0, error: 'unresolvable vec0 slot' } });
  st = await mgr.getKnowledgeGraphStats();
  mgr.coordinator.coverage = realCov;
  check(Object.hasOwn(st.server.coverage.chunk, 'orphan_vectors') && st.server.coverage.chunk.orphan_vectors === null, 'error branch: chunk orphan_vectors = null');
  check(Object.hasOwn(st.server.coverage.entity, 'orphan_vectors') && st.server.coverage.entity.orphan_vectors === null, 'error branch: entity orphan_vectors = null');
} finally {
  cleanup();
}
if (failed) { console.log(`chunk-orphan-vectors: ${failed} FAIL`); process.exit(1); }
console.log('chunk-orphan-vectors: all OK');
