// explainGraphContext contract (evaluation seam) + differential parity with the pre-extraction golden.
import { readFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { buildFixture, runCases, QUERY, NO_SEED_QUERY } from './fixtures/graph-context/build.mjs';

const { m, dir } = await buildFixture();
const golden = JSON.parse(readFileSync(new URL('./fixtures/graph-context-golden.json', import.meta.url), 'utf8'));

// (A) differential parity: byte-identical to the golden recorded before extraction
{
  const now = await runCases(m);
  assert.equal(JSON.stringify(now), JSON.stringify(golden), 'hybridSearch(useGraph:true) must be byte-identical to pre-extraction golden');
  console.log('  OK: differential parity — 9 cases identical');
}
// (B) seam contract on the normal path
{
  const g = await m.explainGraphContext(QUERY);
  assert.equal(g.status, 'vector');
  const seedNames = g.seeds.map(s => s.name);
  assert.deepEqual(seedNames, ['Alpha Node', 'Beta Node'], 'seeds = above-threshold entities, similarity desc');
  assert.ok(!seedNames.includes('Gamma Node'), 'Gamma (sim≈0.39) must be below the 0.4 threshold');
  const viaAlpha = g.connected.filter(c => c.via_seed_name === 'Alpha Node');
  assert.equal(viaAlpha.length, 3, 'parallel + bidirectional edges are all kept as rows');
  assert.deepEqual(viaAlpha.map(c => c.direction).sort(), ['in', 'out', 'out']);
  assert.ok(viaAlpha.some(c => c.relation_type === 'EXTENDS' && c.confidence === null), 'null confidence preserved');
  const ids = viaAlpha.map(c => c.edge_id);
  assert.deepEqual(ids, [...ids].sort(), 'connected ordered by edge_id within a seed');
  console.log('  OK: seam contract (status vector, seeds, connected rows with edge/type/direction/confidence)');
}
// (C) branch preservation
{
  const origPrepare = m.db.prepare.bind(m.db);
  m.db.prepare = (sql) => { if (/FROM entity_embeddings ee/.test(sql)) throw new Error('forced'); return origPrepare(sql); };
  const g = await m.explainGraphContext(QUERY);
  m.db.prepare = origPrepare;
  assert.equal(g.status, 'entity-text-fallback');
  const { simulateModelDown } = await import('./helpers/engine-test-db.mjs');
  const savedFn = m.gate.embedFn, savedState = m.gate.state;
  simulateModelDown(m);
  const d = await m.explainGraphContext(QUERY);
  m.gate.state = savedState; m.gate.embedFn = savedFn; m.embeddingCache = new Map();
  assert.equal(d.status, 'chunk-vector-disabled'); assert.equal(d.seeds.length, 0); assert.equal(d.connected.length, 0);
  console.log('  OK: branch preservation (entity-text-fallback / chunk-vector-disabled)');
}
// (D) default call still carries no graph_boost
{
  const r = await m.hybridSearch(QUERY, 5);
  for (const x of r.results) assert.equal(x.graph_boost, undefined);
  console.log('  OK: default call has no graph_boost');
}
// (E) case c3 is a real zero-seed case: the query is orthogonal to every entity vector, so the
// graph contributes nothing at all rather than saturating the cap (review finding I1)
{
  const g = await m.explainGraphContext(NO_SEED_QUERY);
  assert.equal(g.status, 'vector', 'the vector path ran — this is not a disabled or fallback result');
  assert.deepEqual(g.seeds, [], 'no entity clears the 0.4 threshold');
  assert.deepEqual(g.connected, [], 'no seeds means nothing connected');
  const r = await m.hybridSearch(NO_SEED_QUERY, 10, true);
  for (const x of r.results) assert.equal(x.graph_boost, 0, 'zero seeds must leave graph_boost at 0');
  console.log('  OK: zero-seed case (status vector, seeds none, connected none, graph_boost 0)');
}
// (F) the caller's latched chunk-vector decision wins over the live coordinator state, and
// hybridSearch hands its own latched flag over (review finding I2)
{
  assert.equal(m.coordinator.eligible, true, 'precondition: the coordinator is eligible');
  const forced = await m.explainGraphContext(QUERY, undefined, { chunkVectorDegraded: true });
  assert.equal(forced.status, 'chunk-vector-disabled', 'the caller said degraded, so the seam stops');
  assert.deepEqual(forced.seeds, []); assert.deepEqual(forced.connected, []);

  // Other direction: the model is down but the caller latched "not degraded" before it went down.
  // The seam must still attempt the entity-vector search and fall back on the throw — that is what
  // the pre-extraction code did in this race, and it is why hybridSearch passes its own value.
  const { simulateModelDown } = await import('./helpers/engine-test-db.mjs');
  const savedFn = m.gate.embedFn, savedState = m.gate.state;
  simulateModelDown(m);
  assert.equal(m.coordinator.eligible, false, 'precondition: the coordinator is now ineligible');
  const attempted = await m.explainGraphContext(QUERY, undefined, { chunkVectorDegraded: false });
  m.gate.state = savedState; m.gate.embedFn = savedFn; m.embeddingCache = new Map();
  assert.equal(attempted.status, 'entity-text-fallback', 'the caller overrode the live state, so the seam tried');

  const seen = [];
  const orig = m.explainGraphContext.bind(m);
  m.explainGraphContext = async (...args) => { seen.push(args); return orig(...args); };
  await m.hybridSearch(QUERY, 10, true);
  delete m.explainGraphContext;
  assert.equal(seen.length, 1, 'hybridSearch calls the seam exactly once');
  assert.deepEqual(seen[0][2], { chunkVectorDegraded: false }, 'hybridSearch passes its latched vectorDegraded');
  console.log('  OK: caller-latched chunkVectorDegraded wins, and hybridSearch passes its own');
}
m.cleanup(); rmSync(dir, { recursive: true, force: true });
console.log('graph-context-explain: ALL OK');
