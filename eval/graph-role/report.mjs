#!/usr/bin/env node
// eval/graph-role/report.mjs — Stage 1 pilot report (dev split · SUMMARIES=off).
//
// Reads suite/ and out/ only: no DB is opened, no engine is loaded, nothing under
// pool/ is touched. Safe to run while judging is in flight.
//
// Two things the task brief could not know, both reflected here:
//
//  1. Pooling/judging was cut down after measurement. Pass 1 judged a fixed-depth-10
//     pool; the predeclared depth-30 subset is not being judged for now and ranks
//     31-100 are unjudged. So on JUDGED gold, nDCG@10 and hit@k (k<=10) are estimable
//     for every judged query but recall@30(doc) is estimable only where
//     `judged_depth: 30`, and recall@100 is exploratory only. When qrels are absent
//     the line says `qrels absent` rather than printing zeros.
//  2. There are two gold sources and both are reported whenever computable:
//       authored — the suite's own gold (K: document_id / oracle_chunk_id;
//                  A: source_docs; M: source_docs + family). Needs no judging, so it
//                  exists for every corpus and is not truncated by pool depth.
//       judged   — qrels, document grade = max over that document's judged chunks.
//     The primary gatekeeping endpoints use `judged` where qrels exist and `authored`
//     otherwise; every metric line names the gold source it used.
//
// Exit codes: 2 usage · 16 REPORT_LINE_MISSING_DENOMINATOR · 17 REPORT_INPUT_MISSING.
// Every conclusion in the output is PROVISIONAL: this is a dev pilot, not the holdout.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './lib/paths.mjs';
import * as M from './lib/metrics.mjs';

const args = process.argv.slice(2);
if (args.length) { console.error('usage: report.mjs   (no arguments — reads suite/ and out/ only)'); process.exit(2); }

const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const P = (...p) => join(EVAL_DIR, ...p);
const readJsonl = (p) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
// Candidates files are ~7.4 MB each and there are 21 per corpus; project each
// replicate down to what the null needs and let the parsed rows go.
const reduceJsonl = (p, pick) => {
  if (!existsSync(p)) return null;
  const m = new Map();
  for (const l of readFileSync(p, 'utf8').split('\n')) { if (!l) continue; const r = JSON.parse(l); m.set(r.id, pick(r)); }
  return m;
};
const docOf = M.docOfChunk;
const f3 = (x) => (x === null || x === undefined || Number.isNaN(x)) ? 'n/a' : x.toFixed(3);
const f4 = (x) => (x === null || x === undefined || Number.isNaN(x)) ? 'n/a' : x.toFixed(4);
const f2 = (x) => (x === null || x === undefined || Number.isNaN(x)) ? 'n/a' : x.toFixed(2);
// p-values: never round an exact tiny p down to "0.0000" — that reads as impossible certainty.
const fp = (x) => (x === null || x === undefined || Number.isNaN(x)) ? 'n/a' : (x > 0 && x < 1e-4 ? x.toExponential(2) : x.toFixed(4));
const CI = (ci) => ci ? `[${f3(ci[0])}, ${f3(ci[1])}]` : 'n/a';

const CORPORA = ['hub', 'uap', 'hal'];
const TIMED = ['vector', 'fts', 'graph-seed', 'graph-n1', 'graph-n2', 'graph-vec'];   // rrf* are fused in-process, ms = null
const CHANNELS = ['vector', 'fts', 'graph-seed', 'graph-n1', 'graph-n2', 'graph-vec', 'rrf2', 'rrf3', 'rrf3-n2'];

const lines = [];
const badDenominator = [];
const line = (s) => lines.push(s);
// R8's denominator rule as a gate, plus the gold-source rule from the T8 dispatch:
// a metric line must say what it was computed over AND which gold it used.
const metric = (s) => { if (!/n=/.test(s) || !/usable=/.test(s) || !/gold=/.test(s)) badDenominator.push(s); lines.push(s); };

const manifest = existsSync(P('out', 'MANIFEST.json')) ? JSON.parse(readFileSync(P('out', 'MANIFEST.json'), 'utf8')) : null;

line('# graph-role evaluation report — Stage 1 pilot (dev split · SUMMARIES=off)');
line('');
line('**PROVISIONAL.** Stage 1 is a pilot for variance, not for conclusions (proposal D3/r4). No decision branch is taken here; `run-decision.mjs` (Stage 2) does that on holdout.');
line('');
line(`Generated ${new Date().toISOString()} · engine worktree head \`${manifest?.head ?? 'n/a'}\` · node ${manifest?.node ?? 'n/a'}.`);
if (manifest) line(`Driver run: ${manifest.driver?.start ?? '?'} → ${manifest.driver?.end ?? '?'} (${manifest.driver?.steps ?? '?'} steps, nonzero exits ${JSON.stringify(manifest.driver?.nonzero ?? [])}) · ${manifest.load_note ?? 'load conditions unrecorded'}.`);
line('');
line('Channel labels: `vector` = **product base ranking (no graph)** — `hybridSearch(q,K,false)` = vector ∨ FTS-boost, so `rrf2`/`rrf3` fold FTS in twice. `purevec` (separate file) = a raw chunk-vector scan, independent of the product path.');
line('');
line('Gold sources — every metric line names the one it used:');
line('- `authored` = the suite\'s own gold (K `document_id` / `oracle_chunk_id` · A `source_docs` · M `source_docs` + `family`). Needs no judging, exists for all three corpora, and is **not** truncated by pool depth. Grades are binary (gold = 1).');
line('- `judged` = qrels (document grade = max over judged chunks, graded 0/1/2). Pass 1 judged a **fixed-depth-10** pool; the predeclared depth-30 subset is not judged for now and ranks 31–100 are unjudged. So on judged gold nDCG@10 / hit@k(k≤10) are estimable for every judged query, **recall@30(doc) only where `judged_depth: 30`**, and recall@100 is **exploratory only**.');
line('');

const summary = {};

for (const label of CORPORA) {
  const Qall = readJsonl(P('suite', `queries.${label}.jsonl`));
  const candPath = P('out', `candidates.${label}.real.jsonl`);
  const cand = readJsonl(candPath);
  const fin = readJsonl(P('out', `final.${label}.real.jsonl`));
  const pv = readJsonl(P('out', `purevec.${label}.jsonl`));
  if (!Qall.length || !cand.length) { line(`## ${label}`); line(''); metric(`- inputs missing: queries=${Qall.length} candidates=${cand.length} → nothing to report · gold=none · n=0 usable=0`); line(''); continue; }

  const q = new Map(Qall.map(x => [x.id, x]));
  const measuredIds = new Set(cand.map(c => c.id));
  const measured = Qall.filter(x => measuredIds.has(x.id));
  const splits = [...new Set(measured.map(x => x.split))];

  const qrelsPath = P('suite', `qrels.${label}.jsonl`);
  const qrels = readJsonl(qrelsPath);
  const judged = M.buildJudgedGold(qrels);
  const authored = M.buildAuthoredGold(measured);
  const sources = judged ? [judged, authored] : [authored];
  const primary = sources[0];

  line(`## ${label}`);
  line('');
  const cls = (c) => measured.filter(x => x.class === c).length;
  line(`Measured rows: ${measured.length} (split ${splits.join('+')}) — K ${cls('K')} · A ${cls('A')} · M ${cls('M')}. Suite file holds ${Qall.length} rows (dev+holdout).`);
  if (judged) {
    const depths = [...new Set([...judged.depth.values()])].sort((a, b) => a - b);
    line(`qrels: **present** — ${qrels.length} rows over ${judged.gold.size} queries · grade \`${judged.qrels_grade ?? 'unlabelled'}\` · judged_depth ${depths.join('/')} · pool_truncated ${judged.pool_truncated}. Primary gold = **judged**.`);
  } else {
    line(`qrels: **absent** (\`suite/qrels.${label}.jsonl\` does not exist — judging pass 1 has not produced it). Primary gold = **authored**; every judged-gold line below says \`qrels absent\`.`);
  }
  line('');
  line('### Primary endpoints (gatekeeping order)');
  line('');

  // ---- (1) K-safety: paired hit@5 of the oracle chunk, product off vs on --------
  const K = fin.filter(f => f.class === 'K');
  const { deltas: kd, clusters: kcl, n: kN, usable: kU } = M.kSafetyDeltas(fin, q, 5);
  const kLo = kd.length ? M.oneSidedLowerCI(kd, kcl, th.bootstrap) : null;
  const kw = kd.filter(d => d < 0).length, kb = kd.filter(d => d > 0).length;
  const kP = M.signTestExact(kw, kb);
  const kVerdict = kLo === null ? 'not estimable' : (kLo > -th.K_noninferiority_delta_hit5 ? 'PASS' : 'FAIL');
  metric(`- **(1) K-safety** Δhit@5(on−off), oracle chunk · gold=authored (suite oracle; needs no judging): mean ${f3(M.mean(kd))} · one-sided 95% lower ${f3(kLo)} vs −δ=${-th.K_noninferiority_delta_hit5} → **${kVerdict}** · worse/same/better ${kw}/${kd.length - kw - kb}/${kb} · sign p=${fp(kP)} · cluster=document · n=${kN} usable=${kU}`);

  // ---- (2) latency SLO ---------------------------------------------------------
  const warm = cand.slice(1);          // row 1 also paid process warm-up (statement prepare, module load)
  const finWarm = fin.slice(1);
  const chMs = TIMED.map(c => { const v = warm.map(r => r.channels[c]?.ms).filter(x => typeof x === 'number'); return { c, p95: M.pctile(v, 0.95), n: v.length }; });
  const offP95 = M.pctile(finWarm.map(f => f.off.ms).filter(x => typeof x === 'number'), 0.95);
  const onP95 = M.pctile(finWarm.map(f => f.on.ms).filter(x => typeof x === 'number'), 0.95);
  const rrP95 = M.pctile(finWarm.map(f => f.fixedpool_rerank?.ms).filter(x => typeof x === 'number'), 0.95);
  const coldP95 = M.pctile(fin.map(f => f.cold?.ms).filter(x => typeof x === 'number'), 0.95);
  const allWarm = [...chMs.map(x => x.p95).filter(x => x !== null), offP95, onP95, rrP95].filter(x => x !== null);
  const slo = th.latency_slo_ms.warm_p95_max;
  const over = [...chMs.filter(x => x.p95 !== null && x.p95 > slo).map(x => x.c),
                ...(offP95 > slo ? ['final.off'] : []), ...(onP95 > slo ? ['final.on'] : []), ...(rrP95 > slo ? ['fixedpool_rerank'] : [])];
  metric(`- **(2) latency-SLO** (gold=n/a — latency is gold-independent) warm p95 ms ≤ ${slo} → **${allWarm.length ? (over.length ? 'FAIL' : 'PASS') : 'not estimable'}**${over.length ? ` (over: ${over.join(', ')})` : ''} · channels ${chMs.map(x => `${x.c}=${x.p95 ?? 'n/a'}`).join(' · ')} · final off/on=${offP95 ?? 'n/a'}/${onP95 ?? 'n/a'} · fixedpool_rerank=${rrP95 ?? 'n/a'} · cold p95=${coldP95 ?? 'n/a'} (recorded, not gated) · rrf2/rrf3/rrf3-n2 are fused in-process and carry no ms (excluded) · measured under light concurrent load, **this run only** · n=${cand.length} usable=${warm.length} (first row dropped: process warm-up)`);

  // ---- gold-source dependent endpoints (3) (4) (5) ------------------------------
  const AMcand = cand.filter(c => c.class !== 'K');

  // shuffle replicates: project each to graph-n1 chunk30/doc30 per query, then drop.
  const R = th.controls.shuffled_replicates;
  const reps = [];
  for (let i = 0; i < R; i++) {
    const m = reduceJsonl(P('out', `candidates.${label}.shuffled-r${i}.jsonl`), r => ({ c30: r.channels['graph-n1'].chunk30, d30: r.channels['graph-n1'].doc30 }));
    if (m) reps.push(m);
  }

  const perSource = {};
  for (const src of sources) {
    const isPrimary = src === primary;
    const tag = `gold=${src.source}${isPrimary ? ' **[primary]**' : ''}`;
    if (sources.length > 1) { line(''); line(`#### gold source: \`${src.source}\` — ${src.label}${isPrimary ? ' **[primary]**' : ''}`); line(''); }
    // depth restriction applies to recall endpoints on judged gold only
    const depthOk = (id) => src.source !== 'judged' || (src.deep30 && src.deep30.has(id));
    const goldOf = (id) => src.gold.get(id);
    const hasGold = (id) => { const g = goldOf(id); return g && g.size > 0; };

    // (3) candidate: Δrecall@30(doc) rrf3 − rrf2 on A+M
    const { deltas: cd, clusters: ccl, n: cN, usable: cU } = M.candidateDeltas(cand, q, src, 30);
    const cci = cd.length ? M.bootstrapPairedCI(cd, ccl, th.bootstrap) : null;
    const cw = cd.filter(d => d < 0).length, cb = cd.filter(d => d > 0).length;
    const cP = cd.length ? M.signTestExact(cw, cb) : null;
    const note3 = src.source === 'judged'
      ? (cd.length ? '' : ' · **not estimable**: recall@30 needs `judged_depth: 30` and pass 1 judged depth 10 only')
      : '';
    metric(`- **(3) candidate** Δrecall@30(doc) rrf3−rrf2, A+M · ${tag}${src.source === 'judged' && !qrels.length ? ' · qrels absent' : ''}: mean ${f3(M.mean(cd))} · 95% CI ${CI(cci)} · MCID ${th.MCID_candidate_recall30_doc} · worse/same/better ${cw}/${cd.length - cw - cb}/${cb} · sign p=${fp(cP)} · cluster=family · n=${cN} usable=${cU}${note3}`);

    // (4) semantics: real graph-n1 recall@30(doc) vs the 20-replicate shuffle null
    const amWithGold = AMcand.filter(c => hasGold(c.id) && depthOk(c.id));
    const realVals = amWithGold.map(c => M.recallAtKDoc(c.channels['graph-n1'].chunk30, goldOf(c.id), docOf, 30));
    const realN1 = M.mean(realVals);
    const nulls = reps.map(rep => {
      const v = amWithGold.map(c => rep.get(c.id)).map((r, i) => r ? M.recallAtKDoc(r.c30, goldOf(amWithGold[i].id), docOf, 30) : null).filter(x => x !== null);
      return v.length ? M.mean(v) : null;
    }).filter(x => x !== null);
    const nullMean = M.mean(nulls);
    const nGE = nulls.filter(x => x >= realN1).length;
    const pNull = nulls.length ? nGE / nulls.length : null;                       // pre-registered form (D6)
    const pNullAdd1 = nulls.length ? (nGE + 1) / (nulls.length + 1) : null;       // add-one: a permutation p can never be exactly 0
    const dSem = (realN1 !== null && nullMean !== null) ? realN1 - nullMean : null;
    const semVerdict = (dSem === null || pNull === null) ? 'not estimable'
      : ((dSem >= th.MCID_semantics_vs_shuffle_null && pNull <= th.p_null_max) ? 'PASS' : 'FAIL');
    metric(`- **(4) semantics** graph-n1 recall@30(doc) real vs degree-preserving shuffle null, A+M · ${tag}: real ${f3(realN1)} · null mean ${f3(nullMean)} (R=${nulls.length}/${R}) · Δ ${f3(dSem)} vs MCID ${th.MCID_semantics_vs_shuffle_null} · p_null ${nGE}/${nulls.length}=${f3(pNull)} vs ≤${th.p_null_max} → **${semVerdict}** · resolution floor 1/${nulls.length || 1}=${f3(nulls.length ? 1 / nulls.length : null)}, add-one estimate ${f3(pNullAdd1)} (Holm below uses the add-one value — a permutation p is never exactly 0) · n=${AMcand.length} usable=${amWithGold.length}`);

    // (5) rerank: fixed-pool ΔnDCG@10 (with_graph − base) on A+M
    const { deltas: rd, clusters: rcl, n: rN, usable: rU } = M.rerankDeltas(fin, q, src);
    const rci = rd.length ? M.bootstrapPairedCI(rd, rcl, th.bootstrap) : null;
    const rw = rd.filter(d => d < 0).length, rb = rd.filter(d => d > 0).length;
    const rP = rd.length ? M.signTestExact(rw, rb) : null;
    const gradeNote = src.source === 'authored' ? ' · authored gold is binary (gain 1), so this nDCG is a binary-relevance nDCG' : '';
    metric(`- **(5) rerank** ΔnDCG@10 fixed-pool(with_graph−base), A+M, pool = product base@30 · ${tag}: mean ${f3(M.mean(rd))} · 95% CI ${CI(rci)} · MCID ${th.MCID_rerank_ndcg10} · worse/same/better ${rw}/${rd.length - rw - rb}/${rb} · sign p=${fp(rP)} · cluster=family · n=${rN} usable=${rU}${gradeNote}`);

    perSource[src.source] = { cd, ccl, cP, cci, rd, rcl, rP, rci, pNull, pNullAdd1, realN1, nullMean, dSem, semVerdict };
  }

  if (!judged) metric(`- judged-gold block · gold=judged: **qrels absent** — \`suite/qrels.${label}.jsonl\` not written yet; no judged numbers are shown or imputed · n=0 usable=0`);

  // ---- Holm over the pre-declared efficacy family (3) ---------------------------
  const ps = perSource[primary.source];
  const fam = [
    { name: 'candidate', p: ps.cP },
    { name: 'semantics', p: ps.pNullAdd1 },
    { name: 'rerank', p: ps.rP },
  ];
  const padded = fam.map(x => (x.p === null || x.p === undefined) ? 1 : x.p);
  const adj = M.holm(padded);
  line('');
  metric(`- **Holm** over the pre-declared efficacy family (m=3, family size held at 3 even when an endpoint is not estimable — those enter as p=1, which is conservative) · gold=${primary.source}: ` +
    fam.map((x, i) => `${x.name} p=${x.p === null ? 'not estimable' : fp(x.p)}→${fp(adj[i])}`).join(' · ') +
    ` · n=3 usable=${fam.filter(x => x.p !== null).length}`);
  line('');

  // ---- exploratory --------------------------------------------------------------
  line('### Exploratory (descriptive — never a gate, never a power input)');
  line('');
  const src = primary;
  const goldOf = (id) => src.gold.get(id);
  const amGold = AMcand.filter(c => { const g = goldOf(c.id); return g && g.size; });
  const amDepthOk = amGold.filter(c => src.source !== 'judged' || (src.deep30 && src.deep30.has(c.id)));
  const at100Note = src.source === 'judged' ? ' · **@100 is exploratory only** (ranks 31–100 are unjudged, so @100 on judged gold is biased downward)' : ' · @100 is exploratory only (never a gate or a power input)';
  metric(`- recall@K(doc) by channel, A+M · gold=${src.source}${at100Note}: ` +
    CHANNELS.map(ch => `${ch}=` + [10, 30, 100].map(KK => f2(M.mean(amDepthOk.map(c => M.recallAtKDoc(c.channels[ch][`chunk${KK}`], goldOf(c.id), docOf, KK))))).join('/')).join(' · ') +
    ` · n=${AMcand.length} usable=${amDepthOk.length}`);
  metric(`- recall@K over the **unique-document budget** (docK lists = first K distinct documents), A+M · gold=${src.source}: ` +
    CHANNELS.map(ch => `${ch}=` + [10, 30].map(KK => f2(M.mean(amDepthOk.map(c => M.recallAtKDoc(c.channels[ch][`doc${KK}`], goldOf(c.id), docOf, KK))))).join('/')).join(' · ') +
    ` · n=${AMcand.length} usable=${amDepthOk.length}`);
  metric(`- MRR(doc, over chunk100) and hit@10(doc, ≥1 gold document inside the top-10 chunks) by channel, A+M · gold=${src.source}: ` +
    CHANNELS.map(ch => `${ch}=${f2(M.mean(amGold.map(c => M.mrrDoc(c.channels[ch].chunk100, goldOf(c.id), docOf))))}/${f2(M.mean(amGold.map(c => M.recallAtKDoc(c.channels[ch].chunk10, goldOf(c.id), docOf, 10) > 0 ? 1 : 0)))}`).join(' · ') +
    ` · n=${AMcand.length} usable=${amGold.length}`);
  // K class, chunk-level, product off vs on
  const kOracle = K.filter(f => q.get(f.id)?.oracle_chunk_id);
  const kHit = (side, kk) => f2(M.mean(kOracle.map(f => M.hitAtK(f[side].top10.findIndex(x => x.chunk_id === q.get(f.id).oracle_chunk_id) + 1, kk))));
  metric(`- K known-item hit@1/@5/@10 (oracle chunk, product final) · gold=authored: off=${kHit('off', 1)}/${kHit('off', 5)}/${kHit('off', 10)} · on=${kHit('on', 1)}/${kHit('on', 5)}/${kHit('on', 10)} · n=${K.length} usable=${kOracle.length}`);
  // purevec comparison
  if (pv.length) {
    const pvm = new Map(pv.map(r => [r.id, r]));
    const amPv = amDepthOk.filter(c => pvm.has(c.id));
    const rec = (get, KK) => f2(M.mean(amPv.map(c => M.recallAtKDoc(get(c), goldOf(c.id), docOf, KK))));
    metric(`- pure-vector channel (separate run, real only) recall@10/@30(doc), A+M · gold=${src.source}: purevec=${rec(c => pvm.get(c.id).channels.purevec.chunk10, 10)}/${rec(c => pvm.get(c.id).channels.purevec.chunk30, 30)} · fts=${rec(c => pvm.get(c.id).channels.fts.chunk10, 10)}/${rec(c => pvm.get(c.id).channels.fts.chunk30, 30)} · **RRF(purevec,fts)**=${rec(c => pvm.get(c.id).channels['rrf-purevec-fts'].chunk10, 10)}/${rec(c => pvm.get(c.id).channels['rrf-purevec-fts'].chunk30, 30)} vs **rrf2**(product base ∪ fts)=${rec(c => c.channels.rrf2.chunk10, 10)}/${rec(c => c.channels.rrf2.chunk30, 30)} · n=${amDepthOk.length} usable=${amPv.length}`);
  } else {
    metric(`- pure-vector channel: \`out/purevec.${label}.jsonl\` not present — not run · gold=${src.source} (nothing to score) · n=0 usable=0`);
  }
  // alternative control families: type-preserving swap (R=5) and same-|E| random (R=1).
  // The pre-registered null for endpoint (4) is the degree-preserving shuffle; these are
  // the direction/type axis (D6 b/c) and are descriptive only.
  {
    const nullMeanOf = (conds) => {
      const vals = [];
      for (const cond of conds) {
        const m = reduceJsonl(P('out', `candidates.${label}.${cond}.jsonl`), r => r.channels['graph-n1'].chunk30);
        if (!m) continue;
        const v = amDepthOk.map(c => m.get(c.id)).map((ids, i) => ids ? M.recallAtKDoc(ids, goldOf(amDepthOk[i].id), docOf, 30) : null).filter(x => x !== null);
        if (v.length) vals.push(M.mean(v));
      }
      return { mean: M.mean(vals), R: vals.length };
    };
    const ts = nullMeanOf(Array.from({ length: th.controls.typeshuf_replicates }, (_, i) => `typeshuf-r${i}`));
    const rn = nullMeanOf(['random']);
    const realN1x = M.mean(amDepthOk.map(c => M.recallAtKDoc(c.channels['graph-n1'].chunk30, goldOf(c.id), docOf, 30)));
    metric(`- alternative control families for graph-n1 recall@30(doc), A+M · gold=${src.source}: real ${f3(realN1x)} · type-preserving swap null ${f3(ts.mean)} (R=${ts.R}/${th.controls.typeshuf_replicates}) · same-|E| random null ${f3(rn.mean)} (R=${rn.R}/1) · the pre-registered null for endpoint (4) is the degree-preserving shuffle; these two are the direction/type axis (D6 b/c) and are descriptive only · n=${AMcand.length} usable=${amDepthOk.length}`);
  }
  // seam / reach descriptive
  const seamStatus = {}; for (const c of cand) seamStatus[c.seam_status] = (seamStatus[c.seam_status] || 0) + 1;
  metric(`- seam status distribution (gold=n/a — run diagnostics, not a retrieval metric): ${Object.entries(seamStatus).map(([k, v]) => `${k}=${v}`).join(' · ')} · mean seeds ${f2(M.mean(cand.map(c => c.seeds.length)))} · mean 1-hop connected ${f2(M.mean(cand.map(c => c.n_connected)))} · mean 2-hop entities ${f2(M.mean(cand.map(c => c.n2_count)))} · mean reach chunks ${f2(M.mean(cand.map(c => c.reach.chunks)))} / docs ${f2(M.mean(cand.map(c => c.reach.docs_n ?? (c.reach.docs?.length ?? 0))))} · **reachable-set recall (\`graph-reach\`, D4) is not computable from these outputs** — the runner recorded the reach set SIZES, not the set, so no recall can be derived without re-running · n=${cand.length} usable=${cand.length}`);
  // upstream
  const up = readJsonl(P('out', `upstream.${label}.jsonl`));
  const lpPath = P('out', `link-precision.${label}.json`);
  const lp = existsSync(lpPath) ? JSON.parse(readFileSync(lpPath, 'utf8')) : null;
  if (up.length) {
    const evT = up.reduce((a, u) => a + (u.edge_validity?.total ?? 0), 0), evE = up.reduce((a, u) => a + (u.edge_validity?.exists ?? 0), 0);
    const prVals = up.map(u => u.projection_recall).filter(x => x !== null && x !== undefined);
    const sr = up.filter(u => u.seed_recall).length;
    metric(`- upstream gates (D5) · gold=authored (the suite's \`seed_candidates\` and \`expected_paths\`): seed_recall ${sr}/${up.length} = ${f3(sr / up.length)} vs ≥${th.upstream_gate.seed_recall_min} · edge_validity ${evE}/${evT} = ${f3(evT ? evE / evT : null)} vs ≥${th.upstream_gate.edge_validity_min} · projection_recall mean ${f3(M.mean(prVals))} · n=${up.length} usable=${up.length}`);
  } else {
    metric(`- upstream gates · gold=authored: \`out/upstream.${label}.jsonl\` absent — **upstream not run** · n=0 usable=0`);
  }
  if (lp) {
    metric(`- link precision · gold=link-audit judge (a separate mention judgement, not qrels): name ${lp.by_provenance?.name?.precision ?? 'n/a'} (n=${lp.by_provenance?.name?.n ?? 0}) vs ≥${th.upstream_gate.link_precision_name_min} · nonliteral ${lp.by_provenance?.nonliteral?.precision ?? 'n/a'} (n=${lp.by_provenance?.nonliteral?.n ?? 0}) · weighted ${lp.weighted_precision ?? 'n/a'} CI ${JSON.stringify(lp.ci95 ?? null)} · n=${lp.pairs ?? 0} usable=${lp.chunks ?? 0} chunk clusters`);
  } else {
    metric(`- link precision · gold=link-audit judge: \`out/link-precision.${label}.json\` absent — **link audit not merged** (judge-A verdicts pending) · n=0 usable=0`);
  }
  line('');

  summary[label] = { primary: primary.source, ...perSource[primary.source], kd, kLo, kVerdict, sloVerdict: allWarm.length ? (over.length ? 'FAIL' : 'PASS') : 'not estimable', holm: adj, fam };
}

// ---- corpus-stratified macro ---------------------------------------------------
line('## Corpus-stratified macro (mean of corpus means — no naive pooling)');
line('');
const labels = Object.keys(summary);
const macro = (key) => {
  const vals = labels.map(l => summary[l][key]).filter(v => Array.isArray(v) && v.length).map(v => M.mean(v));
  return { v: vals.length ? M.mean(vals) : null, k: vals.length };
};
const mc = macro('cd'), mr = macro('rd');
metric(`- candidate Δrecall@30(doc) macro ${f3(mc.v)} · rerank ΔnDCG@10 macro ${f3(mr.v)} · gold=per-corpus primary (${labels.map(l => `${l}:${summary[l].primary}`).join(' ')}) · n=${labels.length} usable=${Math.max(mc.k, mr.k)} corpora`);
const semPass = labels.filter(l => summary[l].semVerdict === 'PASS').length;
metric(`- K-safety per corpus ${labels.map(l => `${l}:${summary[l].kVerdict}`).join(' ')} · latency-SLO ${labels.map(l => `${l}:${summary[l].sloVerdict}`).join(' ')} · semantics PASS ${semPass}/${labels.length} · gold=per-corpus primary · n=${labels.length} usable=${labels.length}`);
// Branch ② of the D8 table needs "point >= MCID in >= 2/3 corpora"; report the count as an
// input, not as a verdict — the branch itself is run-decision.mjs's on holdout.
const geMcid = (key, mcid) => labels.filter(l => { const m = M.mean(summary[l][key]); return m !== null && m >= mcid; }).length;
const ciAbove0 = (key) => labels.filter(l => { const ci = summary[l][key === 'cd' ? 'cci' : 'rci']; return ci && ci[0] > 0; }).length;
metric(`- Stage 2 branch inputs (counts only — the branch is decided on holdout): candidate point ≥ MCID ${th.MCID_candidate_recall30_doc} in ${geMcid('cd', th.MCID_candidate_recall30_doc)}/${labels.length} corpora, unadjusted CI lower > 0 in ${ciAbove0('cd')}/${labels.length} · rerank point ≥ MCID ${th.MCID_rerank_ndcg10} in ${geMcid('rd', th.MCID_rerank_ndcg10)}/${labels.length}, CI lower > 0 in ${ciAbove0('rd')}/${labels.length} · gold=per-corpus primary · n=${labels.length} usable=${labels.length}`);
line('');
line('## Reading this report');
line('');
line('- Gatekeeping order is **K-safety → latency-SLO → candidate → semantics → rerank**. The five branch conditions (upstream-first / candidate-generation+RRF / gated-rerank / remove-from-ranking / inconclusive→expand-evaluation) are applied by `run-decision.mjs` on **holdout**, not here. Stage 1 supplies variance for `suite/POWER.md`.');
line('- Holm is applied over the three efficacy endpoints (candidate · semantics · rerank) with the family size pre-declared at 3.');
line('- `n=` is the rows the endpoint was eligible for; `usable=` is the rows the metric could actually be computed on (gold present, and — on judged gold — judged deeply enough).');
line('- Anything under **Exploratory** is descriptive only: it is not a gate, is not Holm-adjusted, and must not be quoted as an outcome.');
line('- `remove-from-ranking` needs futility evidence and `decision-grade` qrels; with `LLM-judged provisional` or absent qrels it is unavailable by construction (proposal D10).');

const outPath = P('out', 'report.md');
writeFileSync(outPath, lines.join('\n') + '\n');
if (badDenominator.length) { console.error(`REPORT_LINE_MISSING_DENOMINATOR ${badDenominator.length} metric line(s) lack n=/usable=:\n${badDenominator.join('\n')}`); process.exit(16); }
if (!labels.length) { console.error('REPORT_INPUT_MISSING no corpus had both suite/queries.<c>.jsonl and out/candidates.<c>.real.jsonl'); process.exit(17); }
console.log(lines.join('\n'));
console.error(`\nwrote ${outPath} (${lines.length} lines) · corpora ${labels.join(',')}`);
