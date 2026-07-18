// #3: with the embedding model down, hybridSearch returns FTS5 (BM25) results
// in a v3.6 envelope tagged search_mode='fts-only' instead of throwing.
// (v3.6 breaking change: array -> {results, search_mode, model_state, coverage}.)
import { writeFileSync } from 'fs';
import { join } from 'path';
import { makeManager, installFakeEmbedder, simulateModelDown, assert } from './helpers/engine-test-db.mjs';

const { manager, dir, cleanup } = await makeManager();
try {
  manager.embeddingsMode = 'lazy';
  installFakeEmbedder(manager);
  const file = join(dir, 'doc.txt');
  // ASCII content so the default FTS5 tokenizer matches the query term cleanly.
  writeFileSync(file, 'the quick brown fox jumps over the lazy dog zebra', 'utf-8');
  await manager.syncDocumentFromFile(file, 'doc1', {});
  await manager.startReconciliation(); // fresh DB -> 'n/a', opens eligibility

  // Sanity: normal (non-degraded) search returns a hybrid envelope.
  const normal = await manager.hybridSearch('zebra', 5, true);
  assert(Array.isArray(normal.results), 'normal search returns envelope.results array');
  assert(normal.search_mode === 'hybrid', `normal search_mode is hybrid (got ${normal.search_mode})`);

  // Model goes down.
  simulateModelDown(manager);

  let threw = false, res = null;
  try {
    res = await manager.hybridSearch('zebra', 5, true);
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'hybridSearch does NOT throw when model is down');
  assert(res && Array.isArray(res.results) && res.results.length > 0,
    `FTS5-only search returns results (${res ? res.results.length : 0})`);
  assert(res.search_mode === 'fts-only', 'envelope tagged search_mode=fts-only');
  assert(res.degradation_reason === 'model_not_ready', `degradation_reason present (got ${res.degradation_reason})`);
} finally {
  cleanup();
}
console.log(process.exitCode ? 'DEGRADATION FAILED' : 'DEGRADATION OK');
