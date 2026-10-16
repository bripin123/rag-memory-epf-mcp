#!/usr/bin/env node
// kg-relation-evidence D4: `limit` is both the result cap and the retrieval depth — each query variant asks for up
// to limit*3 vector neighbours and up to limit*3 FTS rows (index.ts:4327/4371), which are then merged. So the top-1
// of limit 1 and of limit 2 can differ. Not a defect — pinned so nobody "fixes" it silently, and so comparisons fix
// the call limit and cut k from the returned list.
//   target = (vector rank 4, FTS rank 1), competitor = (vector rank 3, FTS rank 2)
//   limit 1 -> depth 3: target has no vector term: 1/61 = 0.0163934 < competitor 1/63 + 1/62 = 0.03200205
//   limit 2 -> depth 6: target 1/64 + 1/61 = 0.03201844 > competitor 0.03200205
// This fixture detects the VECTOR depth only: only two documents contain the identifier, so both FTS hits stay
// inside any FTS depth >= 3 and a change to the FTS LIMIT alone is not detected here.
import { makeManager, installControlledEmbedder, axisVec, assert } from './helpers/engine-test-db.mjs';

delete process.env.RAG_MEMORY_SEARCH_SUMMARIES;
const { manager: m, cleanup } = await makeManager();
const near = (a, b) => Math.abs(a - b) < 1e-12;
try {
  const IDENT = 'zqxlimit55';
  const table = new Map();
  for (const v of m.buildCrossLingualVariants(IDENT)) table.set(v, axisVec(1.0));
  installControlledEmbedder(m, table);
  await m.startReconciliation();
  const docs = [
    { id: 'l-near-1', text: 'Closest unrelated paragraph about tide tables.', vec: axisVec(0.9, 3) },
    { id: 'l-near-2', text: 'Second unrelated paragraph about kiln schedules.', vec: axisVec(0.8, 4) },
    { id: 'l-competitor', text: `Long memo that mentions ${IDENT} once and then continues about storage layout, migration order, cache sizing, retry budgets, logging fields and release notes for quite a while.`, vec: axisVec(0.7, 5) },
    { id: 'l-target', text: `Entry ${IDENT} noted.`, vec: axisVec(0.6, 6) },
    { id: 'l-far-5', text: 'Fifth unrelated paragraph about rope knots.', vec: axisVec(0.5, 7) },
    { id: 'l-far-6', text: 'Sixth unrelated paragraph about bread starters.', vec: axisVec(0.4, 8) },
    { id: 'l-far-7', text: 'Seventh unrelated paragraph about lantern wicks.', vec: axisVec(0.3, 9) },
  ];
  for (const d of docs) table.set(d.text, d.vec);
  for (const d of docs) await m.syncDocumentFromFile(`/${d.id}.md`, d.id, { content: d.text });
  const texts = m.db.prepare(`SELECT text FROM chunk_metadata WHERE document_id LIKE 'l-%'`).all().map(r => r.text);
  assert(texts.length === docs.length && texts.every(t => table.has(t)), 'fixture: one chunk per document, every vector controlled');

  const r1 = await m.hybridSearch(IDENT, 1, false);
  const r2 = await m.hybridSearch(IDENT, 2, false);
  assert(r1.search_mode === 'hybrid' && r2.search_mode === 'hybrid', 'fixture: hybrid mode');
  const t2 = r2.results.find(x => x.source_id === 'l-target'), c2 = r2.results.find(x => x.source_id === 'l-competitor');
  assert(near(t2?.fts_boost ?? -1, 1 / 61) && near(c2?.fts_boost ?? -1, 1 / 62), 'fixture: FTS ranks target 1, competitor 2');
  assert(r1.results[0]?.source_id === 'l-competitor' && near(r1.results[0].relevance_score, 1 / 63 + 1 / 62), `limit 1: competitor first at 1/63+1/62 (${r1.results[0]?.source_id})`);
  assert(r2.results[0]?.source_id === 'l-target' && near(r2.results[0].relevance_score, 1 / 64 + 1 / 61), `limit 2: target first at 1/64+1/61 (${r2.results[0]?.source_id})`);
  assert(r2.results[1]?.source_id === 'l-competitor', 'limit 2: competitor second');
  assert(Math.abs((1 / 64 + 1 / 61) - 0.03201844) < 5e-9 && Math.abs((1 / 63 + 1 / 62) - 0.03200205) < 5e-9, 'the proposal arithmetic');
  assert(r2.results[0].source_id !== r1.results[0].source_id, 'in this fixture hybridSearch(q,2)[:1] differs from hybridSearch(q,1) — documented');
  console.log(process.exitCode ? 'search-limit-depth: FAIL' : 'search-limit-depth: ALL PASS');
} finally { cleanup(); }
