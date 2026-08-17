import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
export const EVAL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));       // eval/graph-role
export const REPO_ROOT = resolve(EVAL_DIR, '..', '..');
export const DIST_INDEX = join(REPO_ROOT, 'dist', 'index.js');
const HOME = process.env.HOME;
export const CORPORA = {
  hub: { label: 'hub', live: `${HOME}/Library/CloudStorage/GoogleDrive-heesong.koh@gmail.com/My Drive/PARADocumentSystem/--1-PROJECTS/RAGMemory-Claude-memory-management-and-optimised-workflow/.memory/rag-memory.db` },
  uap: { label: 'uap', live: `${HOME}/Library/CloudStorage/GoogleDrive-heesong.koh@gmail.com/My Drive/PARADocumentSystem/--0-CollectLOG/Ultimate_AI_Personal_Assistant/.memory/rag-memory.db` },
  hal: { label: 'hal', live: `${HOME}/Development/Halal_Assistant_incubator_active/.memory/rag-memory.db` },
};
for (const c of Object.values(CORPORA)) c.copy = join(EVAL_DIR, 'dbs', `${c.label}.db`);
export const LIVE_PATHS = new Set(Object.values(CORPORA).map(c => resolve(c.live)));
export const dbFor = (label, cond = 'real') => cond === 'real' ? CORPORA[label].copy : join(EVAL_DIR, 'dbs', `${label}.${cond}.db`);
