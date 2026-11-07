// vec-similarity: vec0 tables use the default L2 metric and embeddings are unit-normalized, so the
// cosine similarity shown to callers must be 1 − d²/2 (not 1 − d/2, which treated L2 as cosine distance).
// Controlled unit vectors: ALPHA = e0, GAMMA = 0.8·e0 + 0.6·e1 (cos 0.8 to ALPHA), BETA = e1 (cos 0).
import { createRequire } from 'node:module';
import { makeManager } from './helpers/engine-test-db.mjs';

const require = createRequire(import.meta.url);
const { manager: mgr, cleanup } = await makeManager();
let failed = 0;
const check = (cond, msg) => { if (cond) console.log(`  OK: ${msg}`); else { failed++; console.log(`  FAIL: ${msg}`); } };
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-3;

try {
  const unit = (x, y) => { const v = new Float32Array(1024); v[0] = x; v[1] = y; return v; };
  const gate = mgr.gate;
  gate.state = 'ready';
  gate.shuttingDown = false;
  gate.embedFn = async (text) => {
    if (text.includes('DELTA')) return unit(0.3, Math.sqrt(1 - 0.09));   // cos 0.3 to ALPHA
    if (text.includes('GAMMA')) return unit(0.8, 0.6);
    if (text.includes('BETA')) return unit(0, 1);
    return unit(1, 0);                               // ALPHA and the query
  };
  mgr.embeddingCache = new Map();

  // 1) metric assumption: orthogonal unit vectors are √2 apart in vec0 (L2) — cosine distance would be 1.0
  const d = mgr.db.prepare('SELECT vec_distance_l2(?, ?) AS d').get(
    Buffer.from(unit(1, 0).buffer), Buffer.from(unit(0, 1).buffer)).d;
  check(near(d, Math.SQRT2), `orthogonal unit vectors L2 distance = √2 (got ${d})`);

  // 2) searchNodes similarity values
  await mgr.createEntities([
    { name: 'ALPHA', entityType: 'CONCEPT', observations: ['a'] },
    { name: 'GAMMA', entityType: 'CONCEPT', observations: ['g'] },
    { name: 'BETA', entityType: 'CONCEPT', observations: ['b'] },
  ]);
  await mgr.embedAllEntities();
  await mgr.coordinator.runReconciliation();      // vector search is gated until reconciliation completes
  const res = await mgr.searchNodes('ALPHA', 10);
  check(res.search_mode === 'hybrid', `vector path used (search_mode=${res.search_mode} ${res.degradation_reason ?? ''})`);
  const sim = Object.fromEntries(res.entities.map(e => [e.name, e.similarity]));
  check(near(sim.ALPHA, 1), `same vector → similarity 1 (got ${sim.ALPHA})`);
  check(near(sim.GAMMA, 0.8), `cos 0.8 → similarity 0.8 (got ${sim.GAMMA}; old 1−d/2 gave ≈0.684)`);
  check(near(sim.BETA, 0), `orthogonal → similarity 0 (got ${sim.BETA}; old 1−d/2 gave ≈0.293)`);

  // 3) graph seeds = legacy path, pinned to the 6.3.2 score (engine 4ac3155 · 2_ r2 D1′ (a)): the old 1 − d/2 score
  //    and its > 0.4 threshold stay, so cos 0.3 (score ≈0.408) is still a seed and cos 0.8 scores ≈0.684
  await mgr.createEntities([{ name: 'DELTA', entityType: 'CONCEPT', observations: ['d'] }]);
  await mgr.embedAllEntities();
  const ctx = await mgr.explainGraphContext('ALPHA');
  const seeds = Object.fromEntries(ctx.seeds.map(x => [x.name, x.similarity]));
  const legacy = (c) => 1 - Math.sqrt(2 - 2 * c) / 2;
  check(near(seeds.GAMMA, legacy(0.8)), `legacy seed GAMMA keeps the old score ≈0.684 (got ${seeds.GAMMA})`);
  check(near(seeds.DELTA, legacy(0.3)) && !('BETA' in seeds), `legacy seeds keep cos 0.3 (≈0.408) and drop cos 0 (seeds ${JSON.stringify(seeds)})`);

  // 4) hybridSearch vector_similarity of a chunk at cos 0.8
  await mgr.storeDocument('doc-g', 'GAMMA chunk text');
  await mgr.chunkDocument('doc-g');
  await mgr.embedChunks('doc-g');
  const hs = await mgr.hybridSearch('ALPHA', 5, false);
  const hit = hs.results.find(r => JSON.stringify(r).includes('doc-g'));
  check(hit && near(hit.vector_similarity, 0.8), `default hybridSearch (rank fusion) vector_similarity 0.8 (got ${hit?.vector_similarity})`);
  // 5) legacy hybridSearch paths (useGraph:true OR summaries on) keep the old score
  const hsG = await mgr.hybridSearch('ALPHA', 5, true);
  const hitG = hsG.results.find(r => JSON.stringify(r).includes('doc-g'));
  check(hitG && near(hitG.vector_similarity, legacy(0.8)), `useGraph:true keeps the old vector_similarity ≈0.684 (got ${hitG?.vector_similarity})`);
  process.env.RAG_MEMORY_SEARCH_SUMMARIES = 'on';
  const hsS = await mgr.hybridSearch('ALPHA', 5, false);
  delete process.env.RAG_MEMORY_SEARCH_SUMMARIES;
  const hitS = hsS.results.find(r => JSON.stringify(r).includes('doc-g'));
  check(hitS && near(hitS.vector_similarity, legacy(0.8)), `summaries on keeps the old vector_similarity ≈0.684 (got ${hitS?.vector_similarity})`);
} finally {
  cleanup();
}
if (failed) { console.log(`vec-similarity: ${failed} FAIL`); process.exit(1); }
console.log('vec-similarity: all OK');
