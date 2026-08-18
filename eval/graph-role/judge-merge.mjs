import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './lib/paths.mjs';
import { weightedKappa } from './lib/metrics.mjs';
const label = process.argv[2]; const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.meta);
// D2: deep-plan.json (from pool-deep.mjs) says which queries' deep tier was actually judged (qualifying minus truncated).
const planP = join(EVAL_DIR, 'pool', `${label}.deep-plan.json`);
if (!existsSync(planP)) { console.error('run pool-deep first'); process.exit(11); }
const plan = JSON.parse(readFileSync(planP, 'utf8'));
const truncatedSet = new Set(plan.truncated);
const planned = new Set(plan.qualifying.filter(qid => !truncatedSet.has(qid)));
const all = readJsonl(join(EVAL_DIR, 'pool', `${label}.judge.jsonl`));
// Required items: every top30 row, plus deep rows only for queries whose deep tier was planned (qualifying, not truncated).
const items = all.filter(i => i.tier === 'top30' || planned.has(i.qid));
const A = new Map(readJsonl(join(EVAL_DIR, 'pool', `${label}.judge-A.jsonl`)).map(r => [r.jid, r.grade]));
const B = new Map(readJsonl(join(EVAL_DIR, 'pool', `${label}.judge-B.jsonl`)).map(r => [r.jid, r.grade]));
const Cp = join(EVAL_DIR, 'pool', `${label}.adjudicated.jsonl`); const C = existsSync(Cp) ? new Map(readJsonl(Cp).map(r => [r.jid, r.grade])) : new Map();
const missing = items.filter(i => !A.has(i.jid) || !B.has(i.jid)); if (missing.length) { console.error(`JUDGE_INCOMPLETE ${missing.length} items lack a grade`); process.exit(11); }
const byClass = { all: [], A: [], M: [] };
for (const i of items) { byClass.all.push([A.get(i.jid), B.get(i.jid)]); (byClass[i.class] ||= []).push([A.get(i.jid), B.get(i.jid)]); }
const kap = {}; let below = false;
for (const [k, pairs] of Object.entries(byClass)) { if (!pairs.length) continue; kap[k] = +weightedKappa(pairs.map(p => p[0]), pairs.map(p => p[1])).toFixed(3); if (kap[k] < th.kappa_gate_weighted) below = true; }
console.log(`${label}: weighted kappa ${JSON.stringify(kap)} gate ${th.kappa_gate_weighted}`);
if (below) { console.error('KAPPA_BELOW_GATE'); process.exit(8); }
const disagreements = items.filter(i => A.get(i.jid) !== B.get(i.jid));
const unresolved = disagreements.filter(i => !C.has(i.jid));
if (unresolved.length) { writeFileSync(join(EVAL_DIR, 'pool', `${label}.to-adjudicate.jsonl`), unresolved.map(i => JSON.stringify({ ...i, grade_A: A.get(i.jid), grade_B: B.get(i.jid) })).join('\n') + '\n'); console.error(`ADJUDICATION_PENDING ${unresolved.length} of ${disagreements.length} disagreements -> pool/${label}.to-adjudicate.jsonl`); process.exit(12); }
const auditP = join(EVAL_DIR, 'suite', `human-audit.${label}.jsonl`); let grade = 'LLM-judged provisional', auditNote = 'no human audit';
if (existsSync(auditP)) { const H = readJsonl(auditP); const finalOf = (jid) => C.has(jid) ? C.get(jid) : A.get(jid); const dis = H.filter(h => finalOf(h.jid) !== h.grade).length; const rate = dis / H.length; auditNote = `human audit ${H.length} pairs, disagreement ${(rate * 100).toFixed(1)}%`; if (H.length >= th.human_audit.pairs_per_corpus && rate <= th.human_audit.max_disagreement_rate) grade = 'decision-grade'; }
const rows = items.map(i => { const a = A.get(i.jid), b = B.get(i.jid); const g = a === b ? a : C.get(i.jid); return { qid: i.qid, doc_id: i.doc_id, chunk_id: i.chunk_id, grade: g, judges: a === b ? [a, b] : [a, b, C.get(i.jid)], grade_source: a === b ? 'agree' : 'adjudicated', qrels_grade: grade, pool_truncated: truncatedSet.has(i.qid) }; });
writeFileSync(join(EVAL_DIR, 'suite', `qrels.${label}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`${label}: qrels ${rows.length} rows · ${grade} · ${auditNote} · disagreements ${disagreements.length} · deep planned ${plan.pass2_rows} · truncated queries ${plan.truncated.length}`);
