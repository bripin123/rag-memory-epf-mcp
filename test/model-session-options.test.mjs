// The real model loader must open the ONNX session with the CPU memory arena off.
// With the arena on, one long input left the process holding its peak (1.4 → 8.0 GB,
// measured 2026-10-31). This drives the PRODUCT loader (buildRealLoader) with a fake
// pipeline and checks the arguments it passes — a constant check alone would still
// pass if the call site stopped using it. No network, temp DB + temp model cache only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const dir = mkdtempSync(join(tmpdir(), 'rag-session-opts-'));
process.env.DB_FILE_PATH = join(dir, 't.db');
process.env.RAG_MEMORY_MODEL_CACHE_DIR = join(dir, 'cache'); // never the user cache
const { RAGKnowledgeGraphManager, MODEL_SESSION_OPTIONS, setPipelineImpl } = await import('../dist/index.js');
const { EmbeddingGate } = await import('../dist/src/embeddingGate.js');

const calls = [];
setPipelineImpl(async (...args) => {
  calls.push(args);
  return async () => ({ data: new Float32Array(1024).fill(1 / 32) });
});

try {
  const blocked = new EmbeddingGate({ mode: 'lazy', loadModel: () => new Promise(() => {}) });
  const mgr = new RAGKnowledgeGraphManager();
  await mgr.initialize({ gate: blocked });
  const embed = await mgr.buildRealLoader();
  assert.equal(typeof embed, 'function', 'loader must return an embed function');

  assert.equal(calls.length, 1, 'loader must call pipeline exactly once');
  const [task, model, opts] = calls[0];
  assert.equal(task, 'feature-extraction');
  assert.equal(model, 'Xenova/bge-m3');
  assert.equal(opts.revision, '4de13258303883538bd53b696b452bf8099f0858');
  assert.equal(opts.dtype, 'fp16');
  assert.equal(opts.cache_dir, process.env.RAG_MEMORY_MODEL_CACHE_DIR);
  assert.equal(opts.session_options?.enableCpuMemArena, false, 'CPU memory arena must be off');
  assert.equal(MODEL_SESSION_OPTIONS.enableCpuMemArena, false);
  assert.ok(Object.isFrozen(MODEL_SESSION_OPTIONS), 'shared options must not be mutable');
  assert.notEqual(opts.session_options, MODEL_SESSION_OPTIONS, 'pass a copy, not the shared object');
  console.log('  OK: real loader opens the session with enableCpuMemArena=false');

  mgr.cleanup();
} finally {
  setPipelineImpl(null);
  rmSync(dir, { recursive: true, force: true });
}
console.log('model-session-options: ALL PASS');
