import { resolve } from 'node:path';
import { LIVE_PATHS, DIST_INDEX } from './paths.mjs';
export class RefuseLiveDb extends Error {}
export async function openCorpus({ dbPath, label }) {
  const abs = resolve(dbPath);
  if (LIVE_PATHS.has(abs)) throw new RefuseLiveDb(`REFUSE_LIVE_DB ${abs}`);
  process.env.DB_FILE_PATH = abs;                                   // read once at import — one corpus per process
  process.env.RAG_MEMORY_NO_AUTOSTART = '1';
  process.env.RAG_MEMORY_SEARCH_SUMMARIES = 'off';                  // R10: isolate incident C
  const mod = await import(DIST_INDEX);
  const m = new mod.RAGKnowledgeGraphManager();
  await m.initialize();
  // gate.start() only resolves at state 'ready' — on failure (terminal-config or generic,
  // src/embeddingGate.ts loadOnce()) it rethrows. Unwrapped, that surfaces as an unhandled
  // rejection instead of the MODEL_NOT_READY contract (README exit 9). Wrap it; the isReady
  // check below stays as belt-and-braces for any future resolve-but-not-ready path.
  try { await m.gate.start(); } catch (e) { console.error(`ABORT model_not_ready state=${m.gate.status?.state} err=${e instanceof Error ? e.message : String(e)}`); process.exit(9); }
  try { await m.startReconciliation(); } catch {}
  if (!m.gate.isReady) { console.error(`ABORT model_not_ready state=${m.gate.status?.state}`); process.exit(9); }
  let fallbackHits = 0;
  const _err = console.error.bind(console);
  console.error = (...a) => { const s = a.map(String).join(' '); if (s.includes('Entity vector search for graph enhancement failed')) fallbackHits++; if (process.env.PROBE_QUIET !== '0') return; _err(...a); };
  return { m, db: m.db, label, fallbackHits: () => fallbackHits, log: _err, close: () => { try { m.cleanup(); } catch {} } };
}
export function exitOnRefuse(fn) { return fn().catch(e => { if (e instanceof RefuseLiveDb) { console.error(e.message); process.exit(4); } throw e; }); }
