// T11 — run-decision.mjs: the five-way gatekeeping table, the required-artifact gates, and the
// provisional guard that forbids branch (4) `remove-from-ranking`.
//
// Pure: every run happens inside a tmp-dir sandbox laid out as <tmp>/repo/eval/graph-role, so
// lib/paths.mjs resolves EVAL_DIR to the sandbox and REPO_ROOT to <tmp>/repo. No DB, no engine,
// no network, and nothing under the real eval/graph-role/{suite,out,pool,links} or the real
// specs/ is read or written. The report.md fixtures are written in report.mjs's own line
// grammar — that grammar is the contract this script consumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(REPO, 'eval', 'graph-role');
const SCRIPT = 'run-decision.mjs';
// realpath: on macOS tmpdir() is /var/... -> /private/var/..., and the script's
// `import.meta.url === file://${process.argv[1]}` CLI guard compares the resolved module URL
// against the raw argv path — an unresolved tmp path makes the script a silent no-op.
const TMP = realpathSync(tmpdir());

function sandbox() {
  const root = mkdtempSync(join(TMP, 'gr-t11-'));
  const dir = join(root, 'repo', 'eval', 'graph-role');
  for (const sub of ['suite', 'out']) mkdirSync(join(dir, sub), { recursive: true });
  cpSync(join(SRC, 'lib'), join(dir, 'lib'), { recursive: true });
  copyFileSync(join(SRC, 'thresholds.json'), join(dir, 'thresholds.json'));
  copyFileSync(join(SRC, SCRIPT), join(dir, SCRIPT));
  return { root, dir };
}
const teardown = (s) => rmSync(s.root, { recursive: true, force: true });
const run = (s) => spawnSync(process.execPath, [join(s.dir, SCRIPT)], { encoding: 'utf8' });
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const writeJsonl = (p, rows) => writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const proposalPath = (s, slug) => join(s.root, 'repo', 'specs', 'changes', slug, 'proposal.md');

// FREEZE.md is what lib/freeze.mjs reads; `rels` are resolved against suite/.
function freeze(s, rels) {
  const rows = rels.map(r => `| \`${r}\` | ${sha(join(s.dir, 'suite', r))} | test | \`test\` |`);
  writeFileSync(join(s.dir, 'suite', 'FREEZE.md'), ['# FREEZE', '', '| file | sha256 | frozen_at | commit |', '|---|---|---|---|', ...rows, ''].join('\n'));
}

// ---- fixture builders ------------------------------------------------------------------------

// run-upstream.mjs row shape. Sums (seed hits, edge exists/total) are what run-decision reads;
// they are distributed over n rows so the file looks like a real run rather than one fat row.
function upstreamRows(label, { n, seedHit, edgeTotal, edgeExists, requiredMissing }) {
  const rows = [];
  let tLeft = edgeTotal, eLeft = edgeExists, rLeft = requiredMissing;
  for (let i = 0; i < n; i++) {
    const t = Math.min(tLeft, Math.ceil(tLeft / (n - i)));
    tLeft -= t;
    const e = Math.min(eLeft, t); eLeft -= e;
    const rm = Math.min(rLeft, t - e); rLeft -= rm;
    rows.push({
      id: `${label}-A-${i + 1}`, class: i % 2 ? 'M' : 'A', author_mode: 'source-grounded',
      seed_recall: i < seedHit ? 1 : 0, seeds_hit: i < seedHit ? ['E1'] : [],
      edge_validity: { total: t, exists: e, direction_ok: e, type_ok: e, required_missing: rm },
      encoded_path_coverage: null, projection_recall: null, hubdeg_misrank: null,
      skipped: 'qrels-absent', skipped_metrics: ['projection_recall', 'hubdeg_misrank'],
    });
  }
  return rows;
}

const linkPrecision = (name, n = 50) => ({
  by_stratum: { low: { n: 20, precision: name }, mid: { n: 20, precision: name }, high: { n: 10, precision: name } },
  by_provenance: { name: { n, precision: name }, nonliteral: { n: 10, precision: 0.4 } },
  weighted_precision: name, ci95: [Math.max(0, name - 0.08), Math.min(1, name + 0.06)],
  chunks: 20, pairs: n + 10, reliability: { n: 12, agreement: 0.917, kappa: 0.81 }, reliability_note: null,
});

// report.mjs's own line grammar, corpus by corpus.
// `stage2: true` emits the header a real holdout report carries. The default stays the Stage 1
// pilot header because that is what report.mjs writes today — but a test that wants to exercise
// "decision-grade unlocks branch (4)" must NOT use it: run-decision downgrades any pilot report to
// `provisional` on purpose, so the pilot header would make that test assert the wrong thing.
function reportMd(sections, { stage2 = false } = {}) {
  const L = stage2 ? [
    '# graph-role evaluation report — Stage 2 (holdout · SUMMARIES=off)', '',
    'Holdout run. A decision branch may be taken from this report (proposal D3/r4).', '',
  ] : [
    '# graph-role evaluation report — Stage 1 pilot (dev split · SUMMARIES=off)', '',
    '**PROVISIONAL.** Stage 1 is a pilot for variance, not for conclusions (proposal D3/r4).', '',
    'Generated 2026-08-20T07:00:00.000Z · engine worktree head `deadbee` · node v22.11.0.', '',
  ];
  for (const s of sections) {
    L.push(`## ${s.label}`, '');
    L.push('Measured rows: 113 (split dev) — K 53 · A 30 · M 30. Suite file holds 120 rows (dev+holdout).');
    L.push(`qrels: **absent** (\`suite/qrels.${s.label}.jsonl\` does not exist — judging pass 1 has not produced it). Primary gold = **authored**; every judged-gold line below says \`qrels absent\`.`);
    L.push('', '### Primary endpoints (gatekeeping order)', '');
    L.push(`- **(1) K-safety** Δhit@5(on−off), oracle chunk · gold=authored (suite oracle; needs no judging): mean ${s.k.mean} · one-sided 95% lower ${s.k.lower} vs −δ=-0.02 → **${s.k.verdict}** · worse/same/better 16/37/0 · sign p=3.05e-5 · cluster=document · n=53 usable=53`);
    L.push(`- **(2) latency-SLO** (gold=n/a — latency is gold-independent) warm p95 ms ≤ 1000 → **${s.slo}** · channels vector=40 · fts=6 · final off/on=19/28 · cold p95=950 (recorded, not gated) · n=113 usable=112 (first row dropped: process warm-up)`);
    L.push(`- **(3) candidate** Δrecall@30(doc) rrf3−rrf2, A+M · gold=authored **[primary]**: mean ${s.cand.mean} · 95% CI [${s.cand.ci[0]}, ${s.cand.ci[1]}] · MCID 0.05 · worse/same/better 3/54/3 · sign p=1.0000 · cluster=family · n=60 usable=60`);
    L.push(`- **(4) semantics** graph-n1 recall@30(doc) real vs degree-preserving shuffle null, A+M · gold=authored **[primary]**: real ${s.sem.real} · null mean ${s.sem.nullMean} (R=20/20) · Δ ${s.sem.delta} vs MCID 0.03 · p_null ${s.sem.pNullCount}/20=${s.sem.pNull} vs ≤0.05 → **${s.sem.verdict}** · resolution floor 1/20=0.050, add-one estimate 0.048${s.sem.ci ? ` · semantics 95% CI [${s.sem.ci[0]}, ${s.sem.ci[1]}]` : ''} · n=60 usable=60`);
    L.push(`- **(5) rerank** ΔnDCG@10 fixed-pool(with_graph−base), A+M, pool = product base@30 · gold=authored **[primary]**: mean ${s.rer.mean} · 95% CI [${s.rer.ci[0]}, ${s.rer.ci[1]}] · MCID 0.05 · worse/same/better 7/35/18 · sign p=0.0433 · cluster=family · n=60 usable=60 · authored gold is binary (gain 1), so this nDCG is a binary-relevance nDCG`);
    L.push('');
    L.push(`- **Holm** over the pre-declared efficacy family (m=3, family size held at 3 even when an endpoint is not estimable — those enter as p=1, which is conservative) · gold=authored: candidate p=${s.holm.cand[0]}→${s.holm.cand[1]} · semantics p=${s.holm.sem[0]}→${s.holm.sem[1]} · rerank p=${s.holm.rer[0]}→${s.holm.rer[1]} · n=3 usable=3`);
    L.push('', '### Exploratory (descriptive — never a gate, never a power input)', '');
    if (s.up) {
      const seedR = (s.up.seedHit / s.up.n).toFixed(3), edgeR = (s.up.edgeExists / s.up.edgeTotal).toFixed(3);
      L.push(`- upstream gates (D5) · gold=authored (the suite's \`seed_candidates\` and \`expected_paths\`): seed_recall ${s.up.seedHit}/${s.up.n} = ${seedR} vs ≥0.7 · edge_validity ${s.up.edgeExists}/${s.up.edgeTotal} = ${edgeR} vs ≥0.8 · projection_recall mean n/a · n=${s.up.n} usable=${s.up.n}`);
    } else {
      L.push(`- upstream gates · gold=authored: \`out/upstream.${s.label}.jsonl\` absent — **upstream not run** · n=0 usable=0`);
    }
    if (s.lp !== undefined && s.lp !== null) {
      L.push(`- link precision · gold=link-audit judge (a separate mention judgement, not qrels): name ${s.lp} (n=50) vs ≥0.6 · nonliteral 0.4 (n=10) · weighted ${s.lp} CI [${Math.max(0, s.lp - 0.08)},${Math.min(1, s.lp + 0.06)}] · n=60 usable=20 chunk clusters`);
    } else {
      L.push(`- link precision · gold=link-audit judge: \`out/link-precision.${s.label}.json\` absent — **link audit not merged** (judge-A verdicts pending) · n=0 usable=0`);
    }
    L.push('');
  }
  L.push('## Corpus-stratified macro (mean of corpus means — no naive pooling)', '');
  L.push('- Stage 2 branch inputs (counts only — the branch is decided on holdout): candidate point ≥ MCID 0.05 in 0/3 corpora · gold=per-corpus primary · n=3 usable=3', '');
  L.push('## Reading this report', '');
  return L.join('\n') + '\n';
}

const judgingRecord = (grade) => ({
  recorded_at: '2026-08-20', gate_kappa_weighted: 0.67, grade,
  grade_reason: 'test fixture', source: 'test fixture ledger',
  corpora: {
    hub: { pass: 'pass 1 (fixed depth 10)', judges: { A: 'judge-a', B: 'judge-b' }, weighted_kappa: { all: 0.619, A: 0.659, M: 0.571 }, gate_result: 'KAPPA_BELOW_GATE (judge-merge.mjs exit 8)', qrels_written: false, disagreement_profile: 'agree 2916/4135 (70.5%)' },
    uap: { pass: 'not judged', qrels_written: false, gate_result: 'n/a' },
    hal: { pass: 'not judged', qrels_written: false, gate_result: 'n/a' },
  },
  corpora_not_judged: ['uap', 'hal'],
  human_audit: { present: false, note: 'not spent' },
  remedy: { description: 'revise rubric + re-judge both judges', executed: false, reason: 'user decision' },
  user_decision: { date: '2026-08-20', decision: 'stop at the kappa gate; conclude on the authored axis', quote: '구축개선 할때 graph rag을 확실히 조사해서 구축하자' },
});

// The measured Stage-1 pattern: K-safety FAIL, candidate/rerank null effect, semantics PASS,
// seeds present but bridges absent (edge validity 19.4% / 17.7% / 7.7%).
const REAL = {
  hub: { up: { n: 60, seedHit: 57, edgeTotal: 62, edgeExists: 12, requiredMissing: 50 }, k: { mean: '-0.302', lower: '-0.415', verdict: 'FAIL' }, cand: { mean: '0.000', ci: ['-0.040', '0.042'] }, rer: { mean: '0.015', ci: ['-0.024', '0.053'] }, sem: { real: '0.300', nullMean: '0.110', delta: '0.190', pNullCount: 0, pNull: '0.000', verdict: 'PASS' }, holm: { cand: ['1.0000', '1.0000'], sem: ['0.0476', '0.1299'], rer: ['0.0433', '0.1299'] } },
  uap: { up: { n: 60, seedHit: 56, edgeTotal: 62, edgeExists: 11, requiredMissing: 51 }, k: { mean: '-0.296', lower: '-0.407', verdict: 'FAIL' }, cand: { mean: '0.000', ci: ['-0.055', '0.050'] }, rer: { mean: '0.015', ci: ['-0.003', '0.034'] }, sem: { real: '0.481', nullMean: '0.201', delta: '0.279', pNullCount: 0, pNull: '0.000', verdict: 'PASS' }, holm: { cand: ['1.0000', '1.0000'], sem: ['0.0476', '0.1429'], rer: ['0.6072', '1.0000'] } },
  hal: { up: { n: 60, seedHit: 56, edgeTotal: 65, edgeExists: 5, requiredMissing: 60 }, k: { mean: '-0.196', lower: '-0.286', verdict: 'FAIL' }, cand: { mean: '0.042', ci: ['0.008', '0.080'] }, rer: { mean: '0.035', ci: ['-0.013', '0.079'] }, sem: { real: '0.572', nullMean: '0.231', delta: '0.341', pNullCount: 0, pNull: '0.000', verdict: 'PASS' }, holm: { cand: ['0.0625', '0.0952'], sem: ['0.0476', '0.0952'], rer: ['0.0046', '0.0137'] } },
};

// Builds the whole input set. `over` patches per-corpus fields; `omit` drops artifacts.
function fixture(s, { grade = 'provisional', over = {}, omitLinkPrecision = [], powerFrozen = false, base = REAL, stage2 = false } = {}) {
  const labels = ['hub', 'uap', 'hal'];
  const sections = labels.map(label => {
    const b = { label, slo: 'PASS', ...base[label], ...(over[label] ?? {}) };
    return { ...b, lp: omitLinkPrecision.includes(label) ? null : (b.linkName ?? 0.82) };
  });
  for (const label of labels) {
    writeFileSync(join(s.dir, 'suite', `queries.${label}.jsonl`), JSON.stringify({ id: `${label}-A-1`, class: 'A' }) + '\n');
    const sec = sections.find(x => x.label === label);
    writeJsonl(join(s.dir, 'out', `upstream.${label}.jsonl`), upstreamRows(label, sec.up));
    if (!omitLinkPrecision.includes(label)) writeFileSync(join(s.dir, 'out', `link-precision.${label}.json`), JSON.stringify(linkPrecision(sec.lp), null, 2) + '\n');
  }
  writeFileSync(join(s.dir, 'out', 'report.md'), reportMd(sections, { stage2 }));
  writeFileSync(join(s.dir, 'suite', 'judging-record.json'), JSON.stringify(judgingRecord(grade), null, 2) + '\n');
  const frozen = ['queries.hub.jsonl', 'queries.uap.jsonl', 'queries.hal.jsonl', '../thresholds.json'];
  if (powerFrozen) { writeFileSync(join(s.dir, 'suite', 'POWER.md'), '# POWER (fixture)\n'); frozen.push('POWER.md'); }
  freeze(s, frozen);
}

// ---- (a) the measured pattern selects upstream-first ------------------------------------------

test('(a) the Stage-1 pattern (K FAIL · candidate null effect · semantics PASS · edge-starved graph) selects upstream-first', () => {
  const s = sandbox();
  try {
    fixture(s);
    const r = run(s);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /branch = ① upstream-first/);

    const md = readFileSync(join(s.dir, 'DECISION.md'), 'utf8');
    assert.match(md, /\*\*갈래 = ① upstream-first\*\*/);
    // the branch was taken on the gate, and the gate's failing component is named with its numbers
    assert.match(md, /hub\.edge_validity=0\.194 < 0\.8/);
    assert.match(md, /hal\.edge_validity=0\.077 < 0\.8/);
    // seed recall is NOT the failing component — the evidence table has to show it passing
    assert.match(md, /57\/60 = 0\.950 vs ≥0\.7 → \*\*PASS\*\*/);
    // branches after the selected one were not evaluated, and the table must say so rather than
    // leaving a reader to read "아니오" into a blank ("게이트가 죽은 것과 실패한 것은 다른 사실")
    assert.match(md, /\| ② candidate-generation\+RRF \| — \| \*\*평가 안 함\*\*/);
    assert.match(md, /\| ④ remove-from-ranking \| — \| \*\*평가 안 함\*\*/);
    // link precision was consumed from the artifact, not invented
    assert.match(md, /0\.820 \(n=50 pairs \/ 20 chunk clusters\) vs ≥0\.6 → \*\*PASS\*\*/);

    // provisional guard is stated in the decision, not just implied
    assert.match(md, /등급 \*\*`provisional`\*\*/);
    assert.match(md, /갈래 ④ `remove-from-ranking` \(delta R7 MUST/);
    // the judging record is quoted (kappa below gate, qrels not written, user decision)
    assert.match(md, /weighted κ all 0\.619 · A 0\.659 · M 0\.571 vs 게이트 \*\*0\.67\*\*/);
    assert.match(md, /qrels 작성 \*\*안 됨\*\*/);
    assert.match(md, /stop at the kappa gate/);
    // the two §227 reproduction queries ride along as observations
    assert.match(md, /경고를 내는 훅이 계약 밖 값을 반환해서 위험할 때만 조용히 죽었다/);
    assert.match(md, /빈 디렉터리 사슬이 경로 길이 제한 때문에 검사를 죽이고 있었다/);
    // tracker receipt paths + re-evaluation command
    assert.match(md, /decisions\/current-focus\.md/);
    assert.match(md, /2026-08-17-graph-role-redesign-design\.md/);
    assert.match(md, /node eval\/graph-role\/run-decision\.mjs/);
    assert.match(md, /`evaluation complete`/);

    // the follow-up change is scaffolded in the same run, with the measured numbers injected
    assert.match(md, /`specs\/changes\/graph-upstream-build\/proposal\.md`\*\* — 존재함\(이 실행이 증거 블록을 갱신했다\)/);
    const prop = readFileSync(proposalPath(s, 'graph-upstream-build'), 'utf8');
    assert.match(prop, /\| hub \| 57\/60 = \*\*95\.0%\*\* \| 12\/62 = \*\*19\.4%\*\*/);
    assert.match(prop, /\| hal \| 56\/60 = \*\*93\.3%\*\* \| 5\/65 = \*\*7\.7%\*\*/);
    assert.match(prop, /0\.820 \(n=50\)/);
    assert.doesNotMatch(prop, /TBD|TODO|placeholder|\bXXX\b/);
  } finally { teardown(s); }
});

// Mutation check for (a): the branch must come from the gate, not from a default. Lifting every
// corpus's edge validity over the 0.80 gate (nothing else changed) has to move the verdict off
// upstream-first — otherwise the assertions above would pass on a runner that ignores the gate.
test('(a-mutation) with the edge-validity gate satisfied the same inputs no longer select upstream-first', () => {
  const s = sandbox();
  try {
    const healthy = Object.fromEntries(Object.entries(REAL).map(([l, v]) => [l, { up: { ...v.up, edgeExists: Math.ceil(v.up.edgeTotal * 0.9), requiredMissing: 0 } }]));
    fixture(s, { over: healthy });
    const r = run(s);
    assert.doesNotMatch(r.stdout, /branch = ① upstream-first/);
    // K-safety FAIL blocks (2)/(3) and futility is not established, so the table lands on (5)
    assert.match(r.stdout, /branch = ⑤ inconclusive → expand-evaluation/);
    assert.equal(r.status, 26, 'the (5) follow-up change does not exist in the sandbox, so R11 fires');
    assert.match(r.stderr, /FOLLOWUP_CHANGE_MISSING/);
  } finally { teardown(s); }
});

// ---- (b) a missing required artifact is a named exit, and writes nothing ----------------------

test('(b) missing link-precision exits LINK_PRECISION_MISSING (21) and writes no DECISION.md', () => {
  const s = sandbox();
  try {
    fixture(s, { omitLinkPrecision: ['hal'] });
    const r = run(s);
    assert.equal(r.status, 21, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /^LINK_PRECISION_MISSING .*link-precision\.hal\.json/m);
    assert.equal(existsSync(join(s.dir, 'DECISION.md')), false, 'no DECISION.md may be written from a partial input set');
    assert.equal(existsSync(proposalPath(s, 'graph-upstream-build')), false);
  } finally { teardown(s); }
});

test('(b2) missing upstream jsonl exits UPSTREAM_MISSING (20); missing report.md exits REPORT_MISSING (18)', () => {
  const s = sandbox();
  try {
    fixture(s);
    rmSync(join(s.dir, 'out', 'upstream.uap.jsonl'));
    const r = run(s);
    assert.equal(r.status, 20, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /^UPSTREAM_MISSING .*upstream\.uap\.jsonl/m);
    assert.equal(existsSync(join(s.dir, 'DECISION.md')), false);

    rmSync(join(s.dir, 'out', 'report.md'));
    const r2 = run(s);
    assert.equal(r2.status, 18, `${r2.stdout}\n${r2.stderr}`);
    assert.match(r2.stderr, /^REPORT_MISSING/m);
  } finally { teardown(s); }
});

test('(b3) a report.md older than the artifacts it must describe is REPORT_STALE (22)', () => {
  const s = sandbox();
  try {
    fixture(s);
    // report.md still carries the "upstream not run" line although out/upstream.*.jsonl exist
    const stale = reportMd(['hub', 'uap', 'hal'].map(label => ({ label, slo: 'PASS', ...REAL[label], up: null, lp: null })));
    writeFileSync(join(s.dir, 'out', 'report.md'), stale);
    const r = run(s);
    assert.equal(r.status, 22, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /^REPORT_STALE .*upstream line says/m);
    assert.equal(existsSync(join(s.dir, 'DECISION.md')), false);
  } finally { teardown(s); }
});

test('(b4) report.md and the raw artifact disagreeing on the same number is ARTIFACT_MISMATCH (23)', () => {
  const s = sandbox();
  try {
    fixture(s);
    // drop one seed hit from the raw file only; report.md still says 57/60
    const rows = readFileSync(join(s.dir, 'out', 'upstream.hub.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    rows[0].seed_recall = 0;
    writeJsonl(join(s.dir, 'out', 'upstream.hub.jsonl'), rows);
    const r = run(s);
    assert.equal(r.status, 23, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /^ARTIFACT_MISMATCH hub: report\.md says seed 57\/60 .*gives 56\/60/m);
    assert.equal(existsSync(join(s.dir, 'DECISION.md')), false);

    // and a null-vs-number disagreement is caught too (Math.abs would silently pass it)
    fixture(s);
    const lp = JSON.parse(readFileSync(join(s.dir, 'out', 'link-precision.hub.json'), 'utf8'));
    lp.by_provenance.name.precision = null;
    writeFileSync(join(s.dir, 'out', 'link-precision.hub.json'), JSON.stringify(lp, null, 2) + '\n');
    const r2 = run(s);
    assert.equal(r2.status, 23, `${r2.stdout}\n${r2.stderr}`);
    assert.match(r2.stderr, /^ARTIFACT_MISMATCH hub: report\.md link precision\(name\)=0\.82/m);
  } finally { teardown(s); }
});

// ---- (c) the provisional guard: a fixture that would select `remove` is refused ---------------

// Every upstream gate satisfied, K/SLO fine, and all three efficacy endpoints futile (CI upper <
// MCID) with POWER.md frozen — i.e. the table's own branch (4) conditions hold. Grade is
// `provisional`, so delta R7 (MUST) forbids it and the verdict is downgraded to (5).
const FUTILE = Object.fromEntries(Object.entries(REAL).map(([l, v]) => [l, {
  up: { ...v.up, edgeExists: Math.ceil(v.up.edgeTotal * 0.9), requiredMissing: 0 },
  k: { mean: '0.001', lower: '-0.005', verdict: 'PASS' },
  cand: { mean: '0.002', ci: ['-0.020', '0.010'] },
  rer: { mean: '0.001', ci: ['-0.020', '0.012'] },
  sem: { real: '0.300', nullMean: '0.295', delta: '0.005', pNullCount: 9, pNull: '0.450', verdict: 'FAIL', ci: ['-0.010', '0.020'] },
  holm: { cand: ['0.8000', '1.0000'], sem: ['0.4762', '1.0000'], rer: ['0.7000', '1.0000'] },
}]));

test('(c) futility + provisional grade: branch (4) remove-from-ranking is refused and downgraded to (5)', () => {
  const s = sandbox();
  try {
    fixture(s, { grade: 'provisional', over: FUTILE, powerFrozen: true });
    const r = run(s);
    assert.match(r.stdout, /branch = ⑤ inconclusive → expand-evaluation \(refused ④ remove-from-ranking: REMOVE_FORBIDDEN_ON_PROVISIONAL\)/);
    const md = readFileSync(join(s.dir, 'DECISION.md'), 'utf8');
    assert.match(md, /\*\*갈래 = ⑤ inconclusive → expand-evaluation\*\*/);
    assert.match(md, /REMOVE_FORBIDDEN_ON_PROVISIONAL/);
    assert.match(md, /조건 성립하나 \*\*거부\*\*: qrels 등급 `provisional`/);
    // the refused branch is not silently dropped from the trace
    assert.match(md, /futility\(CI 상한 < MCID\) candidate 3\/3 · rerank 3\/3 · semantics 3\/3/);
    // R11 gate: the (5) follow-up change is not open in this sandbox
    assert.equal(r.status, 26, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /FOLLOWUP_CHANGE_MISSING .*graph-role-evaluation-expand/);
    assert.equal(existsSync(proposalPath(s, 'graph-upstream-build')), false, 'only the upstream-first branch scaffolds');
  } finally { teardown(s); }
});

// Mutation check for (c): the refusal must come from the grade, not from the branch being
// unreachable. The same inputs with `decision-grade` have to reach (4).
// The report must be a Stage 2 holdout run — see (c-stage1) for why a pilot report cannot.
test('(c-mutation) the identical futility fixture at decision-grade does select remove-from-ranking', () => {
  const s = sandbox();
  try {
    fixture(s, { grade: 'decision-grade', over: FUTILE, powerFrozen: true, stage2: true });
    const r = run(s);
    assert.match(r.stdout, /branch = ④ remove-from-ranking/);
    assert.doesNotMatch(r.stdout, /REMOVE_FORBIDDEN_ON_PROVISIONAL/);
    const md = readFileSync(join(s.dir, 'DECISION.md'), 'utf8');
    assert.match(md, /\*\*갈래 = ④ remove-from-ranking\*\*/);
  } finally { teardown(s); }
});

// The grade in suite/judging-record.json is a single unfrozen word and it is the only thing
// gating branch (4). A Stage 1 pilot / dev-split report can never support a decision-grade
// verdict, so the runner forces the downgrade structurally rather than trusting that word.
// Measured 2026-08-22: the same fixture as (c-mutation) minus `stage2` must land on (5).
test('(c-stage1) a Stage 1 pilot report at decision-grade is downgraded and (4) stays refused', () => {
  const s = sandbox();
  try {
    fixture(s, { grade: 'decision-grade', over: FUTILE, powerFrozen: true });
    const r = run(s);
    assert.match(r.stderr, /STAGE1_PILOT_DOWNGRADE/);
    assert.match(r.stdout, /grade = provisional/);
    assert.match(r.stdout, /REMOVE_FORBIDDEN_ON_PROVISIONAL/);
    assert.doesNotMatch(r.stdout, /branch = ④ remove-from-ranking/);
    const md = readFileSync(join(s.dir, 'DECISION.md'), 'utf8');
    assert.match(md, /Stage 1 pilot\(dev split\) 실측 위에서 선택됐다/);
    assert.match(md, /holdout 에는 A·M 질의가 존재하지 않는다/);
  } finally { teardown(s); }
});

// A level-2 heading closes a corpus section; `###` subheadings inside it must not. Without the
// first half, endpoint-shaped lines under "## Corpus-stratified macro …" silently overwrote the
// last corpus; without the second, every corpus lost its endpoints. Both measured 2026-08-22.
test('(g) a spaced level-2 heading closes the section, but ### subheadings do not', async () => {
  const { parseReport } = await import('../eval/graph-role/run-decision.mjs');
  const K = (mean, lower, verdict) =>
    `- **(1) K-safety** Δhit@5(on−off), oracle chunk · gold=authored (suite oracle; needs no judging): mean ${mean} · one-sided 95% lower ${lower} vs −δ=-0.02 → **${verdict}** · n=53 usable=53`;
  const base = [
    '# graph-role evaluation report — Stage 1 pilot (dev split · SUMMARIES=off)', '',
    'Generated 2026-08-20T07:00:00.000Z · engine worktree head `deadbee` · node v22.11.0.', '',
    '## hub', '',
    '### Primary endpoints (gatekeeping order)', '',
    K('-0.302', '-0.415', 'FAIL'), '',
  ].join('\n');
  const hub = parseReport(base, ['hub', 'uap', 'hal']).corpora.get('hub');
  assert.deepEqual(hub.k?.verdict, 'FAIL', '### subheadings must not close the corpus section');

  const injected = base + ['', '## Corpus-stratified macro (mean of corpus means)', '', K('0.999', '0.500', 'PASS'), ''].join('\n');
  const after = parseReport(injected, ['hub', 'uap', 'hal']).corpora.get('hub');
  assert.deepEqual(after.k, hub.k, 'a spaced level-2 heading must not leak into the previous corpus');
});

// Same futility, but POWER.md is not frozen: "검정력 확보 상태" (I-4) is unmet, so (4) is not
// reachable even at decision-grade. Guards against the futility clause standing on its own.
test('(c-power) futility at decision-grade without a frozen POWER.md stays inconclusive', () => {
  const s = sandbox();
  try {
    fixture(s, { grade: 'decision-grade', over: FUTILE, powerFrozen: false });
    const r = run(s);
    assert.match(r.stdout, /branch = ⑤ inconclusive → expand-evaluation/);
    assert.doesNotMatch(r.stdout, /refused/);
  } finally { teardown(s); }
});

// ---- freeze + judging-record gates ------------------------------------------------------------

test('(d) a tampered thresholds.json is FROZEN_MISMATCH (3) and a missing judging record is 24', () => {
  const s = sandbox();
  try {
    fixture(s);
    rmSync(join(s.dir, 'suite', 'judging-record.json'));
    const r = run(s);
    assert.equal(r.status, 24, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /^JUDGING_RECORD_MISSING/m);
    assert.equal(existsSync(join(s.dir, 'DECISION.md')), false);

    fixture(s);   // restore, then move a frozen threshold
    const th = JSON.parse(readFileSync(join(s.dir, 'thresholds.json'), 'utf8'));
    th.upstream_gate.edge_validity_min = 0.05;
    writeFileSync(join(s.dir, 'thresholds.json'), JSON.stringify(th, null, 2) + '\n');
    const r2 = run(s);
    assert.equal(r2.status, 3, `${r2.stdout}\n${r2.stderr}`);
    assert.match(r2.stderr, /FROZEN_MISMATCH \.\.\/thresholds\.json/);
    assert.equal(existsSync(join(s.dir, 'DECISION.md')), false);
  } finally { teardown(s); }
});

test('(e) judging-record that contradicts the qrels on disk is 25', () => {
  const s = sandbox();
  try {
    fixture(s);
    const rec = judgingRecord('provisional');
    rec.corpora.hub.qrels_written = true;          // no suite/qrels.hub.jsonl exists
    writeFileSync(join(s.dir, 'suite', 'judging-record.json'), JSON.stringify(rec, null, 2) + '\n');
    const r = run(s);
    assert.equal(r.status, 25, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /^JUDGING_RECORD_INCONSISTENT hub/m);
    assert.equal(existsSync(join(s.dir, 'DECISION.md')), false);
  } finally { teardown(s); }
});

// ---- the follow-up evidence block is refreshed, not overwritten -------------------------------

test('(f) re-running refreshes only the marker-delimited evidence block of an existing proposal', () => {
  const s = sandbox();
  try {
    fixture(s);
    assert.equal(run(s).status, 0);
    const p = proposalPath(s, 'graph-upstream-build');
    const edited = readFileSync(p, 'utf8').replace('## What', '## What\n\nHAND WRITTEN SECTION KEPT.');
    writeFileSync(p, edited);

    // second run with a different measured link precision
    fixture(s, { over: { hub: { linkName: 0.71 }, uap: { linkName: 0.71 }, hal: { linkName: 0.71 } } });
    assert.equal(run(s).status, 0);
    const after = readFileSync(p, 'utf8');
    assert.match(after, /HAND WRITTEN SECTION KEPT\./, 'hand-written prose survives');
    assert.match(after, /0\.710 \(n=50\)/, 'the evidence block carries the new measurement');
    assert.doesNotMatch(after, /0\.820 \(n=50\)/, 'the old measurement is gone');
    assert.equal((after.match(/<!-- run-decision:evidence:start -->/g) || []).length, 1);
  } finally { teardown(s); }
});
