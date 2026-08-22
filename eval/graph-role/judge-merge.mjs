import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './lib/paths.mjs';
import { weightedKappa } from './lib/metrics.mjs';
import { requiredItems } from './lib/pooling.mjs';
const label = process.argv[2]; const pass1Only = process.argv.includes('--pass1-only'); const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.meta);
// Fixed depth 10 + predeclared depth-30 subset (pass2-plan.json, from pool-pass2.mjs): `selected` = queries
// judged to depth 30 this run; every other query stops at depth 10. Ranks 31-100 (deep tier) are never judged
// in Stage 1 -- non-estimable, diagnostic-only via the separate deepsample file. --pass1-only: the plan file
// must still exist (fixed pipeline shape) but `selected` is ignored -- required items are top10 rows only.
const planP = join(EVAL_DIR, 'pool', `${label}.pass2-plan.json`);
if (!existsSync(planP)) { console.error('run pool-pass2 first'); process.exit(11); }
const plan = JSON.parse(readFileSync(planP, 'utf8'));
const selectedSet = new Set(plan.selected);
const all = readJsonl(join(EVAL_DIR, 'pool', `${label}.judge.jsonl`));
// Required items: every top10 row (always judged, fixed depth), plus top30 rows of selected queries only
// (top10 rows only under --pass1-only). Non-selected queries' top30 rows and every deep-tier row are
// always excluded from qrels. See lib/pooling.mjs#requiredItems.
const items = requiredItems(all, plan, { pass1Only });
const top10Rows = all.filter(i => i.tier === 'top10');   // diagnostic subset: the fixed-depth-10 pool alone
const A = new Map(readJsonl(join(EVAL_DIR, 'pool', `${label}.judge-A.jsonl`)).map(r => [r.jid, r.grade]));
const B = new Map(readJsonl(join(EVAL_DIR, 'pool', `${label}.judge-B.jsonl`)).map(r => [r.jid, r.grade]));
const Cp = join(EVAL_DIR, 'pool', `${label}.adjudicated.jsonl`); const C = existsSync(Cp) ? new Map(readJsonl(Cp).map(r => [r.jid, r.grade])) : new Map();
const missing = items.filter(i => !A.has(i.jid) || !B.has(i.jid)); if (missing.length) { console.error(`JUDGE_INCOMPLETE ${missing.length} items lack a grade`); process.exit(11); }
const kappaOf = (rows) => { const byClass = { all: [], A: [], M: [] }; for (const i of rows) { byClass.all.push([A.get(i.jid), B.get(i.jid)]); (byClass[i.class] ||= []).push([A.get(i.jid), B.get(i.jid)]); } const kap = {}; for (const [k, pairs] of Object.entries(byClass)) { if (!pairs.length) continue; kap[k] = +weightedKappa(pairs.map(p => p[0]), pairs.map(p => p[1])).toFixed(3); } return kap; };
const kap = kappaOf(items); let below = false;
for (const v of Object.values(kap)) if (v < th.kappa_gate_weighted) below = true;
console.log(`${label}: weighted kappa ${JSON.stringify(kap)} gate ${th.kappa_gate_weighted}`);
// Under --pass1-only, items IS the top10 pool -- same computation as the diagnostic below, so reuse `kap`.
console.log(`${label}: weighted kappa (pass1-only, depth 10, diagnostic) ${JSON.stringify(pass1Only ? kap : kappaOf(top10Rows))}`);
if (below) { console.error('KAPPA_BELOW_GATE'); process.exit(8); }
const disagreements = items.filter(i => A.get(i.jid) !== B.get(i.jid));
const unresolved = disagreements.filter(i => !C.has(i.jid));
if (unresolved.length) { writeFileSync(join(EVAL_DIR, 'pool', `${label}.to-adjudicate.jsonl`), unresolved.map(i => JSON.stringify({ ...i, grade_A: A.get(i.jid), grade_B: B.get(i.jid) })).join('\n') + '\n'); console.error(`ADJUDICATION_PENDING ${unresolved.length} of ${disagreements.length} disagreements -> pool/${label}.to-adjudicate.jsonl`); process.exit(12); }
const auditP = join(EVAL_DIR, 'suite', `human-audit.${label}.jsonl`); let grade = 'LLM-judged provisional', auditNote = 'no human audit';
if (existsSync(auditP)) { const H = readJsonl(auditP); const finalOf = (jid) => C.has(jid) ? C.get(jid) : A.get(jid); const dis = H.filter(h => finalOf(h.jid) !== h.grade).length; const rate = dis / H.length; auditNote = `human audit ${H.length} pairs, disagreement ${(rate * 100).toFixed(1)}%`; if (H.length >= th.human_audit.pairs_per_corpus && rate <= th.human_audit.max_disagreement_rate) grade = 'decision-grade'; }
const rows = items.map(i => { const a = A.get(i.jid), b = B.get(i.jid); const g = a === b ? a : C.get(i.jid); return { qid: i.qid, doc_id: i.doc_id, chunk_id: i.chunk_id, grade: g, judges: a === b ? [a, b] : [a, b, C.get(i.jid)], grade_source: a === b ? 'agree' : 'adjudicated', qrels_grade: grade, judged_depth: pass1Only ? 10 : (selectedSet.has(i.qid) ? 30 : 10), pool_truncated: true }; });
writeFileSync(join(EVAL_DIR, 'suite', `qrels.${label}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const pass2Note = pass1Only ? 'pass2 not judged (--pass1-only)' : `depth-30 queries ${plan.selected.length} · depth-10-only queries ${plan.not_selected.length}`;
console.log(`${label}: qrels ${rows.length} rows · ${grade} · ${auditNote} · disagreements ${disagreements.length} · ${pass2Note}`);
