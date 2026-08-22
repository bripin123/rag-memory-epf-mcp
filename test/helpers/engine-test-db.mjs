// Shared test harness: isolated temp DB + manager without the heavy embedding model.
// IMPORTANT: DB_FILE_PATH is read once at module load (index.ts), and Node caches
// the module per process. So call makeManager() at most ONCE per test process,
// and run each test file as its own `node` invocation.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export async function makeManager() {
  const dir = mkdtempSync(join(tmpdir(), 'ragmem-test-'));
  const dbPath = join(dir, 'test.db');
  process.env.DB_FILE_PATH = dbPath;           // must be set BEFORE the import below
  process.env.RAG_MEMORY_NO_AUTOSTART = '1';   // suppress stdio server boot on import
  const mod = await import('../../dist/index.js');
  const manager = new mod.RAGKnowledgeGraphManager();
  await manager.initialize({ skipModel: true }); // DB + migrations, NO embedding model
  const cleanup = () => {
    try { manager.cleanup(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return { manager, dbPath, dir, cleanup };
}

// Install a deterministic fake embedder so embedding-dependent paths run without
// loading bge-m3. v3.6: the model lives behind an EmbeddingGate — we swap in a
// pre-started fake gate (runtime JS exposes TS-private fields, so forcing the
// ready state keeps this helper synchronous for existing tests).
export function installFakeEmbedder(manager) {
  const counter = { calls: 0 };
  const gate = manager.gate;
  gate.state = 'ready';
  gate.shuttingDown = false;
  gate.embedFn = async (text) => {
    counter.calls++;
    const v = new Float32Array(1024);
    // Text-sensitive but deterministic — distinct texts get distinct vectors.
    for (let i = 0; i < text.length; i++) v[i % 1024] += text.charCodeAt(i) / 1000;
    v[0] += 0.01;
    return v;
  };
  manager.embeddingCache = new Map();
  return counter;
}

export function simulateModelDown(manager) {
  const gate = manager.gate;
  gate.state = 'idle';           // not-ready: gate.embed rejects GateNotReadyError
  gate.embedFn = null;
  manager.embeddingCache = new Map(); // drop cached query embeddings so the down path is actually exercised
}

function assert(cond, msg) {
  if (!cond) { console.error(`  FAIL: ${msg}`); process.exitCode = 1; return false; }
  console.log(`  OK: ${msg}`); return true;
}
export { assert };

// Controlled embedder: exact unit vectors for known texts (fixture design needs cosines at
// the 0.4-similarity threshold). sim = 1 - L2/2 on unit vectors  =>  sim > 0.4  <=>  cos > 0.28.
export function axisVec(cos, axis = 1) {
  const v = new Float32Array(1024);
  v[0] = cos; v[axis] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}
export function installControlledEmbedder(manager, table) {
  const counter = { calls: 0 };
  const gate = manager.gate;
  gate.state = 'ready'; gate.shuttingDown = false;
  gate.embedFn = async (text) => {
    counter.calls++;
    const hit = table.get(text);
    if (hit) return hit;
    const v = new Float32Array(1024);
    for (let i = 0; i < text.length; i++) v[i % 1024] += text.charCodeAt(i) / 1000;
    v[0] += 0.01;
    return v;
  };
  manager.embeddingCache = new Map();
  return counter;
}
