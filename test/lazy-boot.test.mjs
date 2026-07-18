// Lazy boot verification: initialize() completes without awaiting the model,
// mode matrix (lazy/off), fake-gate injection seam. Spec §3·§9, DoD 1/5.
// No network, temp DB + temp model cache only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const dir = mkdtempSync(join(tmpdir(), 'rag-boot-'));
process.env.DB_FILE_PATH = join(dir, 't.db');
process.env.RAG_MEMORY_MODEL_CACHE_DIR = join(dir, 'cache'); // never the user cache
const { RAGKnowledgeGraphManager } = await import('../dist/index.js');
const { EmbeddingGate } = await import('../dist/src/embeddingGate.js');

// (a) lazy: initialize completes while an injected loader blocks forever
{
  const blocked = new EmbeddingGate({ mode: 'lazy', loadModel: () => new Promise(() => {}) });
  const mgr = new RAGKnowledgeGraphManager();
  const t0 = Date.now();
  await mgr.initialize({ gate: blocked });
  assert.ok(Date.now() - t0 < 3000, 'initialize blocked on model load');
  assert.equal(mgr.gate.status.state, 'idle', 'gate must stay idle until main() starts it');
  assert.equal(mgr.embeddingsMode, 'lazy');
  assert.ok(mgr.currentProfileId > 0, 'current profile not ensured');
  mgr.cleanup();
  console.log('  OK: lazy initialize does not await the model');
}

// (b) off mode -> disabled gate
{
  process.env.RAG_MEMORY_EMBEDDINGS = 'off';
  const mgr = new RAGKnowledgeGraphManager();
  await mgr.initialize({});
  assert.equal(mgr.embeddingsMode, 'off');
  assert.equal(mgr.gate.status.state, 'disabled');
  mgr.cleanup();
  delete process.env.RAG_MEMORY_EMBEDDINGS;
  console.log('  OK: RAG_MEMORY_EMBEDDINGS=off -> disabled gate');
}

// (c) skipModel seam behaves like off (back-compat for existing tests)
{
  const mgr = new RAGKnowledgeGraphManager();
  await mgr.initialize({ skipModel: true });
  assert.equal(mgr.gate.status.state, 'disabled');
  mgr.cleanup();
  console.log('  OK: skipModel seam preserved');
}

rmSync(dir, { recursive: true, force: true });
console.log('LAZY-BOOT OK');
