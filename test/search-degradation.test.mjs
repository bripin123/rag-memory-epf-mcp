// #3: with the embedding model down, hybridSearch returns FTS5 (BM25) results
// tagged search_mode='fts-only' instead of throwing.
import { writeFileSync } from 'fs';
import { join } from 'path';
import { makeManager, installFakeEmbedder, simulateModelDown, assert } from './helpers/engine-test-db.mjs';

const { manager, dir, cleanup } = await makeManager();
try {
  installFakeEmbedder(manager);
  const file = join(dir, 'doc.txt');
  // ASCII content so the default FTS5 tokenizer matches the query term cleanly.
  writeFileSync(file, 'the quick brown fox jumps over the lazy dog zebra', 'utf-8');
  await manager.syncDocumentFromFile(file, 'doc1', {});

  // Sanity: normal (non-degraded) search returns hybrid results.
  const normal = await manager.hybridSearch('zebra', 5, true);
  assert(Array.isArray(normal), 'normal search returns an array');

  // Model goes down.
  simulateModelDown(manager);

  let threw = false, results = null;
  try {
    results = await manager.hybridSearch('zebra', 5, true);
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'hybridSearch does NOT throw when model is down');
  assert(Array.isArray(results) && results.length > 0, `FTS5-only search returns results (${results ? results.length : 0})`);
  assert(results && results.every(r => r.search_mode === 'fts-only'), 'all results tagged search_mode=fts-only');
} finally {
  cleanup();
}
console.log(process.exitCode ? 'DEGRADATION FAILED' : 'DEGRADATION OK');
