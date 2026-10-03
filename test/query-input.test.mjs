#!/usr/bin/env node
// search-fusion-rrf (query input): the model sees the raw text for queries and passages alike (bge-m3 needs no
// query instruction), and the DB records query_prefix_version 2. Fails on 6.3.2 (no embeddingInput export; the
// loader prepended a bge-v1.5 instruction to queries; query_prefix_version stayed 1).
import { makeManager, assert } from './helpers/engine-test-db.mjs';
const { manager: m, cleanup } = await makeManager();
try {
  const mod = await import('../dist/index.js');
  assert(typeof mod.embeddingInput === 'function', 'embeddingInput is exported');
  for (const t of ['짧은 질문', 'Represent nothing', 'conftest.py', '']) {
    assert(mod.embeddingInput?.(t, true) === t, `query input is the raw text (${JSON.stringify(t)})`);
    assert(mod.embeddingInput?.(t, false) === t, `passage input is the raw text (${JSON.stringify(t)})`);
  }
  const row = m.db.prepare(`SELECT value FROM server_meta WHERE key='query_prefix_version'`).get();
  assert(row?.value === '2', `server_meta.query_prefix_version = 2 (${row?.value})`);
  console.log(process.exitCode ? 'query-input: FAIL' : 'query-input: ALL PASS');
} finally { cleanup(); }
