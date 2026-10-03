#!/usr/bin/env node
// search-fusion-rrf (specs/changes/search-fusion-rrf): the default hybridSearch
//   (1) keeps the per-fragment summary path OFF unless RAG_MEMORY_SEARCH_SUMMARIES === 'on' (exact), and
//   (2) ranks by reciprocal rank fusion: 1/(60 + vectorRank) + 1/(60 + ftsRank), a missing list adds 0.
//       vectorRank is taken from the vector list BEFORE FTS-only candidates are appended.
//   (3) a vector failure on a later cross-lingual variant leaves no vector candidate behind (D5).
// Non-vacuous: fails on 6.3.2 (summaries on by default; FTS-only identifier buried) and on the mutants
// recorded in specs/changes/search-fusion-rrf/proposal.md (no vector term / no FTS term / vector rank
// taken after the FTS append / D5 clear removed).
import { makeManager, installControlledEmbedder, axisVec, assert } from './helpers/engine-test-db.mjs';

delete process.env.RAG_MEMORY_SEARCH_SUMMARIES;     // the default under test
const { manager: m, cleanup } = await makeManager();
const near = (a, b) => Math.abs(a - b) < 1e-12;
try {
  const IDENT = 'zqxident77';
  const table = new Map();
  for (const v of m.buildCrossLingualVariants(IDENT)) table.set(v, axisVec(1.0));   // query = axis 0
  const counter = installControlledEmbedder(m, table);
  await m.startReconciliation();

  // 12 distractors: cos 0.5 each on its own axis, no identifier.
  const docs = [];
  for (let i = 0; i < 12; i++) docs.push({ id: `d-near-${i}`, text: `Plain distractor paragraph number ${i} about unrelated gardening notes.`, vec: axisVec(0.5, 3 + i) });
  // Competitor present in BOTH lists: closest vector (cos 0.6) and holds the identifier once in a long text
  // (BM25 length normalisation puts it second in FTS). It must stay above the target.
  docs.push({ id: 'd-both', text: `Long design memo that mentions ${IDENT} once and then keeps going about storage layout, migration order, cache sizing, retry budgets, logging fields, test fixtures, release notes and several other topics for quite a while.`, vec: axisVec(0.6, 20) });
  // Target: identifier in a short text (FTS rank 1) but semantically far (cos 0.05 -> last vector rank).
  docs.push({ id: 'd-target', text: `Checklist entry ${IDENT} noted.`, vec: axisVec(0.05, 2) });
  for (const d of docs) table.set(d.text, d.vec);
  for (const d of docs) await m.syncDocumentFromFile(`/${d.id}.md`, d.id, { content: d.text });

  // Fixture self-checks: controlled vectors are really in use; FTS order is target, then d-both.
  const texts = m.db.prepare(`SELECT text FROM chunk_metadata WHERE document_id LIKE 'd-%'`).all().map(r => r.text);
  assert(texts.length === docs.length, `fixture: one chunk per document (${texts.length}/${docs.length})`);
  assert(texts.every(t => table.has(t)), 'fixture: every chunk text has a controlled vector');

  const byId = (r) => new Map(r.results.map((x, i) => [x.source_id, { ...x, rank: i + 1 }]));
  const variants = new Set(m.buildCrossLingualVariants(IDENT)).size;

  // ---- C1: default embeds only the query; preview slices exactly; non-'on' values stay off.
  for (const val of [undefined, 'off', 'ON', '1', '']) {
    if (val === undefined) delete process.env.RAG_MEMORY_SEARCH_SUMMARIES; else process.env.RAG_MEMORY_SEARCH_SUMMARIES = val;
    m.embeddingCache = new Map(); counter.calls = 0;
    const r = await m.hybridSearch(IDENT, 10, false);
    assert(counter.calls === variants, `C1 env=${JSON.stringify(val)}: only the ${variants} query variant(s) embedded (calls=${counter.calls})`);
  }
  delete process.env.RAG_MEMORY_SEARCH_SUMMARIES;
  m.embeddingCache = new Map();
  const a = await m.hybridSearch(IDENT, 10, false);
  const textOf = new Map(docs.map(d => [d.id, d.text]));
  assert(a.results.every(x => x.content_summary === textOf.get(x.source_id).slice(0, 300) && x.key_highlight === textOf.get(x.source_id).slice(0, 150)), 'C1 content_summary / key_highlight are exact preview slices');

  // ---- C3a: limit 10 -> vector depth 30 >= 14 docs: everything is a vector candidate.
  //   d-both: vector rank 1 + FTS rank 2 ; target: vector rank 14 + FTS rank 1 ; distractors: vector rank 2..13 only.
  const A = byId(a);
  assert(A.has('d-target') && A.has('d-both'), `C3a target and d-both are in the top 10 (target rank ${A.get('d-target')?.rank ?? 'absent'})`);
  assert(near(A.get('d-target')?.fts_boost ?? -1, 1 / 61) && near(A.get('d-both')?.fts_boost ?? -1, 1 / 62), `fixture: FTS ranks target=1, d-both=2 (fts ${A.get('d-target')?.fts_boost?.toFixed(5)}, ${A.get('d-both')?.fts_boost?.toFixed(5)})`);
  assert(A.get('d-both')?.rank === 1 && near(A.get('d-both')?.relevance_score ?? -1, 1 / 61 + 1 / 62), `C3a d-both (both lists) rank 1, score 1/61+1/62 (rank ${A.get('d-both')?.rank}, ${A.get('d-both')?.relevance_score?.toFixed(6)})`);
  assert(A.get('d-target')?.rank === 2 && near(A.get('d-target')?.relevance_score ?? -1, 1 / 74 + 1 / 61), `C3a target rank 2, score 1/74+1/61 (rank ${A.get('d-target')?.rank}, ${A.get('d-target')?.relevance_score?.toFixed(6)})`);
  const dist = a.results.filter(x => x.source_id.startsWith('d-near-'));
  assert(dist.length === 8 && dist.every((x, i) => near(x.relevance_score, 1 / (62 + i)) && x.fts_boost === undefined), 'C3a distractors follow at 1/62, 1/63, ... with no FTS term');
  assert(a.results.every(x => x.relevance_score <= 2 / 61 + 1e-12), 'C3a every default score <= 2/61 (RRF ceiling)');

  // ---- C3b: limit 3 -> vector depth 9 < 13 closer docs: the target is an FTS-only candidate.
  const b = await m.hybridSearch(IDENT, 3, false);
  const B = byId(b);
  assert(B.has('d-target') && B.get('d-target')?.rank === 2, `C3b FTS-only target reaches rank 2 of 3 (rank ${B.get('d-target')?.rank})`);
  assert(B.get('d-target')?.vector_similarity === 0, 'C3b target was not a vector candidate (FTS-only row: vector_similarity 0)');
  assert(near(B.get('d-target')?.relevance_score ?? -1, 1 / 61), `C3b FTS-only target scores exactly 1/61 (no invented vector rank) (${B.get('d-target')?.relevance_score?.toFixed(6)})`);
  assert(B.get('d-both')?.rank === 1, 'C3b d-both (both lists) stays above the target');

  // ---- C2: summaries on request -> fragment embeddings, legacy formula and scale.
  process.env.RAG_MEMORY_SEARCH_SUMMARIES = 'on';
  m.embeddingCache = new Map(); counter.calls = 0;
  const c = await m.hybridSearch(IDENT, 10, false);
  assert(counter.calls > variants, `C2 summaries=on embeds fragments (calls=${counter.calls})`);
  assert(c.results.every(x => x.relevance_score >= x.vector_similarity - 1e-12), 'C2 summaries=on: legacy score >= vector similarity for every result');
  delete process.env.RAG_MEMORY_SEARCH_SUMMARIES;

  // ---- C4: useGraph:true keeps the legacy formula: score = max(vs, 0) + graph boost + FTS term.
  const g = await m.hybridSearch(IDENT, 10, true);
  assert(g.results.every(x => near(x.relevance_score, x.vector_similarity + (x.graph_boost ?? 0) + (x.fts_boost ?? 0))), 'C4 useGraph:true (summaries off): score = vector_similarity + graph_boost + fts_boost');

  // ---- Env read at call entry: flipping the env to 'on' WHILE the query is being embedded must not turn the
  //      summary path on for that call (r3: the mode is read once, before the first await).
  {
    delete process.env.RAG_MEMORY_SEARCH_SUMMARIES;
    const base = m.gate.embedFn;
    m.gate.embedFn = async (text, ...rest) => { process.env.RAG_MEMORY_SEARCH_SUMMARIES = 'on'; return base(text, ...rest); };
    m.embeddingCache = new Map(); counter.calls = 0;
    await m.hybridSearch(IDENT, 10, false);
    m.gate.embedFn = base; delete process.env.RAG_MEMORY_SEARCH_SUMMARIES;
    assert(counter.calls === variants, `env read at call entry: a mid-call flip to 'on' does not start fragment embeddings (calls=${counter.calls})`);
  }

  // ---- D5: a vector failure on a later variant must leave no vector candidate behind — in all four modes.
  const SECOND = 'zzsecondvariant';
  const origVariants = m.buildCrossLingualVariants;
  m.buildCrossLingualVariants = (q) => (q === IDENT ? [IDENT, SECOND] : origVariants.call(m, q));
  const origFn = m.gate.embedFn;
  m.gate.embedFn = async (text, ...rest) => { if (text === SECOND) throw new Error('injected second-variant failure'); return origFn(text, ...rest); };
  for (const [env, graph] of [[undefined, false], [undefined, true], ['on', false], ['on', true]]) {
    if (env === undefined) delete process.env.RAG_MEMORY_SEARCH_SUMMARIES; else process.env.RAG_MEMORY_SEARCH_SUMMARIES = env;
    m.embeddingCache = new Map(); counter.calls = 0;
    const d = await m.hybridSearch(IDENT, 10, graph);
    const tag = `D5 summaries=${env ?? 'unset'} useGraph=${graph}`;
    assert(d.search_mode === 'fts-only', `${tag}: envelope says fts-only (${d.search_mode})`);
    assert(d.results.length === 2 && d.results.every(x => x.fts_boost !== undefined && x.vector_similarity === 0 && x.graph_boost === undefined), `${tag}: only FTS hits, no vector score, no graph boost (${d.results.map(x => x.source_id).join(',')})`);
    assert(d.results[0]?.source_id === 'd-target' && near(d.results[0]?.relevance_score ?? -1, 1 / 61), `${tag}: order = FTS order (target first, score 1/61)`);
    assert(counter.calls === 1, `${tag}: no fragment embeddings after the failure (embedder calls=${counter.calls})`);
  }
  delete process.env.RAG_MEMORY_SEARCH_SUMMARIES;
  m.gate.embedFn = origFn; m.buildCrossLingualVariants = origVariants;

  console.log(process.exitCode ? 'search-fusion-rrf: FAIL' : 'search-fusion-rrf: ALL PASS');
} finally { cleanup(); }
