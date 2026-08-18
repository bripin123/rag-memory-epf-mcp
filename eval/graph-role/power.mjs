#!/usr/bin/env node
// eval/graph-role/power.mjs — pilot variance -> holdout N -> suite/POWER.md.
//
// Reads suite/ and out/ only: no DB, no engine, and nothing under pool/ (judging
// may be running). Runs with or without qrels: every endpoint is reported under
// each gold source that can support it, and an endpoint that is not estimable
// says so instead of being extrapolated.
//
// POWER.md must be frozen (hash into suite/FREEZE.md) BEFORE the holdout is
// opened — this script writes the file; freezing is the controller's step.
//
// Exit codes: 2 usage · 17 REPORT_INPUT_MISSING.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './lib/paths.mjs';
import * as M from './lib/metrics.mjs';

const args = process.argv.slice(2);
if (args.length) { console.error('usage: power.mjs   (no arguments — reads suite/ and out/ only)'); process.exit(2); }

const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const P = (...p) => join(EVAL_DIR, ...p);
const readJsonl = (p) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const f3 = (x) => (x === null || x === undefined || Number.isNaN(x)) ? 'n/a' : x.toFixed(3);
const f2 = (x) => (x === null || x === undefined || Number.isNaN(x)) ? 'n/a' : x.toFixed(2);
const CORPORA = ['hub', 'uap', 'hal'];

// Pass-1 judging cost per query, re-derived from out/ (pool/ is never read).
// Mirrors pool.mjs's `top10` tier: A+M rows only, union over
// {real, shuffled-r0, random} x 9 channels' chunk10, plus final off/on/fixedpool
// top-10, plus purevec's channels when that file exists.
function pass1PoolCost(label) {
  const need = ['real', 'shuffled-r0', 'random'];
  const per = new Map();
  const add = (qid, ids) => { const s = per.get(qid) || per.set(qid, new Set()).get(qid); for (const id of ids) if (id) s.add(id); };
  for (const c of need) {
    const cp = P('out', `candidates.${label}.${c}.jsonl`), fp = P('out', `final.${label}.${c}.jsonl`);
    if (!existsSync(cp) || !existsSync(fp)) return null;
    for (const r of readJsonl(cp)) { if (r.class === 'K') continue; for (const ch of Object.values(r.channels)) add(r.id, ch.chunk10); }
    for (const r of readJsonl(fp)) { if (r.class === 'K') continue; add(r.id, r.off.top10.map(x => x.chunk_id)); add(r.id, r.on.top10.map(x => x.chunk_id)); add(r.id, r.fixedpool_rerank.with_graph); }
  }
  const pv = P('out', `purevec.${label}.jsonl`);
  if (existsSync(pv)) for (const r of readJsonl(pv)) { if (r.class === 'K') continue; for (const ch of Object.values(r.channels)) add(r.id, ch.chunk10); }
  let total = 0; for (const s of per.values()) total += s.size;
  return per.size ? { queries: per.size, judgements: total, perQuery: total / per.size } : null;
}

const out = [];
const line = (s) => out.push(s);

line('# POWER — holdout N from Stage 1 pilot variance');
line('');
line('**Freeze this file (and `thresholds.json`) into `suite/FREEZE.md` before the holdout is opened** (spec R9). Stage 1 is a pilot for variance, not for conclusions; nothing in this file is an outcome.');
line('');
line(`Target power ${th.power.target} · alpha ${th.power.alpha} (two-sided) · MCID candidate Δrecall@30(doc) ${th.MCID_candidate_recall30_doc} · MCID rerank ΔnDCG@10 ${th.MCID_rerank_ndcg10} · K non-inferiority δ(hit@5) ${th.K_noninferiority_delta_hit5} · judging budget ${th.judging_budget_per_corpus} judgements/corpus.`);
line('');
line('Sample size uses the paired normal (t) approximation `N = ceil(((z_{1-α/2} + z_{power}) · SD_Δ / MCID)^2)`, where `SD_Δ` is the **pilot SD of the per-query paired difference** measured below. Two caveats carried into every row:');
line('');
line('- The **cluster** for inference is the family (K: the document). The SD below is the plain per-query SD, so N is **anticonservative** wherever within-family correlation is positive; the clustered interval lives in `out/report.md`. The `families` column is the effective unit count for the clustered analysis.');
line('- Δ for K-safety and for a binary-gold recall is a **bounded discrete** variable (values in {−1, 0, +1} for hit@5), so the normal approximation is rough at small N. Discordance (the share of non-zero Δ) is printed next to the SD because for a discrete paired endpoint it is the more honest driver of power.');
line('');
line('| corpus | gold | endpoint | pilot n | usable | families | paired SD | discordance | mean Δ | N (power 0.8) | note |');
line('|---|---|---|---|---|---|---|---|---|---|---|');

const budget = {};
const kSummary = [];
const notEstimable = [];
let corporaSeen = 0;

for (const label of CORPORA) {
  const Qall = readJsonl(P('suite', `queries.${label}.jsonl`));
  const cand = readJsonl(P('out', `candidates.${label}.real.jsonl`));
  const fin = readJsonl(P('out', `final.${label}.real.jsonl`));
  if (!Qall.length || !cand.length) { line(`| ${label} | — | — | 0 | 0 | 0 | n/a | n/a | n/a | n/a | inputs missing (queries=${Qall.length} candidates=${cand.length}) — **not estimable** |`); continue; }
  corporaSeen++;
  const measuredIds = new Set(cand.map(c => c.id));
  const measured = Qall.filter(x => measuredIds.has(x.id));
  const q = new Map(measured.map(x => [x.id, x]));
  const qrels = readJsonl(P('suite', `qrels.${label}.jsonl`));
  const judged = M.buildJudgedGold(qrels);
  const authored = M.buildAuthoredGold(measured);
  const sources = judged ? [judged, authored] : [authored];

  const row = (gold, ep, res, mcid, extra = '') => {
    const { deltas, clusters, n, usable } = res;
    const fams = new Set(clusters).size;
    const s = M.sd(deltas), disc = deltas.length ? deltas.filter(x => x !== 0).length / deltas.length : null;
    if (s === null) { line(`| ${label} | ${gold} | ${ep} | ${n} | ${usable} | ${fams} | n/a | n/a | ${f3(M.mean(deltas))} | n/a | **not estimable**: fewer than 2 usable pairs${extra ? ' · ' + extra : ''} |`); notEstimable.push(`${label}/${gold}/${ep}`); return null; }
    const N = M.powerN(s, mcid, { alpha: th.power.alpha, power: th.power.target });
    const zeroSd = s === 0 ? 'pilot SD is exactly 0 (no discordant pair) — N=0 is a degenerate estimate, not a real sample size; treat as **not estimable**' : '';
    line(`| ${label} | ${gold} | ${ep} | ${n} | ${usable} | ${fams} | ${f3(s)} | ${f2(disc)} | ${f3(M.mean(deltas))} | ${N} | ${[zeroSd, extra].filter(Boolean).join(' · ')} |`);
    return { N, sd: s, disc };
  };

  for (const src of sources) {
    const cRes = M.candidateDeltas(cand, q, src, 30);
    const depthNote = src.source === 'judged' && cRes.usable === 0 ? 'recall@30 needs `judged_depth: 30`; pass 1 judged depth 10 only' : '';
    const c = row(src.source, 'candidate Δrecall@30(doc) rrf3−rrf2', cRes, th.MCID_candidate_recall30_doc, depthNote);
    const r = row(src.source, 'rerank ΔnDCG@10 fixed-pool', M.rerankDeltas(fin, q, src), th.MCID_rerank_ndcg10,
      src.source === 'authored' ? 'authored gold is binary (gain 1)' : '');
    budget[label] = budget[label] || {};
    budget[label][src.source] = { candidate: c?.N ?? null, rerank: r?.N ?? null };
  }
  // K-safety is graded by the suite's own oracle chunk, so it is the same under
  // both gold sources and consumes no judging budget.
  const kRes = M.kSafetyDeltas(fin, q, 5);
  const kSd = M.sd(kRes.deltas);
  const kN2 = kSd === null ? null : M.powerN(kSd, th.K_noninferiority_delta_hit5, { alpha: th.power.alpha, power: th.power.target });
  const kN1 = kSd === null ? null : M.powerN(kSd, th.K_noninferiority_delta_hit5, { alpha: 2 * th.power.alpha, power: th.power.target });
  const kDisc = kRes.deltas.length ? kRes.deltas.filter(x => x !== 0).length / kRes.deltas.length : null;
  const kHold = Qall.filter(x => x.class === 'K' && x.split === 'holdout').length;
  line(`| ${label} | authored (oracle) | K Δhit@5 non-inferiority | ${kRes.n} | ${kRes.usable} | ${new Set(kRes.clusters).size} | ${f3(kSd)} | ${f2(kDisc)} | ${f3(M.mean(kRes.deltas))} | ${kN2 ?? 'n/a'} | two-sided z; the pre-registered test is **one-sided** vs −δ=${th.K_noninferiority_delta_hit5}, which needs ${kN1 ?? 'n/a'}. Frozen K holdout = ${kHold}. Needs no judging budget. |`);
  budget[label] = budget[label] || {}; budget[label].K = { twoSided: kN2, oneSided: kN1, holdout: kHold };
  kSummary.push({ label, mean: M.mean(kRes.deltas), worse: kRes.deltas.filter(x => x < 0).length, better: kRes.deltas.filter(x => x > 0).length, n: kRes.usable, holdout: kHold, lo: kRes.deltas.length ? M.oneSidedLowerCI(kRes.deltas, kRes.clusters, th.bootstrap) : null });
}

line('');
line('## Judging budget check');
line('');
line(`Budget = ${th.judging_budget_per_corpus} judgements per corpus (\`thresholds.json\`). The per-query cost below is **re-derived from \`out/\`**, not read from \`pool/\` (judging is in flight and that directory is not touched): it reproduces pool.mjs's pass-1 \`top10\` tier — A+M rows only, union over {real, shuffled-r0, random} × 9 channels' \`chunk10\`, plus final off/on/fixed-pool top-10, plus the pure-vector channels. It is a slight **upper bound**: pool.mjs additionally drops chunk ids with no \`chunk_metadata\` row.`);
line('');
line('| corpus | pilot A+M queries pooled | pass-1 judgements | judgements/query | max holdout A+M queries within budget |');
line('|---|---|---|---|---|');
const cap = {};
for (const label of CORPORA) {
  const c = pass1PoolCost(label);
  if (!c) { line(`| ${label} | — | — | n/a | **not estimable**: driver outputs for real/shuffled-r0/random are not all present |`); continue; }
  cap[label] = Math.floor(th.judging_budget_per_corpus / c.perQuery);
  line(`| ${label} | ${c.queries} | ${c.judgements} | ${f2(c.perQuery)} | ${cap[label]} |`);
}
line('');
line('| corpus | gold | endpoint | N needed | within budget? |');
line('|---|---|---|---|---|');
for (const label of CORPORA) {
  const b = budget[label]; if (!b) continue;
  for (const src of Object.keys(b)) {
    if (src === 'K') continue;
    for (const ep of ['candidate', 'rerank']) {
      const N = b[src][ep];
      const capN = cap[label];
      const verdict = N === null ? '**not estimable** — no N to compare'
        : capN === undefined ? 'budget cap unknown (pool cost not derivable)'
        : (N <= capN ? `yes (${N} ≤ ${capN})` : `**no (${N} > ${capN})** → pre-declare this endpoint \`inconclusive\` at the frozen budget`);
      line(`| ${label} | ${src} | ${ep} | ${N ?? 'n/a'} | ${verdict} |`);
    }
  }
  const kn = b.K?.oneSided ?? null, kh = b.K?.holdout ?? 0;
  line(`| ${label} | authored (oracle) | K Δhit@5 | ${kn ?? 'n/a'} (one-sided) | consumes **no judging budget**, but the frozen K holdout is ${kh} — ${kn !== null && kn > kh ? `**${kn} ≫ ${kh}**: a *demonstration of non-inferiority* at δ=${th.K_noninferiority_delta_hit5} is out of reach at this suite size (see the note below)` : 'within the frozen holdout'} |`);
}
line('');
line('## What the K sample size does and does not mean');
line('');
line(`The K row's N is the size needed to **demonstrate non-inferiority** — to show the one-sided lower bound clears −δ — when the true difference is 0. A margin of δ = ${th.K_noninferiority_delta_hit5} against the measured SD is why it lands in the thousands, while the frozen K holdout is ${kSummary.map(k => `${k.label} ${k.holdout}`).join(' · ')}. **Proving** K-safety at this margin is out of reach at this suite size; that limit is recorded here rather than worked around.`);
line('');
line(`**Detecting harm is a different question and needs far less.** The Stage 1 pilot already answers it: ${kSummary.map(k => `${k.label} mean Δ ${f3(k.mean)}, worse/same/better ${k.worse}/${k.n - k.worse - k.better}/${k.better}, one-sided 95% lower ${f3(k.lo)} vs −δ ${-th.K_noninferiority_delta_hit5}, n=${k.n}`).join(' · ')}. Every corpus **FAILs** K-safety in \`out/report.md\` at these sizes. A gate can fail on far fewer queries than it needs to pass.`);
line('');
line('## The semantics endpoint is not in the table above, and that is not an omission');
line('');
line(`Endpoint (4) compares real recall@30 against a null built from **R = ${th.controls.shuffled_replicates} degree-preserving replicates**, so its precision is set by R, not by query N. With R = ${th.controls.shuffled_replicates} the smallest attainable \`p_null\` is 0 (b/R) and the add-one estimate is ${(1 / (th.controls.shuffled_replicates + 1)).toFixed(4)} — just under the frozen \`p_null_max\` ${th.p_null_max}. At R = 19 the add-one floor is exactly 0.05 and the endpoint could never clear a strict "< 0.05". **Increasing holdout query N does not buy resolution here; increasing R does.** Any Stage 2 change to R is a threshold change and belongs in FREEZE.md.`);
line('');
line('## Rule (pre-declared)');
line('');
line('- Holdout A+M size per corpus = **max over the efficacy endpoints of N**, capped by the judging budget. Where the cap binds, that endpoint is pre-declared `inconclusive` rather than run underpowered (proposal D3/D8, branch ⑤).');
line(`- K holdout = the rows already generated in the frozen suite (document-split, no judging needed): ${kSummary.map(k => `${k.label} ${k.holdout}`).join(' · ')}.`);
line('- Where an endpoint is marked **not estimable** above, no N is extrapolated. It becomes estimable only when the missing input arrives (qrels at the needed depth), and this file must be regenerated and re-frozen before holdout.');
line('- Numbers here are Stage 1 **dev pilot** values under `SUMMARIES=off` on `.backup` copies. They size Stage 2; they do not decide anything.');
if (notEstimable.length) { line(''); line(`Not estimable in this run: ${notEstimable.join(' · ')}.`); }

const outPath = P('suite', 'POWER.md');
writeFileSync(outPath, out.join('\n') + '\n');
if (!corporaSeen) { console.error('REPORT_INPUT_MISSING no corpus had both suite/queries.<c>.jsonl and out/candidates.<c>.real.jsonl'); process.exit(17); }
console.log(out.join('\n'));
console.error(`\nwrote ${outPath} (${out.length} lines) · corpora with data ${corporaSeen}/3`);
