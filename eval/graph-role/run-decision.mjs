#!/usr/bin/env node
// eval/graph-role/run-decision.mjs — T11: freeze checks -> the five-way gatekeeping table ->
// semantics axis -> the provisional guard -> DECISION.md (+ the selected follow-up change's
// evidence block).
//
// THE DECISION TABLE IS NOT INVENTED HERE. Every clause below is copied from:
//   specs/changes/graph-role-evaluation/proposal.md               §D8, the table at lines 63-71
//   specs/changes/graph-role-evaluation/delta-specs/
//     graph-role-evaluation.spec.md                               §R9 (branch order, remove/futility,
//                                                                  DECISION.md contents, exit 3)
//                                                                 §R7 (provisional => branch (4) is
//                                                                  forbidden, MUST)
// The four places where the prose leaves a degree of freedom are listed under
// INTERPRETATIONS below and are reprinted into DECISION.md, so a reader never has to trust
// this file's reading of the table.
//
// CONSUME, DO NOT RECOMPUTE. Every statistic comes out of `out/report.md` (report.mjs owns
// bootstrap CIs, sign tests, Holm and the per-endpoint verdicts). This script re-derives
// nothing except two integer counts from `out/upstream.<c>.jsonl` (rows with seed_recall, and
// the edge_validity exists/total sums), and it cross-checks even those against report.md's own
// upstream line — a mismatch is exit 23, not a silent preference for one of the two.
//
// Reads `suite/`, `out/`, and `suite/judging-record.json` only. No DB is opened, no engine is
// loaded, and nothing under `pool/` or `links/` is read or written (judging runs concurrently).
//
// Exit codes (README carries the full harness table):
//   2  usage
//   3  FROZEN_MISMATCH             (lib/freeze.mjs — queries/thresholds/qrels tampered; R9 "임계값 변조")
//   18 REPORT_MISSING              out/report.md does not exist
//   19 REPORT_PARSE_FAILED         a required endpoint line is absent or unparseable
//   20 UPSTREAM_MISSING            out/upstream.<c>.jsonl does not exist (run-upstream.mjs first)
//   21 LINK_PRECISION_MISSING      out/link-precision.<c>.json does not exist (link-audit-merge.mjs first)
//   22 REPORT_STALE                report.md still says "upstream not run" / "link audit not merged"
//                                  although those artifacts now exist — re-run report.mjs
//   23 ARTIFACT_MISMATCH           report.md and the raw artifact disagree on the same number
//   24 JUDGING_RECORD_MISSING      suite/judging-record.json absent (the kappa/qrels/audit record)
//   25 JUDGING_RECORD_INCONSISTENT the record contradicts what is on disk (e.g. says no qrels were
//                                  written while suite/qrels.<c>.jsonl exists)
//   26 FOLLOWUP_CHANGE_MISSING     DECISION.md was written but the selected branch's follow-up
//                                  change directory does not exist (delta R11 as a machine gate)
//
// INTERPRETATIONS (the table's degrees of freedom, resolved once, here and in DECISION.md):
//  I-1 "조정 CI 하한 > 0": report.mjs emits *unadjusted* bootstrap CIs plus Holm-adjusted
//      p-values, not adjusted intervals. Adjustment only widens an interval, so an unadjusted
//      lower bound <= 0 is already a failure of the adjusted clause; where the unadjusted lower
//      bound is > 0 this script additionally requires the endpoint's Holm-adjusted p < alpha
//      (`thresholds.json.power.alpha`) as the available multiplicity guard. Both numbers are
//      printed in DECISION.md.
//  I-2 corpus quantifiers: the table writes "corpus 별 >= 2/3" only on the candidate clause. The
//      same 2/3 majority is applied to the semantics clause of branches (2)/(3); K-safety and the
//      latency SLO are safety gates and are required in EVERY covered corpus; futility for
//      branch (4) is required in EVERY covered corpus.
//  I-3 semantics futility: report.mjs prints no CI for the semantics delta, so "CI 상한 < MCID"
//      is not establishable for that endpoint from the current report and branch (4) is
//      unreachable (recorded as SEMANTICS_CI_ABSENT). The line grammar accepts an optional
//      `· semantics 95% CI [lo, hi]` token so a future report can supply one; nothing is imputed
//      when it is absent.
//  I-4 "검정력 확보 상태" (branch (4)): attested only when `suite/POWER.md` is hashed into
//      `suite/FREEZE.md` and its hash still matches (R9's "holdout 전 동결"). Writing POWER.md is
//      not freezing it.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CORPORA, EVAL_DIR, REPO_ROOT } from './lib/paths.mjs';
import { assertFrozen, readFreeze, sha256File } from './lib/freeze.mjs';

const P = (...p) => join(EVAL_DIR, ...p);
const die = (code, name, msg) => { console.error(`${name} ${msg}`); process.exit(code); };
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const f3 = (x) => (x === null || x === undefined || Number.isNaN(x)) ? 'n/a' : Number(x).toFixed(3);
const f4 = (x) => (x === null || x === undefined || Number.isNaN(x)) ? 'n/a' : Number(x).toFixed(4);
const pct = (x) => (x === null || x === undefined || Number.isNaN(x)) ? 'n/a' : `${(Number(x) * 100).toFixed(1)}%`;
const CIs = (ci) => ci ? `[${f3(ci[0])}, ${f3(ci[1])}]` : 'n/a';

// ---------------------------------------------------------------------------------------------
// Static observations carried into DECISION.md. These are quotations, not measurements: the
// script never runs a search, never opens the MCP server and never touches a live DB.
// ---------------------------------------------------------------------------------------------

// The two reproduction queries of hub log 2026-08-17 §227 ("graph_boost 가 벡터를 압도한다",
// sample 2/2). v5.3.0 made `useGraph` opt-in, which is containment: with the default off both
// queries return the right chunk first. The design spec's acceptance for the ROOT repair is
// stronger — 2026-08-17-graph-role-redesign-design.md §2 wants both to be top-1 *with*
// `useGraph:true`. They are carried here as re-check items for after the upstream change.
const REPRO_227 = [
  {
    n: 1,
    query: '경고를 내는 훅이 계약 밖 값을 반환해서 위험할 때만 조용히 죽었다',
    gold: '세션29 gotcha (wiki/gotchas.md)',
    observed_2026_08_17: 'useGraph:true → 1위 오답(세션18 gotcha, vector 0.5153, boost 0.4), 정답(vector 0.5641)은 top-3 밖 · useGraph:false → 정답 1위 · v5.3.0 canary(기본 off) → 정답 top-1 (`wiki-gotchas_chunk_21`)',
  },
  {
    n: 2,
    query: '빈 디렉터리 사슬이 경로 길이 제한 때문에 검사를 죽이고 있었다',
    gold: '세션23 gotcha',
    observed_2026_08_17: 'useGraph:true → `vector_similarity 0` 인 무관 청크가 entity 링크 수만으로 상위 진입, 정답 gotcha 는 2위(vector 0, boost 0.375)',
  },
];

// Framework tracker receipt paths (delta R11: DECISION.md SHALL carry them). Paths are relative
// to the framework hub folder, which is a different repository from this one — this script does
// not edit them; it records where the receipt has to land.
const TRACKER_RECEIPTS = [
  {
    path: 'decisions/current-focus.md',
    what: '② (graph 랭킹 근본 수리) 항목 갱신 — B Stage 1 = evaluation complete · 갈래 · 후속 change 포인터. ⚠ `evaluation complete` ≠ `root repair complete`: ② 는 후속 구현 change 가 출하되고 post-change holdout 을 통과할 때까지 닫지 않는다 (proposal D8 [r4-B9]).',
  },
  {
    path: 'docs/superpowers/specs/2026-08-17-graph-role-redesign-design.md',
    what: '§2 (변경 B — graph 역할 재설계) 상태 갱신 + 이 DECISION.md 링크.',
  },
];

const FOLLOWUP = {
  'upstream-first': {
    slug: 'graph-upstream-build',
    d8_followup: '`entity-link-quality`(또는 seed 매칭 수리) 를 이 change 가 연다',
    why_this_slug: 'D8 은 갈래 ① 의 후속을 `entity-link-quality` 로 예시했지만 실측된 미달 성분은 링크 정밀도가 아니라 **edge 커버리지**다(seed 는 게이트를 통과, 기대 edge 는 대부분 KG 에 없다). 그래서 후속 change 는 링크 품질보다 넓은 **그래프 구축(build) 개선**이고 slug 는 `graph-upstream-build` 다 — 링크 품질 수리는 그 안의 한 축으로 들어간다.',
    scaffold: true,
  },
  'candidate-generation+RRF': { slug: 'graph-candidate-rrf', d8_followup: 'graph→chunk 후보 채널 + RRF, `mode:explore`', scaffold: false },
  'gated-rerank': { slug: 'graph-gated-rerank', d8_followup: '제한적 재랭킹(gate = 명시적 `mode`)', scaffold: false },
  'remove-from-ranking': { slug: 'graph-remove-from-ranking', d8_followup: '랭킹에서 graph 제거 · traversal 도구만', scaffold: false },
  'inconclusive-expand-evaluation': { slug: 'graph-role-evaluation-expand', d8_followup: '평가 확장 change(N 확대 · 표본 설계 변경) 를 연다 — 미입증 ≠ 무효', scaffold: false },
};

const BRANCH_LABEL = {
  'upstream-first': '① upstream-first',
  'candidate-generation+RRF': '② candidate-generation+RRF',
  'gated-rerank': '③ gated-rerank',
  'remove-from-ranking': '④ remove-from-ranking',
  'inconclusive-expand-evaluation': '⑤ inconclusive → expand-evaluation',
};

// ---------------------------------------------------------------------------------------------
// report.md parsing. Pure (text in, data out) so the grammar is unit-testable.
// ---------------------------------------------------------------------------------------------

const numOf = (s) => {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  if (!t || t === 'n/a' || t === 'not estimable') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};
const ciOf = (s) => {
  if (!s) return null;
  const m = String(s).match(/\[\s*([^,\]]+)\s*,\s*([^\]]+)\s*\]/);
  if (!m) return null;
  const lo = numOf(m[1]), hi = numOf(m[2]);
  return (lo === null || hi === null) ? null : [lo, hi];
};

export function parseReport(text, corpusLabels) {
  const known = new Set(corpusLabels);
  const out = { generated: null, head: null, node: null, title: null, stage: null, split: null, corpora: new Map() };
  let cur = null;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    // The report states its own provenance in the H1. Read it: a Stage 1 pilot on the dev split
    // is explicitly "not for conclusions" (proposal D3/r4), and consuming one silently is how a
    // pilot becomes a decision without anyone deciding that. Measured 2026-08-22.
    const t = l.match(/^# graph-role evaluation report — (.+)$/);
    if (t) {
      out.title = t[1];
      out.stage = /Stage\s*1/i.test(t[1]) ? 'stage-1-pilot' : (/Stage\s*2/i.test(t[1]) ? 'stage-2' : null);
      if (/\bdev split\b/i.test(t[1])) out.split = 'dev';
      else if (/\bholdout\b/i.test(t[1])) out.split = 'holdout';
      continue;
    }
    const gen = l.match(/^Generated (\S+) · engine worktree head `([^`]*)` · node (\S+?)\.?$/);
    if (gen) { out.generated = gen[1]; out.head = gen[2]; out.node = gen[3]; continue; }
    // A LEVEL-2 heading closes the current corpus section; `###` subheadings do not (the report
    // nests "### Primary endpoints" inside each corpus). Matching only `^## (\S+)$` left `cur`
    // pointing at the previous corpus when a level-2 heading had spaces ("## Corpus-stratified
    // macro …"), so endpoint-shaped lines under it silently overwrote that corpus. Both halves
    // measured 2026-08-22: resetting on `#{2,}` instead broke every corpus (11/12 tests red).
    if (/^##(?!#)\s/.test(l)) {
      const h = l.match(/^## (\S+)$/);
      cur = (h && known.has(h[1])) ? h[1] : null;
      if (cur && !out.corpora.has(cur)) out.corpora.set(cur, { label: cur });
      continue;
    }
    if (!cur) continue;
    const c = out.corpora.get(cur);

    const qr = l.match(/^qrels: \*\*(present|absent)\*\*/);
    if (qr) { c.qrels = qr[1]; const g = l.match(/grade `([^`]+)`/); c.qrels_grade = g ? g[1] : null; continue; }

    const k = l.match(/^- \*\*\(1\) K-safety\*\*.*?· gold=(\S+?)[ (].*?: mean (\S+) · one-sided 95% lower (\S+) vs −δ=(\S+) → \*\*([^*]+)\*\*/);
    if (k) { c.k = { gold: k[1], mean: numOf(k[2]), lower: numOf(k[3]), delta: numOf(k[4]), verdict: k[5].trim() }; continue; }

    const s = l.match(/^- \*\*\(2\) latency-SLO\*\*.*?warm p95 ms ≤ (\S+) → \*\*([^*]+)\*\*/);
    if (s) { c.slo = { slo_ms: numOf(s[1]), verdict: s[2].trim() }; continue; }

    // (3)(4)(5) exist once per gold source; only the primary one carries **[primary]**.
    const cand = l.match(/^- \*\*\(3\) candidate\*\*.*?· gold=(\S+) \*\*\[primary\]\*\*.*?: mean (\S+) · 95% CI (\[[^\]]*\]|n\/a) · MCID (\S+)/);
    if (cand) { c.candidate = { gold: cand[1], mean: numOf(cand[2]), ci: ciOf(cand[3]), mcid: numOf(cand[4]) }; continue; }

    const sem = l.match(/^- \*\*\(4\) semantics\*\*.*?· gold=(\S+) \*\*\[primary\]\*\*: real (\S+) · null mean (\S+) \(R=(\d+)\/(\d+)\) · Δ (\S+) vs MCID (\S+) · p_null \d+\/\d+=(\S+) vs ≤(\S+) → \*\*([^*]+)\*\*/);
    if (sem) {
      c.semantics = {
        gold: sem[1], real: numOf(sem[2]), null_mean: numOf(sem[3]), R: numOf(sem[4]), R_planned: numOf(sem[5]),
        delta: numOf(sem[6]), mcid: numOf(sem[7]), p_null: numOf(sem[8]), p_null_max: numOf(sem[9]),
        verdict: sem[10].trim(),
        // I-3: optional, never imputed. report.mjs does not emit it today.
        ci: ciOf((l.match(/· semantics 95% CI (\[[^\]]*\])/) || [])[1]),
      };
      continue;
    }

    const rr = l.match(/^- \*\*\(5\) rerank\*\*.*?· gold=(\S+) \*\*\[primary\]\*\*: mean (\S+) · 95% CI (\[[^\]]*\]|n\/a) · MCID (\S+)/);
    if (rr) { c.rerank = { gold: rr[1], mean: numOf(rr[2]), ci: ciOf(rr[3]), mcid: numOf(rr[4]) }; continue; }

    const holm = l.match(/^- \*\*Holm\*\*.*?: candidate p=(.+?)→(\S+) · semantics p=(.+?)→(\S+) · rerank p=(.+?)→(\S+) ·/);
    if (holm) { c.holm = { candidate: { raw: numOf(holm[1]), adj: numOf(holm[2]) }, semantics: { raw: numOf(holm[3]), adj: numOf(holm[4]) }, rerank: { raw: numOf(holm[5]), adj: numOf(holm[6]) } }; continue; }

    if (/^- upstream gates/.test(l)) {
      const m = l.match(/seed_recall (\d+)\/(\d+) = (\S+) vs ≥(\S+) · edge_validity (\d+)\/(\d+) = (\S+) vs ≥(\S+)/);
      c.upstream_line = m
        ? { present: true, seed_hit: +m[1], seed_n: +m[2], seed_min: numOf(m[4]), edge_exists: +m[5], edge_total: +m[6], edge_min: numOf(m[8]) }
        : { present: false, text: l };
      continue;
    }
    if (/^- link precision/.test(l)) {
      const m = l.match(/name (\S+) \(n=(\d+)\) vs ≥(\S+)/);
      c.link_line = m ? { present: true, name_precision: numOf(m[1]), name_n: +m[2], name_min: numOf(m[3]) } : { present: false, text: l };
      continue;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The table (proposal D8 lines 63-71 / delta R9). Pure: evidence in, branch out.
// ---------------------------------------------------------------------------------------------

// A clause that needs "corpus 별 >= 2/3" (I-2). n=3 -> 2, n=1 -> 1.
const majority = (n) => Math.ceil((2 * n) / 3);

export function upstreamGateOf(c, th) {
  const g = th.upstream_gate;
  return [
    { name: 'seed_recall', value: c.upstream.seed_recall, min: g.seed_recall_min },
    { name: 'edge_validity', value: c.upstream.edge_validity, min: g.edge_validity_min },
    { name: 'link_precision(name)', value: c.link.name_precision, min: g.link_precision_name_min },
  ].map(p => ({ ...p, verdict: p.value === null ? 'not estimable' : (p.value >= p.min ? 'PASS' : 'FAIL') }));
}

// I-1: unadjusted CI lower bound > 0 AND the endpoint's Holm-adjusted p < alpha.
const efficacyOk = (ep, holm, alpha) =>
  !!(ep && ep.ci && ep.ci[0] > 0 && holm && holm.adj !== null && holm.adj < alpha && ep.mean !== null && ep.mean >= ep.mcid);

// futility = "CI 상한 < MCID". Not establishable when the endpoint has no CI (I-3).
const futile = (ep) => !!(ep && ep.ci && ep.mcid !== null && ep.ci[1] < ep.mcid);

export function selectBranch(corpora, th, ctx) {
  const alpha = th.power.alpha;
  const n = corpora.length;
  const need = majority(n);
  const trace = [];

  // --- ① upstream-first: "upstream 게이트 미달(corpus 하나라도)" ---------------------------
  const gates = corpora.map(c => ({ label: c.label, parts: upstreamGateOf(c, th) }));
  const failed = gates.flatMap(g => g.parts.filter(p => p.verdict === 'FAIL').map(p => `${g.label}.${p.name}=${f3(p.value)} < ${p.min}`));
  const unmeasured = gates.flatMap(g => g.parts.filter(p => p.verdict === 'not estimable').map(p => `${g.label}.${p.name}`));
  trace.push({ branch: 'upstream-first', taken: failed.length > 0, detail: failed.length ? `게이트 미달 ${failed.length}건: ${failed.join(' · ')}` : `3 성분 × ${n} corpus 전부 게이트 이상 (미달 0)` });
  if (failed.length) return { branch: 'upstream-first', gates, trace, reasons: failed };

  if (unmeasured.length) {
    trace.push({ branch: 'inconclusive-expand-evaluation', taken: true, detail: `UPSTREAM_GATE_NOT_ESTIMABLE ${unmeasured.join(' · ')} — 진입 조건이 측정되지 않았다(미달과 다르다)` });
    return { branch: 'inconclusive-expand-evaluation', gates, trace, reasons: [`UPSTREAM_GATE_NOT_ESTIMABLE ${unmeasured.join(' · ')}`] };
  }

  // --- safety gates shared by ② and ③ (I-2: every covered corpus) ---------------------------
  const kFail = corpora.filter(c => c.report.k?.verdict !== 'PASS').map(c => `${c.label}:${c.report.k?.verdict ?? 'missing'}`);
  const sloFail = corpora.filter(c => c.report.slo?.verdict !== 'PASS').map(c => `${c.label}:${c.report.slo?.verdict ?? 'missing'}`);
  const safe = kFail.length === 0 && sloFail.length === 0;

  const candN = corpora.filter(c => efficacyOk(c.report.candidate, c.report.holm?.candidate, alpha)).length;
  const rerankN = corpora.filter(c => efficacyOk(c.report.rerank, c.report.holm?.rerank, alpha)).length;
  const semN = corpora.filter(c => c.report.semantics?.verdict === 'PASS').length;

  // --- ② candidate-generation+RRF ------------------------------------------------------------
  const two = safe && candN >= need && semN >= need;
  trace.push({ branch: 'candidate-generation+RRF', taken: two, detail: `K-safety ${kFail.length ? 'FAIL ' + kFail.join(' ') : `PASS ${n}/${n}`} · SLO ${sloFail.length ? 'FAIL ' + sloFail.join(' ') : `PASS ${n}/${n}`} · candidate 절 충족 ${candN}/${n} (필요 ${need}) · semantics PASS ${semN}/${n} (필요 ${need})` });
  if (two) return { branch: 'candidate-generation+RRF', gates, trace, reasons: [] };

  // --- ③ gated-rerank ("candidate 미달" = ② 의 candidate 절 미충족) --------------------------
  const three = safe && candN < need && rerankN >= need && semN >= need;
  trace.push({ branch: 'gated-rerank', taken: three, detail: `K-safety/SLO ${safe ? 'PASS' : 'FAIL'} · candidate 미달 ${candN < need} · rerank 절 충족 ${rerankN}/${n} (필요 ${need}) · semantics PASS ${semN}/${n}` });
  if (three) return { branch: 'gated-rerank', gates, trace, reasons: [] };

  // --- ④ remove-from-ranking (futility · 검정력 확보 · provisional 금지) ----------------------
  const futCand = corpora.filter(c => futile(c.report.candidate)).length;
  const futRer = corpora.filter(c => futile(c.report.rerank)).length;
  const futSem = corpora.filter(c => futile(c.report.semantics)).length;
  const semCiAbsent = corpora.filter(c => !c.report.semantics?.ci).map(c => c.label);
  const allFutile = futCand === n && futRer === n && futSem === n;
  const detail4 = `futility(CI 상한 < MCID) candidate ${futCand}/${n} · rerank ${futRer}/${n} · semantics ${futSem}/${n}${semCiAbsent.length ? ` (SEMANTICS_CI_ABSENT ${semCiAbsent.join(',')} — report.mjs 는 semantics CI 를 내지 않는다)` : ''} · 검정력 확보(POWER.md 동결) ${ctx.power_attested}`;
  if (allFutile && ctx.power_attested) {
    if (ctx.grade !== 'decision-grade') {
      trace.push({ branch: 'remove-from-ranking', taken: false, detail: `${detail4} → 조건 성립하나 **거부**: qrels 등급 \`${ctx.grade}\` (delta R7 MUST · proposal D10)` });
      trace.push({ branch: 'inconclusive-expand-evaluation', taken: true, detail: 'REMOVE_FORBIDDEN_ON_PROVISIONAL → ⑤ 로 강등' });
      return { branch: 'inconclusive-expand-evaluation', gates, trace, refusal: 'REMOVE_FORBIDDEN_ON_PROVISIONAL', would_have_been: 'remove-from-ranking', reasons: [`futility 성립(${futCand}/${futRer}/${futSem} of ${n}) 이지만 등급이 ${ctx.grade}`] };
    }
    trace.push({ branch: 'remove-from-ranking', taken: true, detail: detail4 });
    return { branch: 'remove-from-ranking', gates, trace, reasons: [] };
  }
  trace.push({ branch: 'remove-from-ranking', taken: false, detail: detail4 });

  // --- ⑤ inconclusive -> expand-evaluation ---------------------------------------------------
  trace.push({ branch: 'inconclusive-expand-evaluation', taken: true, detail: '위 어느 갈래도 참이 아니다' });
  return { branch: 'inconclusive-expand-evaluation', gates, trace, reasons: [] };
}

// ---------------------------------------------------------------------------------------------
// Input loading. Everything is gathered before a single byte is written: a partial input set
// exits with a named reason and leaves no DECISION.md behind.
// ---------------------------------------------------------------------------------------------

function loadJudgingRecord() {
  const p = P('suite', 'judging-record.json');
  if (!existsSync(p)) die(24, 'JUDGING_RECORD_MISSING', `${p} — the kappa / qrels / human-audit record is what DECISION.md quotes; this script will not invent it.`);
  let rec;
  try { rec = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { die(24, 'JUDGING_RECORD_MISSING', `${p} is not valid JSON: ${e.message}`); }
  for (const f of ['corpora', 'gate_kappa_weighted', 'grade', 'source']) {
    if (rec[f] === undefined) die(25, 'JUDGING_RECORD_INCONSISTENT', `${p} lacks required field \`${f}\``);
  }
  if (!['decision-grade', 'provisional'].includes(rec.grade)) die(25, 'JUDGING_RECORD_INCONSISTENT', `${p} grade=\`${rec.grade}\` is neither decision-grade nor provisional (delta R7)`);
  return rec;
}

function loadCorpus(label, rep, th, rec) {
  const r = rep.corpora.get(label);
  const miss = ['k', 'slo', 'candidate', 'semantics', 'rerank', 'holm'].filter(f => !r[f]);
  if (miss.length) die(19, 'REPORT_PARSE_FAILED', `out/report.md · ${label}: could not parse ${miss.join(', ')} — the endpoint line(s) are absent or the grammar changed.`);

  const upPath = P('out', `upstream.${label}.jsonl`);
  if (!existsSync(upPath)) die(20, 'UPSTREAM_MISSING', `${upPath} — run \`node eval/graph-role/run-upstream.mjs ${label}\` first.`);
  const rows = readJsonl(upPath);
  const seed_hit = rows.filter(x => x.seed_recall).length;
  const edge_exists = rows.reduce((a, x) => a + (x.edge_validity?.exists ?? 0), 0);
  const edge_total = rows.reduce((a, x) => a + (x.edge_validity?.total ?? 0), 0);
  const required_missing = rows.reduce((a, x) => a + (x.edge_validity?.required_missing ?? 0), 0);
  const skipped = rows.filter(x => x.skipped).length;
  const upstream = {
    n: rows.length, seed_hit, seed_recall: rows.length ? seed_hit / rows.length : null,
    edge_exists, edge_total, edge_validity: edge_total ? edge_exists / edge_total : null,
    required_missing, skipped, skipped_reason: rows.find(x => x.skipped)?.skipped ?? null,
  };

  const lpPath = P('out', `link-precision.${label}.json`);
  if (!existsSync(lpPath)) die(21, 'LINK_PRECISION_MISSING', `${lpPath} — run \`node eval/graph-role/link-audit-merge.mjs ${label}\` first (needs the judge-A verdicts).`);
  const lpj = JSON.parse(readFileSync(lpPath, 'utf8'));
  const link = {
    name_precision: lpj.by_provenance?.name?.precision ?? null,
    name_n: lpj.by_provenance?.name?.n ?? 0,
    nonliteral_precision: lpj.by_provenance?.nonliteral?.precision ?? null,
    nonliteral_n: lpj.by_provenance?.nonliteral?.n ?? 0,
    weighted_precision: lpj.weighted_precision ?? null,
    ci95: lpj.ci95 ?? null, pairs: lpj.pairs ?? 0, chunks: lpj.chunks ?? 0,
    reliability: lpj.reliability ?? null, reliability_note: lpj.reliability_note ?? null,
  };

  // Staleness: the report must have been regenerated after these artifacts existed, otherwise
  // its numbers and theirs describe different runs.
  if (!r.upstream_line?.present) die(22, 'REPORT_STALE', `out/report.md · ${label}: upstream line says "${r.upstream_line?.text ?? '(absent)'}" although ${upPath} exists — re-run \`node eval/graph-role/report.mjs\`.`);
  if (!r.link_line?.present) die(22, 'REPORT_STALE', `out/report.md · ${label}: link precision line says "${r.link_line?.text ?? '(absent)'}" although ${lpPath} exists — re-run \`node eval/graph-role/report.mjs\`.`);

  // Cross-check: the two sources of the same number must agree (integers exactly, precision to 1e-9).
  const rl = r.upstream_line;
  if (rl.seed_hit !== seed_hit || rl.seed_n !== rows.length || rl.edge_exists !== edge_exists || rl.edge_total !== edge_total) {
    die(23, 'ARTIFACT_MISMATCH', `${label}: report.md says seed ${rl.seed_hit}/${rl.seed_n} edge ${rl.edge_exists}/${rl.edge_total}; ${upPath} gives ${seed_hit}/${rows.length} and ${edge_exists}/${edge_total}.`);
  }
  // NaN comparisons are always false, so a null-vs-number disagreement has to be tested for
  // explicitly rather than left to Math.abs — otherwise the loudest mismatch is the silent one.
  const lpReported = r.link_line.name_precision;
  const bothNull = lpReported === null && link.name_precision === null;
  const oneNull = !bothNull && (lpReported === null || link.name_precision === null);
  if (oneNull || (!bothNull && Math.abs(lpReported - link.name_precision) > 1e-9)) {
    die(23, 'ARTIFACT_MISMATCH', `${label}: report.md link precision(name)=${lpReported}; ${lpPath} gives ${link.name_precision}.`);
  }

  // qrels: optional, same stance as run-upstream.mjs — absent means not measured, never 0.
  const qrelsPath = P('suite', `qrels.${label}.jsonl`);
  const qrelsOnDisk = existsSync(qrelsPath);
  if (qrelsOnDisk) assertFrozen({ rel: `qrels.${label}.jsonl` });
  else console.error(`QRELS_ABSENT ${label} — judged-gold endpoints are not measured (not 0); the decision rides the authored axis.`);
  const recCorpus = rec.corpora?.[label];
  if (recCorpus && recCorpus.qrels_written !== qrelsOnDisk) {
    die(25, 'JUDGING_RECORD_INCONSISTENT', `${label}: judging-record says qrels_written=${recCorpus.qrels_written} but ${qrelsPath} ${qrelsOnDisk ? 'exists' : 'does not exist'}.`);
  }
  if (r.qrels === 'present' && !qrelsOnDisk) die(23, 'ARTIFACT_MISMATCH', `${label}: report.md says qrels present, ${qrelsPath} does not exist.`);

  return { label, report: r, upstream, link, qrels_on_disk: qrelsOnDisk, gold: r.candidate.gold };
}

// ---------------------------------------------------------------------------------------------
// DECISION.md
// ---------------------------------------------------------------------------------------------

function decisionMarkdown({ sel, corpora, th, rec, rep, grade, powerFrozen, followup, coverage }) {
  const L = [];
  const w = (s = '') => L.push(s);
  const branchLabel = BRANCH_LABEL[sel.branch];

  w('# DECISION — graph-role-evaluation (Stage 1, authored axis)');
  w('');
  w(`**갈래 = ${branchLabel}** · 등급 **\`${grade}\`** · 상태 **\`evaluation complete\`** (≠ \`root repair complete\`).`);
  w('');
  if (sel.refusal) w(`> 🔴 **${sel.refusal}** — 표의 조건만으로는 \`${BRANCH_LABEL[sel.would_have_been]}\` 이 성립했으나 등급이 \`${grade}\` 라 delta R7(MUST)·proposal D10 에 따라 거부하고 ⑤ 로 강등했다.`);
  if (sel.refusal) w('');
  w(`생성 ${new Date().toISOString()} · 근거 = \`out/report.md\`(생성 ${rep.generated ?? 'n/a'} · engine head \`${rep.head ?? 'n/a'}\`) + \`out/upstream.<c>.jsonl\` + \`out/link-precision.<c>.json\` + \`suite/judging-record.json\`. 이 파일은 \`run-decision.mjs\` 가 씁니다 — 손으로 고치지 말고 러너를 다시 돌리세요.`);
  w('');
  w(`대상 corpus = **${corpora.map(c => c.label).join(' · ')}** (${coverage.covered}/${coverage.total} of \`lib/paths.mjs\` CORPORA).`);
  w('');
  w(`## 0. 이 판정이 무엇 위에 서 있나 (측정 기반)`);
  w('');
  w(`소비한 리포트 = **${rep.title ?? 'n/a'}** · stage \`${rep.stage ?? 'unknown'}\` · split \`${rep.split ?? 'unknown'}\`.`);
  if (rep.stage === 'stage-1-pilot' || rep.split === 'dev') {
    w('');
    w('🔴 **이 갈래는 holdout 이 아니라 Stage 1 pilot(dev split) 실측 위에서 선택됐다.** 동결 규정(proposal D3/r4)은 결정을 holdout 에서 내리도록 적어 두었으므로, 그 조건은 **충족되지 않았다.** 무엇이 그래도 성립하고 무엇이 성립하지 않는지를 갈라 적는다:');
    w('');
    w('- **성립**: 갈래 ①(`upstream-first`)의 진입 게이트는 *검정력이 필요한 효능 비교*가 아니라 **구조 지표**다 — 소스 문서가 진술하는 관계가 KG 에 존재하는가. 그리고 dev/holdout 분리가 막으려는 누출 통로(**작성자가 답을 보고 문제를 냄**)는 이 suite 에서 **다른 방식으로 이미 닫혀 있다**: A·M 질의 전부가 `author_mode: source-grounded`(작성자는 `documents.content` + `entities.name` 만 열람, `relationships`·`chunk_entities` 금지)이고 `kg-informed` 는 **0건**이다.');
    w('- **성립 안 함**: 그럼에도 이 값의 **두 번째 독립 추정치는 없다.** 그리고 홀드아웃으로 확인할 길이 지금은 막혀 있다 — **holdout 에는 A·M 질의가 존재하지 않는다**(전 corpus `A 30 dev / M 30 dev`, holdout 은 K 뿐: hub 30 · uap 30 · hal 26). `edge_validity` 는 주로 M 브리지 질의에서 나오므로, holdout 판을 만들려면 **T9(A·M holdout 작성·동결)를 먼저 해야 한다.**');
    w('- **등급 귀결**: 이 사유만으로도 결론은 `provisional` 을 벗어날 수 없다. 러너가 이것을 **구조적으로 강제**한다(판정 기록의 `grade` 가 무엇이든 pilot 리포트면 `provisional` 로 내린다).');
    w('');
    w('> 이 절은 *"dev 라 괜찮다"* 도 *"dev 라 틀렸다"* 도 아니다 — **무엇을 쟀고 무엇을 안 쟀는지**를 읽는 사람이 직접 판단할 수 있게 적어 둔 것이다.');
  };
  if (coverage.covered !== coverage.total) w(`⚠ 미포함 = ${coverage.missing.join(', ')} — 이 갈래는 포함된 ${coverage.covered} corpus 위에서만 판정됐다.`);
  w('');

  w('## 1. 결정표 적용 (proposal D8 lines 63–71 · delta R9, gatekeeping 순서 = 첫 참인 갈래)');
  w('');
  w('| 갈래 | 참? | 근거 |');
  w('|---|---|---|');
  for (const t of sel.trace) w(`| ${BRANCH_LABEL[t.branch]} | ${t.taken ? '**예**' : '아니오'} | ${t.detail} |`);
  // "아니오" 와 "평가 안 함" 은 다른 사실이다 — 앞 갈래에서 종료돼 아예 계산되지 않은 갈래를 빈칸으로 두지 않는다.
  const evaluated = new Set(sel.trace.map(t => t.branch));
  for (const b of Object.keys(BRANCH_LABEL)) {
    if (!evaluated.has(b)) w(`| ${BRANCH_LABEL[b]} | — | **평가 안 함** — gatekeeping 순서상 앞 갈래가 참이라 여기까지 오지 않았다(조건 미충족과 다르다) |`);
  }
  w('');
  w('**해석 고정** (표가 남긴 자유도 — 코드 주석 `INTERPRETATIONS` 와 같은 문장):');
  w('- **I-1** *"조정 CI 하한 > 0"* — `report.mjs` 는 **비조정** bootstrap CI + Holm 조정 p 를 낸다(조정 구간이 아니다). 조정은 구간을 넓히기만 하므로 비조정 하한 ≤ 0 이면 조정 절도 실패다. 비조정 하한 > 0 인 경우에만 그 endpoint 의 **Holm 조정 p < α(=`thresholds.json.power.alpha`)** 를 추가로 요구했다.');
  w('- **I-2** corpus 정량자 — 표는 *"corpus 별 ≥ 2/3"* 을 candidate 절에만 적었다. 같은 2/3 다수결을 ②③ 의 semantics 절에 적용하고, **K 안전성·latency SLO 는 안전 게이트라 전 corpus**, ④ 의 futility 도 **전 corpus** 를 요구했다.');
  w('- **I-3** semantics futility — `report.mjs` 는 semantics Δ 의 CI 를 내지 않는다. 그래서 그 endpoint 의 *"CI 상한 < MCID"* 는 **성립 불가**(`SEMANTICS_CI_ABSENT`)이고 ④ 는 현재 보고 형식에서 도달할 수 없다. 어떤 값도 대입하지 않았다.');
  w('- **I-4** *"검정력 확보 상태"* — `suite/POWER.md` 가 `suite/FREEZE.md` 에 해시로 동결돼 있고 해시가 일치할 때만 인정. 현재 = **' + (powerFrozen ? '동결됨' : '동결 안 됨(파일을 쓴 것은 동결이 아니다)') + '**.');
  w('');

  w('## 2. Primary endpoint 5종 — 실측 · 임계 · 판정');
  w('');
  w('gatekeeping 순서 = K 안전성 → latency SLO → candidate → semantics → rerank. **정답원(gold)은 매 줄에 적혀 있다** — 이 회차는 전부 `authored`(suite 자체 정답: K `oracle_chunk_id`/`document_id` · A `source_docs` · M `source_docs`+`family`)다. `judged`(qrels) 축은 성립하지 않았다(§4).');
  w('');
  w('| corpus | gold | (1) K 안전성 Δhit@5 · one-sided 하한 vs −δ | (2) latency SLO warm p95 | (3) candidate Δrecall@30(doc) rrf3−rrf2 · 95% CI vs MCID | (4) semantics real vs shuffle null | (5) rerank ΔnDCG@10 · 95% CI vs MCID |');
  w('|---|---|---|---|---|---|---|');
  for (const c of corpora) {
    const r = c.report;
    w(`| ${c.label} | \`${c.gold}\` | ${f3(r.k.mean)} · 하한 ${f3(r.k.lower)} vs −${r.k.delta === null ? 'n/a' : Math.abs(r.k.delta)} → **${r.k.verdict}** | ≤ ${r.slo.slo_ms}ms → **${r.slo.verdict}** | ${f3(r.candidate.mean)} · CI ${CIs(r.candidate.ci)} vs MCID ${r.candidate.mcid} (Holm p ${f4(r.holm.candidate.raw)}→${f4(r.holm.candidate.adj)}) | real ${f3(r.semantics.real)} · null ${f3(r.semantics.null_mean)} (R=${r.semantics.R}/${r.semantics.R_planned}) · Δ ${f3(r.semantics.delta)} vs MCID ${r.semantics.mcid} · p_null ${f3(r.semantics.p_null)} ≤ ${r.semantics.p_null_max} → **${r.semantics.verdict}** | ${f3(r.rerank.mean)} · CI ${CIs(r.rerank.ci)} vs MCID ${r.rerank.mcid} (Holm p ${f4(r.holm.rerank.raw)}→${f4(r.holm.rerank.adj)}) |`);
  }
  w('');
  w('숫자는 전부 `out/report.md` 에서 **그대로 읽은 값**이다 — 이 스크립트는 통계를 다시 계산하지 않는다(bootstrap CI · sign test · Holm · 각 endpoint 판정은 `report.mjs` 소유). 분모(`n`/`usable`)와 계산 조건은 `out/report.md` 의 같은 줄에 있다.');
  w('');

  w('## 3. semantics 축 (②③ 의 필요조건이자 별도 기록 — proposal D8 각주)');
  w('');
  w('| corpus | real | degree-preserving shuffle null (평균) | Δ vs MCID | p_null vs ≤ | 판정 | Holm 조정 p |');
  w('|---|---|---|---|---|---|---|');
  for (const c of corpora) {
    const s = c.report.semantics;
    w(`| ${c.label} | ${f3(s.real)} | ${f3(s.null_mean)} (R=${s.R}/${s.R_planned}) | ${f3(s.delta)} vs ${s.mcid} | ${f3(s.p_null)} vs ≤${s.p_null_max} | **${s.verdict}** | ${f4(c.report.holm.semantics.adj)} |`);
  }
  w('');
  const semPass = corpora.filter(c => c.report.semantics.verdict === 'PASS').length;
  w(`**읽는 법**: 사전 등록된 게이트는 *Δ ≥ MCID 이면서 raw \`p_null\` ≤ p_null_max* 이고 그 기준으로 **${semPass}/${corpora.length} PASS** 다. 같은 endpoint 의 **Holm 조정 p 는 0.05 를 넘는다** — 이건 endpoint 실패가 아니라 **R(replicate) 의 해상도 한계**다(R=${corpora[0]?.report.semantics.R_planned ?? 'n/a'} 이면 add-one 하한 1/(R+1) 이 Holm 첫 단계 α/m 보다 이미 크다). 상세 = \`out/report.md\` 의 macro 줄.`);
  w('');
  w('그래서 semantics 축의 결론은 *"real 그래프가 degree-preserving null 보다 낫다"* 까지이고, **그 이득이 제품 이득으로 이어졌는지는 (3)(5) 가 답한다** — 둘 다 MCID 미달이다.');
  w('');

  w('## 4. 판정(judging) 기록 — qrels 는 성립하지 않았다');
  w('');
  w(`- 출처: \`${rec.source}\``);
  for (const [label, r] of Object.entries(rec.corpora ?? {})) {
    const kap = r.weighted_kappa ?? {};
    w(`- **${label}**: ${r.pass ?? 'pass1'} · 판정자 ${r.judges ? Object.entries(r.judges).map(([k, v]) => `${k}=${v}`).join(' · ') : 'n/a'} · weighted κ ${Object.entries(kap).map(([k, v]) => `${k} ${v}`).join(' · ') || 'n/a'} vs 게이트 **${rec.gate_kappa_weighted}** → **${r.gate_result ?? 'n/a'}** · qrels 작성 ${r.qrels_written ? '됨' : '**안 됨**'}${r.adjudication ? ` · 조정 ${r.adjudication}` : ''}`);
    if (r.disagreement_profile) w(`  - 불일치 프로파일: ${r.disagreement_profile}`);
  }
  const notJudged = (rec.corpora_not_judged ?? []);
  if (notJudged.length) w(`- 미판정 corpus = ${notJudged.join(', ')} (사용자 결정으로 취소)`);
  w(`- 사람 audit(floor ${th.human_audit.pairs_per_corpus}쌍/corpus): **${rec.human_audit?.present ? '있음' : '없음'}**${rec.human_audit?.note ? ` — ${rec.human_audit.note}` : ''}`);
  if (rec.remedy) w(`- 동결된 미달 구제 절차(`+'`suite/JUDGING.md`'+`): ${rec.remedy.description} · 실행 **${rec.remedy.executed ? '함' : '안 함'}**${rec.remedy.reason ? ` — ${rec.remedy.reason}` : ''}`);
  if (rec.user_decision) {
    w(`- **사용자 결정 (${rec.user_decision.date})**: ${rec.user_decision.decision}`);
    if (rec.user_decision.quote) w(`  - 사용자 원문: *"${rec.user_decision.quote}"*`);
  }
  w('');
  w(`**등급 = \`${grade}\`.** 근거 = qrels 미성립(κ ${Object.values(rec.corpora?.[corpora[0]?.label]?.weighted_kappa ?? {})[0] ?? 'n/a'} < ${rec.gate_kappa_weighted}) + 사람 audit 부재 (proposal D10 · delta R7). **이 등급이 금지하는 것**:`);
  w('- 갈래 ④ `remove-from-ranking` (delta R7 MUST — 이 스크립트가 코드로 막는다).');
  w('- 릴리스 결정(제품 기본값·랭킹 공식 변경의 최종 근거로 쓰는 것). v5.3.0 의 `useGraph` opt-in **containment 는 유지**된다.');
  w('- 허용되는 것 = 갈래 ⑤, 그리고 ②③ 의 **provisional** 판정.');
  w('');

  w('## 5. upstream 증거 (D5 지표 · D8 진입 조건)');
  w('');
  w('| corpus | seed recall | edge validity (기대 edge 가 KG 에 실존) | link precision(name) | 판정 |');
  w('|---|---|---|---|---|');
  for (const g of sel.gates) {
    const c = corpora.find(x => x.label === g.label);
    const p = Object.fromEntries(g.parts.map(x => [x.name, x]));
    w(`| ${g.label} | ${c.upstream.seed_hit}/${c.upstream.n} = ${f3(c.upstream.seed_recall)} vs ≥${p.seed_recall.min} → **${p.seed_recall.verdict}** | ${c.upstream.edge_exists}/${c.upstream.edge_total} = ${f3(c.upstream.edge_validity)} vs ≥${p.edge_validity.min} → **${p.edge_validity.verdict}** | ${f3(c.link.name_precision)} (n=${c.link.name_n} pairs / ${c.link.chunks} chunk clusters) vs ≥${p['link_precision(name)'].min} → **${p['link_precision(name)'].verdict}** | ${g.parts.every(x => x.verdict === 'PASS') ? 'PASS' : '**미달**'} |`);
  }
  w('');
  for (const c of corpora) {
    w(`- **${c.label}** 부가: required edge 중 KG 부재 ${c.upstream.required_missing}건 · link precision weighted ${f3(c.link.weighted_precision)} CI ${CIs(c.link.ci95)} (pairs ${c.link.pairs} / chunks ${c.link.chunks}) · nonliteral ${f3(c.link.nonliteral_precision)} (n=${c.link.nonliteral_n}) · 판정자 신뢰도 ${c.link.reliability ? `n=${c.link.reliability.n} agreement ${f3(c.link.reliability.agreement)} κ ${f3(c.link.reliability.kappa)}` : `없음 (${c.link.reliability_note ?? 'n/a'})`}${c.upstream.skipped ? ` · judged-gold 지표 ${c.upstream.skipped}/${c.upstream.n} 행이 \`${c.upstream.skipped_reason}\` 로 null (**측정 안 됨이지 0 이 아니다**)` : ''}`);
  }
  w('');
  const sr = corpora.map(c => pct(c.upstream.seed_recall)).join(' · ');
  const ev = corpora.map(c => pct(c.upstream.edge_validity)).join(' · ');
  w(`**읽는 법**: seed 는 들어온다(${sr}) — 질의가 가리키는 entity 를 검색이 찾는다. **다리가 없다**(edge validity ${ev}) — 소스 텍스트가 진술하는 관계가 KG 에 대부분 존재하지 않는다. 즉 랭킹 공식 이전에 **탐색할 그래프가 없다**. 이것이 갈래 ① 의 실체다.`);
  w('');

  w('## 6. §227 재현 쿼리 — upstream 수리 후 다시 볼 것 (관찰, 이번 회차에 실행하지 않음)');
  w('');
  w('출처 = hub 로그 `logs/2026-08/2026-08-17.md` §227(표본 2/2 재현). **이 스크립트는 MCP·라이브 DB 를 부르지 않는다** — 아래는 그때 실측된 값을 그대로 옮긴 관찰이고, 후속 change 의 재평가 항목이다.');
  w('');
  for (const q of REPRO_227) {
    w(`${q.n}. *"${q.query}"* (정답 = ${q.gold})`);
    w(`   - 2026-08-17 실측: ${q.observed_2026_08_17}`);
    w('   - **재확인 조건**: upstream change 출하 후 `useGraph: true` 로도 정답이 top-1 이어야 한다(설계 spec `2026-08-17-graph-role-redesign-design.md` §2 의 수용 기준). 기본값 off 로 top-1 인 것은 containment 이지 수리가 아니다.');
  }
  w('');

  w('## 7. 후속 change (delta R11 — 같은 commit 에 존재해야 한다)');
  w('');
  w(`- 갈래 ${branchLabel} 의 D8 후속 = ${followup.d8_followup}`);
  w(`- **개설 대상 = \`specs/changes/${followup.slug}/proposal.md\`** — ${followup.exists ? (followup.scaffolded ? '존재함(이 실행이 증거 블록을 갱신했다)' : '존재함') : '**없음 — 이 commit 에 개설해야 한다(delta R11)**'}`);
  if (followup.why_this_slug) w(`- slug 선택 근거: ${followup.why_this_slug}`);
  w('- 후속 change 의 acceptance 는 최소 넷을 담는다(tasks.md T11 · delta R9): ① 명시적 검색 `mode`(후보 생성 vs 재랭킹) ② edge 방향·type·confidence 취급 ③ latency/quality 예산 ④ 재평가 명령(§9).');
  w('');

  w('## 8. 프레임워크 tracker receipt (delta R11 — DECISION 이 경로를 담는다)');
  w('');
  w('아래는 **프레임워크 hub 폴더**(이 repo 밖)의 경로다. 이 스크립트는 그 파일들을 고치지 않는다 — receipt 가 어디에 남아야 하는지를 기록한다.');
  w('');
  for (const r of TRACKER_RECEIPTS) w(`- \`${r.path}\` — ${r.what}`);
  w('');

  w('## 9. 재평가 명령 (upstream change 출하 후 이 suite 를 그대로 다시 돌린다)');
  w('');
  w('```bash');
  w('# 0) 이 repo 의 워크트리에서, 계측 프로세스는 항상 한 번에 하나 (README)');
  w('node eval/graph-role/snapshot.mjs                     # 3 corpus online backup -> dbs/ (+ snapshot.json)');
  w('for c in hub uap hal; do node eval/graph-role/make-controls.mjs --corpus $c; done   # shuffled-r0..19 · typeshuf-r0..4 · random');
  w('bash eval/graph-role/run-all.sh > eval/graph-role/out/run-all.log 2>&1              # 3 corpus × 27 조건 × 2 러너 (직렬)');
  w('for c in hub uap hal; do node eval/graph-role/run-purevec.mjs --corpus $c; done');
  w('node eval/graph-role/scan-outliers.mjs                # exit 13 이면 해당 쌍만 재실행');
  w('node eval/graph-role/make-manifest.mjs --gzip');
  w('for c in hub uap hal; do node eval/graph-role/run-upstream.mjs $c; done');
  w('for c in hub uap hal; do node eval/graph-role/link-audit-sample.mjs $c; done        # 판정 A/B 후');
  w('for c in hub uap hal; do node eval/graph-role/link-audit-merge.mjs $c; done');
  w('node eval/graph-role/report.mjs                       # -> out/report.md');
  w('node eval/graph-role/power.mjs                        # -> suite/POWER.md');
  w('node eval/graph-role/run-decision.mjs                 # -> eval/graph-role/DECISION.md');
  w('```');
  w('');
  w('판정(qrels) 축까지 되살리려면 그 앞에 `pool.mjs` → `judge-batches.mjs split/merge` → 조정자 C → `judge-merge.mjs <c>` 가 들어가고, **κ ≥ ' + rec.gate_kappa_weighted + ' 를 통과해야** 등급이 `provisional` 을 벗어난다. 사람 audit ' + th.human_audit.pairs_per_corpus + '쌍/corpus 까지 있어야 `decision-grade` 다.');
  w('');

  w('## 10. 상태');
  w('');
  w('- 이 change(`graph-role-evaluation`) = **`evaluation complete`**.');
  w('- **≠ `root repair complete`** — 후속 구현 change 가 출하되고 post-change holdout 을 통과하기 전까지 프레임워크 `current-focus` ② 는 닫지 않으며 v5.3.0 `useGraph` opt-in containment 는 유지된다 (proposal D8 `[r4-B9]`).');
  w('');
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// Follow-up change scaffold. The evidence block is regenerated in place (marker-delimited) so a
// hand-written proposal keeps its design sections while its numbers stay the measured ones.
// ---------------------------------------------------------------------------------------------

const EV_START = '<!-- run-decision:evidence:start -->';
const EV_END = '<!-- run-decision:evidence:end -->';

function evidenceBlock(corpora, th, grade) {
  const L = [EV_START];
  L.push('');
  L.push(`> 이 블록은 \`eval/graph-role/run-decision.mjs\` 가 결정 시점의 실측으로 다시 씁니다(${new Date().toISOString()}). 손으로 고치지 마세요 — 바깥 절은 사람이 씁니다.`);
  L.push('');
  L.push('| corpus | seed recall (≥' + th.upstream_gate.seed_recall_min + ') | edge validity (≥' + th.upstream_gate.edge_validity_min + ') | link precision · name (≥' + th.upstream_gate.link_precision_name_min + ') | link precision · weighted [95% CI] |');
  L.push('|---|---|---|---|---|');
  for (const c of corpora) {
    L.push(`| ${c.label} | ${c.upstream.seed_hit}/${c.upstream.n} = **${pct(c.upstream.seed_recall)}** | ${c.upstream.edge_exists}/${c.upstream.edge_total} = **${pct(c.upstream.edge_validity)}** | ${f3(c.link.name_precision)} (n=${c.link.name_n}) | ${f3(c.link.weighted_precision)} ${CIs(c.link.ci95)} |`);
  }
  L.push('');
  L.push(`- 정답원 = \`authored\`(suite 자체 정답) · 등급 \`${grade}\` · 근거 파일 = \`eval/graph-role/out/upstream.<c>.jsonl\` · \`eval/graph-role/out/link-precision.<c>.json\` · \`eval/graph-role/out/report.md\` · 판정 = \`eval/graph-role/DECISION.md\``);
  L.push(`- required edge 중 KG 부재: ${corpora.map(c => `${c.label} ${c.upstream.required_missing}`).join(' · ')}`);
  L.push('');
  L.push(EV_END);
  return L.join('\n');
}

function scaffoldFollowup(slug, corpora, th, grade) {
  const dir = join(REPO_ROOT, 'specs', 'changes', slug);
  const path = join(dir, 'proposal.md');
  const block = evidenceBlock(corpora, th, grade);
  if (existsSync(path)) {
    const cur = readFileSync(path, 'utf8');
    const i = cur.indexOf(EV_START), j = cur.indexOf(EV_END);
    if (i < 0 || j < 0) { console.error(`FOLLOWUP_EVIDENCE_MARKERS_ABSENT ${path} — evidence block not refreshed (the file has no ${EV_START} / ${EV_END} pair).`); return { path, written: false, refreshed: false }; }
    writeFileSync(path, cur.slice(0, i) + block + cur.slice(j + EV_END.length));
    return { path, written: false, refreshed: true };
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, followupTemplate(slug, block));
  return { path, written: true, refreshed: true };
}

function followupTemplate(slug, block) {
  return `# ${slug} — Proposal

> 이 파일의 **증거 블록만** \`eval/graph-role/run-decision.mjs\` 가 자동 갱신합니다. 나머지는 사람이 씁니다.
> 상위 판정 = \`eval/graph-role/DECISION.md\` (갈래 ① upstream-first).

## Why

Stage 1 평가는 랭킹 공식 이전에 **탐색할 그래프가 없다**는 것을 실측했다. seed 는 게이트를 통과하는데 기대 edge 는 대부분 KG 에 없다.

${block}

## What

(사람이 채운다)

## Acceptance

1. **검색 \`mode\` 명시** — 후보 생성(candidate-generation) 인가 재랭킹(re-rank) 인가를 호출 계약에 박는다.
2. **edge 방향 · type · confidence** 취급을 명시한다.
3. **latency / quality 예산** — warm p95 SLO 와 품질 하한.
4. **재평가 명령** — \`eval/graph-role/DECISION.md\` §9 의 명령을 그대로 다시 돌린다.
`;
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.length) { console.error('usage: run-decision.mjs   (no arguments — reads suite/ and out/ only)'); process.exit(2); }

  // --- freeze checks (R9: 임계값 변조 시 exit 3) ------------------------------------------
  const th = JSON.parse(readFileSync(P('thresholds.json'), 'utf8'));
  assertFrozen({ rel: '../thresholds.json' });
  const freeze = readFreeze();
  const powerPath = P('suite', 'POWER.md');
  const powerFrozen = existsSync(powerPath) && freeze.get('POWER.md') === sha256File(powerPath);

  // --- report.md ------------------------------------------------------------------------
  const reportPath = P('out', 'report.md');
  if (!existsSync(reportPath)) die(18, 'REPORT_MISSING', `${reportPath} — run \`node eval/graph-role/report.mjs\` first.`);
  const labels = Object.keys(CORPORA);
  const rep = parseReport(readFileSync(reportPath, 'utf8'), labels);
  const covered = [...rep.corpora.keys()];
  if (!covered.length) die(19, 'REPORT_PARSE_FAILED', `${reportPath} has no \`## <corpus>\` section for any of ${labels.join(', ')}.`);
  for (const label of covered) assertFrozen({ rel: `queries.${label}.jsonl` });

  const rec = loadJudgingRecord();
  const corpora = covered.map(label => loadCorpus(label, rep, th, rec));
  // A Stage 1 pilot / dev-split report can never carry a decision-grade verdict, whatever
  // suite/judging-record.json says. The record's `grade` is a single unfrozen word and it is the
  // only thing gating branch (4); this makes the pilot case structural instead of trusting it.
  const pilot = rep.stage === 'stage-1-pilot' || rep.split === 'dev';
  const grade = (pilot && rec.grade === 'decision-grade') ? 'provisional' : rec.grade;
  if (pilot && rec.grade !== grade) {
    console.error(`STAGE1_PILOT_DOWNGRADE judging-record says \`${rec.grade}\` but out/report.md declares "${rep.title ?? 'Stage 1 pilot'}" — grade forced to \`provisional\``);
  }

  // --- the table ---------------------------------------------------------------------------
  const sel = selectBranch(corpora, th, { grade, power_attested: powerFrozen });
  const followup = { ...FOLLOWUP[sel.branch] };
  followup.exists = existsSync(join(REPO_ROOT, 'specs', 'changes', followup.slug, 'proposal.md'));

  // --- write (every input is validated above; nothing is written before that) -----------------
  // The follow-up goes first so DECISION.md can state what is actually on disk rather than what
  // was on disk a millisecond earlier.
  let scaffold = null;
  if (followup.scaffold) {
    scaffold = scaffoldFollowup(followup.slug, corpora, th, grade);
    followup.exists = true;
    followup.scaffolded = scaffold.refreshed;   // false when the file exists without the markers
  }

  const coverage = { covered: covered.length, total: labels.length, missing: labels.filter(l => !covered.includes(l)) };
  const md = decisionMarkdown({ sel, corpora, th, rec, rep, grade, powerFrozen, followup, coverage });
  const outPath = P('DECISION.md');
  writeFileSync(outPath, md);

  console.log(`branch = ${BRANCH_LABEL[sel.branch]}${sel.refusal ? ` (refused ${BRANCH_LABEL[sel.would_have_been]}: ${sel.refusal})` : ''} · grade = ${grade} · corpora ${covered.join(',')} (${coverage.covered}/${coverage.total})`);
  for (const t of sel.trace) console.log(`  ${t.taken ? '->' : '  '} ${BRANCH_LABEL[t.branch]}: ${t.detail}`);
  console.log(`wrote ${outPath}`);
  if (scaffold) console.log(`follow-up ${scaffold.written ? 'created' : (scaffold.refreshed ? 'evidence refreshed' : 'left untouched')}: ${scaffold.path}`);
  if (!followup.exists) die(26, 'FOLLOWUP_CHANGE_MISSING', `specs/changes/${followup.slug}/proposal.md — delta R11 requires the selected branch's follow-up change in the same commit. DECISION.md was written; open the change and re-run.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
