import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './lib/paths.mjs';
import { planDeep } from './lib/pooling.mjs';
const label = process.argv[2];
if (!label) { console.error('usage: pool-deep.mjs <corpus>'); process.exit(2); }
const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.meta);
const poolP = join(EVAL_DIR, 'pool', `${label}.pool.jsonl`), judgeP = join(EVAL_DIR, 'pool', `${label}.judge.jsonl`);
if (!existsSync(poolP) || !existsSync(judgeP)) { console.error('POOL_INCOMPLETE run pool.mjs first'); process.exit(7); }
const poolRows = readJsonl(poolP);
const judgeRows = readJsonl(judgeP);
const Ap = join(EVAL_DIR, 'pool', `${label}.judge-A.jsonl`), Bp = join(EVAL_DIR, 'pool', `${label}.judge-B.jsonl`);
const missingJudgeFiles = [Ap, Bp].filter(p => !existsSync(p));
if (missingJudgeFiles.length) { console.error(`JUDGE_INCOMPLETE missing ${missingJudgeFiles.map(p => p.split('/').pop()).join(', ')}`); process.exit(11); }
const A = new Map(readJsonl(Ap).map(r => [r.jid, r.grade]));
const B = new Map(readJsonl(Bp).map(r => [r.jid, r.grade]));
const Cp = join(EVAL_DIR, 'pool', `${label}.adjudicated.jsonl`); const C = existsSync(Cp) ? new Map(readJsonl(Cp).map(r => [r.jid, r.grade])) : new Map();
// Pass-1 grades only: every top30 row must already have both A and B before deep planning can run.
const top30 = judgeRows.filter(r => r.tier === 'top30');
const missing = top30.filter(r => !A.has(r.jid) || !B.has(r.jid));
if (missing.length) { console.error(`JUDGE_INCOMPLETE ${missing.length} top30 items lack a grade`); process.exit(11); }
// Conservative grade per item: adjudicated when present, else max(A, B) -- disagreements never lower the saturation test.
const grades = new Map(top30.map(r => [r.jid, C.has(r.jid) ? C.get(r.jid) : Math.max(A.get(r.jid), B.get(r.jid))]));
const plan = planDeep({ poolRows, judgeRows, grades, budget: th.judging_budget_per_corpus });
const pass2Set = new Set(plan.pass2_jids);
const pass2Rows = judgeRows.filter(r => pass2Set.has(r.jid));   // same blind shape as judge.jsonl, judge.jsonl order preserved by filter
writeFileSync(join(EVAL_DIR, 'pool', `${label}.judge-pass2.jsonl`), pass2Rows.map(r => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(join(EVAL_DIR, 'pool', `${label}.deep-plan.json`), JSON.stringify({ qualifying: plan.qualifying, truncated: plan.truncated, pass1_rows: plan.pass1_rows, pass2_rows: plan.pass2_rows, budget: th.judging_budget_per_corpus }, null, 2) + '\n');
console.log(`${label}: deep-plan qualifying ${plan.qualifying.length} truncated ${plan.truncated.length} pass1_rows ${plan.pass1_rows} pass2_rows ${plan.pass2_rows} budget ${th.judging_budget_per_corpus}`);
