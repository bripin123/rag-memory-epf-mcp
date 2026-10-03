#!/usr/bin/env node
// search-fusion-rrf (query input): with the DEFAULT model the model sees the raw text for queries and passages; a
// custom model keeps the legacy query instruction; the real loader is wired through makeEmbedFn; the init marker
// records 2 for the default model. Fails on 6.3.2 (no exports; the loader inlined the instruction for every model).
import { readFileSync } from 'node:fs';
import { makeManager, assert } from './helpers/engine-test-db.mjs';
const { manager: m, cleanup } = await makeManager();
try {
  const mod = await import('../dist/index.js');
  const L = mod.LEGACY_QUERY_INSTRUCTION;
  assert(typeof mod.embeddingInput === 'function' && typeof mod.makeEmbedFn === 'function' && typeof L === 'string', 'embeddingInput, makeEmbedFn and LEGACY_QUERY_INSTRUCTION are exported');
  for (const t of ['짧은 질문', 'conftest.py', '']) {
    assert(mod.embeddingInput?.(t, true) === t && mod.embeddingInput?.(t, true, true) === t, `default model: query input is the raw text (${JSON.stringify(t)})`);
    assert(mod.embeddingInput?.(t, false, true) === t && mod.embeddingInput?.(t, false, false) === t, `passage input is always raw (${JSON.stringify(t)})`);
    assert(mod.embeddingInput?.(t, true, false) === `${L}${t}`, `custom model: query keeps the legacy instruction (${JSON.stringify(t)})`);
  }
  // Wiring: a stub model records what the embed function actually feeds it.
  const seen = [];
  const stub = async (input) => { seen.push(input); return { data: new Float32Array(1024).fill(0.5) }; };
  const fnDefault = mod.makeEmbedFn?.(stub, true), fnCustom = mod.makeEmbedFn?.(stub, false);
  const v = await fnDefault?.('질문 하나', 1024, true); await fnDefault?.('문서 조각', 1024, false); await fnCustom?.('question one', 1024, true);
  assert(seen[0] === '질문 하나' && seen[1] === '문서 조각' && seen[2] === `${L}question one`, `stub model received raw / raw / legacy-instructed input (${JSON.stringify(seen)})`);
  assert(v instanceof Float32Array && v.length === 1024, 'embed function returns a Float32Array of the requested dims');
  const dist = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
  assert(/return makeEmbedFn\(model, IS_DEFAULT_MODEL_CONFIG\)/.test(dist), 'the real loader returns makeEmbedFn(model, IS_DEFAULT_MODEL_CONFIG)');
  const row = m.db.prepare(`SELECT value FROM server_meta WHERE key='query_prefix_version'`).get();
  assert(row?.value === '2', `init marker query_prefix_version = 2 for the default model (${row?.value})`);
  console.log(process.exitCode ? 'query-input: FAIL' : 'query-input: ALL PASS');
} finally { cleanup(); }
