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
// loading bge-m3. TS `private` fields are erased at runtime (compiled JS exposes
// them as plain properties), so direct assignment works from a .mjs test.
export function installFakeEmbedder(manager) {
  const counter = { calls: 0 };
  manager.embeddingModel = async (_text) => {
    counter.calls++;
    return { data: new Float32Array(1024).fill(0.01) }; // bge-m3 is 1024-dim
  };
  manager.modelInitialized = true;
  return counter;
}

export function simulateModelDown(manager) {
  manager.embeddingModel = null;
  manager.modelInitialized = false;
  manager.embeddingCache = new Map(); // drop cached query embeddings so the down path is actually exercised
}

function assert(cond, msg) {
  if (!cond) { console.error(`  FAIL: ${msg}`); process.exitCode = 1; return false; }
  console.log(`  OK: ${msg}`); return true;
}
export { assert };
