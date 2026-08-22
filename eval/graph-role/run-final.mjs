import { readFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openCorpus, exitOnRefuse } from './lib/db.mjs';
import { CORPORA, EVAL_DIR, dbFor } from './lib/paths.mjs';
import { assertFrozen } from './lib/freeze.mjs';
const args = process.argv.slice(2); const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const label = get('--corpus'), cond = get('--cond', 'real'), split = get('--split', 'dev'), unfrozenFlag = args.includes('--unfrozen');
if (!CORPORA[label]) { console.error('usage: run-final.mjs --corpus <c> [--cond ...] [--split dev|holdout] [--unfrozen]'); process.exit(2); }
const { frozen } = assertFrozen({ rel: `queries.${label}.jsonl`, allowUnfrozen: unfrozenFlag });
const now = () => Number(process.hrtime.bigint() / 1000000n);
const comp = (r) => ({ chunk_id: r.chunk_id, doc: r.source_id ?? null, vs: +(r.vector_similarity ?? 0).toFixed(4), gb: r.graph_boost === undefined ? null : +r.graph_boost.toFixed(4), fts: +(r.fts_boost ?? 0).toFixed(4), fin: +(r.relevance_score ?? 0).toFixed(4) });
await exitOnRefuse(async () => {
  const { m, log, close } = await openCorpus({ dbPath: dbFor(label, cond), label });
  const rows = readFileSync(join(EVAL_DIR, 'suite', `queries.${label}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.split === split);
  mkdirSync(join(EVAL_DIR, 'out'), { recursive: true });
  const outPath = join(EVAL_DIR, 'out', `final.${label}.${cond}.jsonl`); if (existsSync(outPath)) unlinkSync(outPath);
  let i = 0;
  for (const r of rows) {
    i++;
    // Fix round 1: the manager caches query embeddings per process, so the FIRST call for a text
    // paid for the embedding and every later call did not — off vs on was never like-for-like.
    // Burn that cost here (recorded, not compared), then time off and on both warm.
    let t = now(); await m.hybridSearch(r.text, 10, false); const msCold = now() - t;
    t = now(); const off = await m.hybridSearch(r.text, 10, false); const msOff = now() - t;   // warm
    t = now(); const on = await m.hybridSearch(r.text, 10, true); const msOn = now() - t;      // warm
    // fixed-pool rerank: pool = product graph-off top-30; "with_graph" reorders that same pool by the product's useGraph:true score
    t = now(); const off30 = await m.hybridSearch(r.text, 30, false); const on30 = await m.hybridSearch(r.text, 30, true);
    const onScore = new Map(on30.results.map(x => [x.chunk_id, x.relevance_score]));
    const base = off30.results.map(x => x.chunk_id);
    const withGraph = off30.results.map(x => ({ id: x.chunk_id, s: onScore.get(x.chunk_id) ?? x.relevance_score })).sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1)).map(x => x.id);
    const msRerank = now() - t;
    const rec = { id: r.id, class: r.class, split: r.split, cond, off: { top10: off.results.map(comp), ms: msOff }, on: { top10: on.results.map(comp), ms: msOn }, fixedpool_rerank: { base: base.slice(0, 10), with_graph: withGraph.slice(0, 10), pool_n: base.length, ms: msRerank }, mode: on.search_mode, cold: { ms: msCold, first: i === 1 }, unfrozen: !frozen };
    appendFileSync(outPath, JSON.stringify(rec) + '\n');
    log(`[${label}/${cond}] final ${i}/${rows.length} ${r.id} ms cold/off/on=${msCold}/${msOff}/${msOn}`);
  }
  close(); log(`DONE ${outPath} rows=${i}`);
});
