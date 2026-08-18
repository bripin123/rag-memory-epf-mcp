import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './lib/paths.mjs';
import { planPass2 } from './lib/pooling.mjs';
const label = process.argv[2];
if (!label) { console.error('usage: pool-pass2.mjs <corpus>'); process.exit(2); }
const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const judgeP = join(EVAL_DIR, 'pool', `${label}.judge.jsonl`);
if (!existsSync(judgeP)) { console.error('POOL_INCOMPLETE run pool.mjs first'); process.exit(7); }
const judgeRows = readJsonl(judgeP);
const corpusIndex = { hub: 0, uap: 1, hal: 2 }[label];
const seed = th.bootstrap.seed + 200 + corpusIndex;
// Predeclared: this plan depends only on pool.mjs's output (tiers/classes/qids) and the seed -- no judge
// output exists yet or is needed. It must run right after pool.mjs, before any judging starts, so pass 2's
// coverage cannot be biased by pass-1 outcomes.
const plan = planPass2({ judgeRows, budget: th.judging_budget_per_corpus, seed });
const { pass2_jids, ...planWithoutJids } = plan;
const pass2Set = new Set(pass2_jids);
const pass2Rows = judgeRows.filter(r => pass2Set.has(r.jid));   // same blind shape as judge.jsonl, judge.jsonl order preserved by filter
writeFileSync(join(EVAL_DIR, 'pool', `${label}.judge-pass2.jsonl`), pass2Rows.map(r => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(join(EVAL_DIR, 'pool', `${label}.pass2-plan.json`), JSON.stringify({ ...planWithoutJids, seed, generated_at: new Date().toISOString() }, null, 2) + '\n');
console.log(`${label}: pass2-plan selected ${plan.selected.length} skipped_budget ${plan.skipped_budget.length} (A ${plan.per_class.A.selected.length}/${plan.per_class.A.candidates.length} · M ${plan.per_class.M.selected.length}/${plan.per_class.M.candidates.length}) pass1_rows ${plan.pass1_rows} pass2_rows ${plan.pass2_rows} budget ${plan.budget} remaining_after ${plan.remaining_after}`);
