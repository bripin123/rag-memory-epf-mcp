import { readFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openCorpus, exitOnRefuse } from './lib/db.mjs';
import { CORPORA, EVAL_DIR, dbFor } from './lib/paths.mjs';
import { assertFrozen } from './lib/freeze.mjs';
import { channelsForQuery } from './lib/stages.mjs';
const args = process.argv.slice(2); const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const label = get('--corpus'), cond = get('--cond', 'real'), split = get('--split', 'dev'), unfrozenFlag = args.includes('--unfrozen');
if (!CORPORA[label]) { console.error('usage: run-candidates.mjs --corpus <c> [--cond real|shuffled-rN|typeshuf-rN|random] [--split dev|holdout] [--unfrozen]'); process.exit(2); }
const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const { frozen } = assertFrozen({ rel: `queries.${label}.jsonl`, allowUnfrozen: unfrozenFlag });
assertFrozen({ rel: '../thresholds.json', allowUnfrozen: unfrozenFlag });
await exitOnRefuse(async () => {
  const { m, db, log, fallbackHits, close } = await openCorpus({ dbPath: dbFor(label, cond), label });
  const rows = readFileSync(join(EVAL_DIR, 'suite', `queries.${label}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.split === split);
  mkdirSync(join(EVAL_DIR, 'out'), { recursive: true });
  const outPath = join(EVAL_DIR, 'out', `candidates.${label}.${cond}.jsonl`); if (existsSync(outPath)) unlinkSync(outPath);
  let i = 0;
  for (const r of rows) {
    i++; const fb0 = fallbackHits();
    const c = await channelsForQuery({ m, db, query: r.text, Ks: th.budgets_K, n2cap: th.controls.n2_fanout_cap });
    const rec = { id: r.id, class: r.class, split: r.split, cond, seam_status: c.seam.status, seeds: c.seeds.map(s => ({ name: s.name, sim: +s.similarity.toFixed(4) })), n_connected: c.n_connected, n2_count: c.n2_count,
                  channels: Object.fromEntries(Object.entries(c.channels).map(([k, v]) => [k, { chunk10: v.chunk[10], chunk30: v.chunk[30], chunk100: v.chunk[100], doc10: v.doc[10], doc30: v.doc[30], doc100: v.doc[100], ms: v.ms }])),
                  reach: { chunks: c.reach.chunks, docs_n: c.reach.docs.length }, fallback: fallbackHits() - fb0, unfrozen: !frozen };
    appendFileSync(outPath, JSON.stringify(rec) + '\n');
    log(`[${label}/${cond}] ${i}/${rows.length} ${r.id} seeds=${c.seeds.length} n1=${c.n_connected} n2=${c.n2_count} reach=${c.reach.chunks}`);
  }
  close(); log(`DONE ${outPath} rows=${i}`);
});
