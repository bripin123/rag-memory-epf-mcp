// Post-hoc pure-vector channel (T5a review I1 ruling): the harness `vector` channel is
// hybridSearch(q, K, false) = vector OR FTS-boost — the product base ranking, not pure vector.
// This runner adds the real, graph-independent raw vector scan the ablation actually wants:
// purevec (raw ANN distance order), fts (same BM25 path as stages.mjs), and their RRF fusion.
// Real copy only (no --cond) — the channel does not touch the graph, so shuffled/typeshuf/random
// controls add nothing over `real`.
import { readFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openCorpus, exitOnRefuse } from './lib/db.mjs';
import { CORPORA, EVAL_DIR, DIST_INDEX, dbFor } from './lib/paths.mjs';
import { assertFrozen } from './lib/freeze.mjs';
import { applyBudgets } from './lib/stages.mjs';
import { rrf } from './lib/rrf.mjs';
import { orderByDistance } from './lib/purevec.mjs';

const args = process.argv.slice(2); const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const label = get('--corpus'), split = get('--split', 'dev'), unfrozenFlag = args.includes('--unfrozen');
if (!CORPORA[label]) { console.error('usage: run-purevec.mjs --corpus <c> [--split dev|holdout] [--unfrozen]'); process.exit(2); }
const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const { frozen } = assertFrozen({ rel: `queries.${label}.jsonl`, allowUnfrozen: unfrozenFlag });
assertFrozen({ rel: '../thresholds.json', allowUnfrozen: unfrozenFlag });
// Ruling: k = KMAX (100) — same list length as the harness `vector` channel (hybridSearch(q, KMAX)),
// so doc100 from both channels is cut from a <=100-chunk list. Do not widen k.
const KMAX = Math.max(...th.budgets_K);
const now = () => Number(process.hrtime.bigint() / 1000000n);
// Copied verbatim (caching pattern + import) from lib/stages.mjs's ftsCompiler — do not import
// channelsForQuery itself, it calls the seam (graph).
let compileFts = null;
async function ftsCompiler() { if (!compileFts) { const mod = await import(DIST_INDEX); compileFts = mod.compileFtsLiteralQuery; } return compileFts; }

await exitOnRefuse(async () => {
  const { m, db, log, close } = await openCorpus({ dbPath: dbFor(label, 'real'), label });
  const rows = readFileSync(join(EVAL_DIR, 'suite', `queries.${label}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.split === split);
  mkdirSync(join(EVAL_DIR, 'out'), { recursive: true });
  const outPath = join(EVAL_DIR, 'out', `purevec.${label}.jsonl`); if (existsSync(outPath)) unlinkSync(outPath);
  // docOf lookup copied verbatim from stages.mjs's channelsForQuery.
  const docOfStmt = db.prepare(`SELECT document_id FROM chunk_metadata WHERE chunk_id = ?`); const docCache = new Map();
  const docOf = (id) => { if (!docCache.has(id)) docCache.set(id, docOfStmt.get(id)?.document_id ?? id); return docCache.get(id); };
  let i = 0;
  for (const r of rows) {
    i++;
    // Untimed warm-up as in stages.mjs — this is *the* embedding the raw scan below reuses.
    let t = now(); const qEmb = await m.generateEmbedding(r.text, 1024, true); const embed_ms = now() - t;
    const ms = {};
    // purevec: raw vector scan copied verbatim from stages.mjs's graph-vec SQL, but k = KMAX
    // (graph-vec there uses Math.min(4096, Math.max(KMAX * 10, gN1.length)) — we do not; see ruling above).
    t = now();
    const rawRows = db.prepare(`SELECT cm.chunk_id, c.distance FROM chunks c JOIN chunk_metadata cm ON cm.rowid = c.rowid WHERE c.embedding MATCH ? AND k = ?`).all(Buffer.from(qEmb.buffer), KMAX);
    const purevecIds = orderByDistance(rawRows);
    ms.purevec = now() - t;
    // fts: copied verbatim from stages.mjs's fts channel (compileFtsLiteralQuery + LIMIT KMAX).
    t = now();
    const compile = await ftsCompiler(); const ftsExpr = compile ? compile(r.text) : null;
    const ftsIds = ftsExpr ? db.prepare(`SELECT cm.chunk_id FROM chunks_fts JOIN chunk_metadata cm ON chunks_fts.rowid = cm.rowid WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`).all(ftsExpr, KMAX).map(x => x.chunk_id) : [];
    ms.fts = now() - t;
    const rrfIds = rrf([purevecIds, ftsIds]).map(x => x.id);
    const chans = { purevec: purevecIds, fts: ftsIds, 'rrf-purevec-fts': rrfIds };
    const channels = {};
    for (const [name, ids] of Object.entries(chans)) {
      const b = applyBudgets(ids, th.budgets_K, docOf);
      channels[name] = { chunk10: b.chunk[10], chunk30: b.chunk[30], chunk100: b.chunk[100], doc10: b.doc[10], doc30: b.doc[30], doc100: b.doc[100], ms: name === 'rrf-purevec-fts' ? null : ms[name] };
    }
    const rec = { id: r.id, class: r.class, split: r.split, cond: 'real', embed_ms, channels, unfrozen: !frozen };
    appendFileSync(outPath, JSON.stringify(rec) + '\n');
    log(`[${label}/real] purevec ${i}/${rows.length} ${r.id} embed_ms=${embed_ms} purevec_ms=${ms.purevec} fts_ms=${ms.fts}`);
  }
  close(); log(`DONE ${outPath} rows=${i}`);
});
