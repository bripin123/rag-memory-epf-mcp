// Builds the parity fixture and runs the 9 differential cases. Used twice:
//   (a) BEFORE extraction: `node test/fixtures/graph-context/build.mjs --write` records the golden
//   (b) AFTER extraction: the test replays and byte-compares.
import { writeFileSync } from 'node:fs';
import { makeManager, installControlledEmbedder, axisVec } from '../../helpers/engine-test-db.mjs';

export const QUERY = 'graph context probe query';
export async function buildFixture() {
  const { manager: m, dir } = await makeManager();
  m.embeddingsMode = 'lazy';
  // Entity name -> vector so that similarity to QUERY is controlled (QUERY = axis 0 unit vector).
  const table = new Map([
    [QUERY, axisVec(1.0)],
    ['Alpha Node', axisVec(0.60)],      // seed (sim ≈ 0.55)
    ['Beta Node',  axisVec(0.31)],      // just above threshold (sim ≈ 0.41)
    ['Gamma Node', axisVec(0.25)],      // just below threshold (sim ≈ 0.39)
    ['Delta Node', axisVec(-0.5)],      // far
    ['Alpha Node observations', axisVec(0.60)],
  ]);
  const controlled = installControlledEmbedder(m, table);
  await m.createEntities([
    { name: 'Alpha Node', entityType: 'CONCEPT', observations: ['Alpha Node observations'] },
    { name: 'Beta Node',  entityType: 'CONCEPT', observations: ['beta text'] },
    { name: 'Gamma Node', entityType: 'CONCEPT', observations: ['gamma text'] },
    { name: 'Delta Node', entityType: 'CONCEPT', observations: ['delta text'] },
    { name: 'Lonely Node', entityType: 'CONCEPT', observations: ['no relations at all'] },
  ]);
  // The engine embeds an entity as `${entityType}: ${name}. ${observations}` with the observation
  // date stamp (buildEntityEmbeddingText), not the bare name, so the table above never matched and
  // the entity vectors fell through to the char-code fallback — the 0.4-threshold design had no
  // effect and the vectors changed with the calendar day. Read the real embedding text back from
  // the projection, register the controlled vector for it, and re-embed (embedEntity always
  // overwrites; the cache must be dropped or it returns the fallback vector it already computed).
  const cos = { 'Alpha Node': 0.60, 'Beta Node': 0.31, 'Gamma Node': 0.25, 'Delta Node': -0.5, 'Lonely Node': -0.5 };
  for (const row of m.db.prepare(`SELECT id, name, entityType, observations FROM entities ORDER BY id`).all()) {
    const text = `${row.entityType}: ${row.name}. ${JSON.parse(row.observations).join('. ')}`.trim();
    table.set(text, axisVec(cos[row.name]));
  }
  m.embeddingCache = new Map();
  for (const row of m.db.prepare(`SELECT id FROM entities ORDER BY id`).all()) {
    if (await m.tryEmbedEntity(row.id, 'interactive') !== 'embedded') throw new Error(`fixture: ${row.id} not embedded`);
  }
  if (controlled.calls === 0) throw new Error('fixture: controlled embedder was never called');
  await m.createRelations([
    { from: 'Alpha Node', to: 'Delta Node', relationType: 'REFERENCES' },   // out-edge from seed
    { from: 'Delta Node', to: 'Alpha Node', relationType: 'SUPPORTS' },     // in-edge to seed (bidirectional pair)
    { from: 'Alpha Node', to: 'Delta Node', relationType: 'EXTENDS' },      // parallel edge, different type
    { from: 'Beta Node',  to: 'Gamma Node', relationType: 'RELATED_TO' },
  ]);
  // confidence null case: set one edge's confidence to NULL directly (schema allows).
  m.db.prepare(`UPDATE relationships SET confidence = NULL WHERE relationType = 'EXTENDS'`).run();
  await m.syncDocumentFromFile('/alpha.md', 'd-alpha', { content: 'Alpha Node appears here with searchable alpha words. Delta Node too.' });
  await m.syncDocumentFromFile('/beta.md',  'd-beta',  { content: 'Beta Node and Gamma Node appear here with searchable beta gamma words.' });
  await m.syncDocumentFromFile('/plain.md', 'd-plain', { content: 'plain document with no entity mention, only searchable filler words.' });
  await m.startReconciliation();
  return { m, dir };
}

const strip = (res) => ({
  search_mode: res.search_mode,
  results: res.results.map(r => ({ chunk_id: r.chunk_id, vs: r.vector_similarity, gb: r.graph_boost, fts: r.fts_boost, fin: r.relevance_score })),
});

export async function runCases(m) {
  const out = {};
  out.c1_multi_seed_threshold = strip(await m.hybridSearch(QUERY, 10, true));          // Alpha+Beta seeds, Gamma below
  out.c2_default_off          = strip(await m.hybridSearch(QUERY, 10));                // no graph_boost at all
  out.c3_no_candidate         = strip(await m.hybridSearch('zzqx nothing matches', 10, true));
  out.c4_cross_lingual        = strip(await m.hybridSearch('알파 노드 검색', 10, true)); // variants path (may equal single variant)
  // c5: entity-vector exception forced -> text fallback path
  const origPrepare = m.db.prepare.bind(m.db);
  m.db.prepare = (sql) => { if (/FROM entity_embeddings ee/.test(sql)) throw new Error('forced entity-vector failure'); return origPrepare(sql); };
  out.c5_entity_vector_exception = strip(await m.hybridSearch(QUERY, 10, true));
  m.db.prepare = origPrepare;
  // c6: chunk-vector degraded (model down) -> fts-only, graph block skipped
  const { simulateModelDown } = await import('../../helpers/engine-test-db.mjs');
  const savedFn = m.gate.embedFn, savedState = m.gate.state;
  simulateModelDown(m);
  out.c6_chunk_vector_degraded = strip(await m.hybridSearch(QUERY, 10, true));
  m.gate.state = savedState; m.gate.embedFn = savedFn; m.embeddingCache = new Map();
  // c7: relations emptied -> seeds but no connected
  const rels = m.db.prepare(`SELECT * FROM relationships`).all();
  m.db.prepare(`DELETE FROM relationships`).run();
  out.c7_no_relations = strip(await m.hybridSearch(QUERY, 10, true));
  const ins = m.db.prepare(`INSERT INTO relationships (id, source_entity, target_entity, relationType, confidence, metadata, created_at) VALUES (?,?,?,?,?,?,?)`);
  for (const r of rels) ins.run(r.id, r.source_entity, r.target_entity, r.relationType, r.confidence, r.metadata, r.created_at);
  out.c8_limit_1  = strip(await m.hybridSearch(QUERY, 1, true));
  out.c9_limit_50 = strip(await m.hybridSearch(QUERY, 50, true));
  return out;
}

if (process.argv.includes('--write')) {
  const { m } = await buildFixture();
  const cases = await runCases(m);
  writeFileSync(new URL('../graph-context-golden.json', import.meta.url), JSON.stringify(cases, null, 2) + '\n');
  console.log('golden written:', Object.keys(cases).length, 'cases');
  m.cleanup();
}
