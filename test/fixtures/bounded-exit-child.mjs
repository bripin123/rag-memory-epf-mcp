// Fixture child for bounded-exit verification (beta 3R M2): a never-settling
// injected loader keeps gate.loadInFlight true past the settle deadline, so
// shutdownAll must take the spec §3 exception path (bounded process.exit after
// DB close). Run as its own process because it terminates itself.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const dir = mkdtempSync(join(tmpdir(), 'rag-bexit-'));
process.env.DB_FILE_PATH = join(dir, 't.db');
process.env.RAG_MEMORY_MODEL_CACHE_DIR = join(dir, 'cache');

const { RAGKnowledgeGraphManager } = await import('../../dist/index.js');
const { EmbeddingGate } = await import('../../dist/src/embeddingGate.js');

const never = new EmbeddingGate({ mode: 'lazy', loadModel: () => new Promise(() => {}) });
const mgr = new RAGKnowledgeGraphManager();
await mgr.initialize({ gate: never });
void never.start().catch(() => {});
await new Promise(r => setTimeout(r, 100));
console.error('CHILD: invoking shutdownAll with load pending');
await mgr.shutdownAll();            // must bounded-exit; the next line must never run
console.error('CHILD: STILL ALIVE AFTER shutdownAll — bounded exit branch missing');
setInterval(() => {}, 1000);        // hold the loop to make a missing exit observable
