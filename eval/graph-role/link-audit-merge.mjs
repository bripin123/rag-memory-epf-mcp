// Task 7 Step 3b — link-audit merge: joins the sampled chunk<->entity pairs (link-audit-sample.mjs)
// with the judge's mention/no-mention verdicts, clusters by chunk (a judged pair is NOT an
// independent observation -- up to 15 pairs share one chunk_text, read by the same judge in one
// pass -- so precision CIs must resample chunks, not pairs), and reports precision by stratum / by
// provenance plus a prevalence-weighted overall estimate with a percentile bootstrap CI.
//
// Deviations from the brief (task-7 dispatch decisions):
//  1. Reads from eval/graph-role/links/ instead of pool/ -- pool/ is Task 6's live output directory
//     while judging runs concurrently (never touch anything under it). out/link-precision.<c>.json
//     is unaffected (brief's path, unchanged).
//  2. The brief's inline computation is factored into named pure exports (precisionOf /
//     clusterByChunk / byStratum / byProvenance / weightedPrecision / bootstrapCI) so they are
//     unit-testable without the judge-A file existing yet. Behavior is unchanged -- same formulas,
//     same iteration order, same rng draw sequence.
//  3. judge-A.jsonl does not exist yet (Step 3's judging is an LLM step the controller runs later)
//     -- per the Task 7 dispatch, this script must not crash with a raw ENOENT stack trace when
//     that is the case. Every required input file is existence-checked up front and reported as
//     exit 15 (LINK_AUDIT_INPUT_MISSING) naming the exact missing path; an empty judged-cluster set
//     (e.g. judge-A.jsonl exists but shares no jids with the sample) is reported the same way
//     instead of throwing inside the bootstrap loop (clusters[Math.floor(rng()*0)] would be
//     undefined and crash on the first `c[0].stratum` read).
//
// Fix round 1 (task review: "no mechanism anywhere ... to compute agreement/kappa" over the
// brief's stated 20% second-judge sample): reads the optional links/<c>.links.judge-B.jsonl (same
// {jid, mention} shape as judge-A) and reports inter-rater reliability over the tagged
// (second_judge:true) subsample via lib/reliability.mjs's reliabilityOf. judge-B not existing yet,
// or sharing no tagged jids with judge-A, is not an error -- reliability is null with a
// reliability_note explaining why, same "never crash on a missing later-stage file" policy as (3).
//
// Fix round 2 (review finding, 2026-08-22 — judge blinding): `provenance` no longer travels in the
// judge file (it told the judge the lexical half of the answer it was being asked for). It is read
// from links/<c>.links.key.jsonl and joined back on jid here. A sample produced before that split
// still carries the label in-row; that is accepted so old runs remain reproducible, but the result
// records blinding:'broken-legacy' so a by_provenance split from such a run is never mistaken for a
// blinded one. Neither source present is a setup error, not a reason to emit a silent null.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CORPORA, EVAL_DIR } from './lib/paths.mjs';
import { mulberry32 } from './lib/prng.mjs';
import { reliabilityOf } from './lib/reliability.mjs';

const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.meta);

export const precisionOf = (rows) => rows.length ? rows.filter(r => r.ok).length / rows.length : null;

// Attaches provenance to the sampled rows from the key file the (blinded) sampler writes. Returns
// blinding:'blinded' when the key supplied it, 'broken-legacy' when the rows already carried it
// (a sample taken before the split), and null when neither is available -- the caller treats that
// last case as a missing input rather than silently reporting a by_provenance split of nothing.
export function joinProvenance(rows, keyPath) {
  if (existsSync(keyPath)) {
    const K = new Map(readFileSync(keyPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(r => [r.jid, r.provenance]));
    return { items: rows.map(r => ({ ...r, provenance: K.get(r.jid) ?? null })), blinding: 'blinded' };
  }
  if (rows.some(r => 'provenance' in r)) return { items: rows, blinding: 'broken-legacy' };
  return { items: rows, blinding: null };
}

// items: link-audit-sample.mjs output rows. judgeMap: Map(jid -> mention 1|0). Groups judged pairs
// by chunk_id (unjudged jids are dropped) so each chunk becomes one bootstrap resampling unit.
export function clusterByChunk(items, judgeMap) {
  const byChunk = new Map();
  for (const it of items) {
    if (!judgeMap.has(it.jid)) continue;
    if (!byChunk.has(it.chunk_id)) byChunk.set(it.chunk_id, []);
    byChunk.get(it.chunk_id).push({ ...it, ok: judgeMap.get(it.jid) });
  }
  return [...byChunk.values()];
}

export function byStratum(clusters) {
  const rowsIn = (s) => clusters.filter(c => c[0].stratum === s).flat();
  return Object.fromEntries(['low', 'mid', 'high'].map(s => [s, { n: rowsIn(s).length, precision: precisionOf(rowsIn(s)) }]));
}

export function byProvenance(clusters) {
  const flat = clusters.flat();
  return Object.fromEntries(['name', 'nonliteral'].map(p => {
    const rows = flat.filter(r => r.provenance === p);
    return [p, { n: rows.length, precision: precisionOf(rows) }];
  }));
}

// Prevalence-weighted precision: per-stratum precision weighted by that stratum's share of ALL
// eligible chunks in the corpus (prev), not its share of the sample -- the sample is a fixed 20
// chunks per stratum, so an unweighted average would over-count whichever stratum happens to be
// smallest in the corpus. A stratum with no sampled rows (precision === null) contributes 0.
// totalPrev === 0 (degenerate/empty prevalence, e.g. a corpus with zero linked chunks) returns
// null instead of dividing by zero (fix round 1 minor).
export function weightedPrecision(clusters, prev) {
  const totalPrev = Object.values(prev).reduce((a, b) => a + b, 0);
  if (totalPrev === 0) return null;
  return ['low', 'mid', 'high'].reduce((acc, s) => {
    const rows = clusters.filter(c => c[0].stratum === s).flat();
    const p = precisionOf(rows);
    return acc + (p === null ? 0 : p * ((prev[s] ?? 0) / totalPrev));
  }, 0);
}

// Chunk-cluster (not pair-level) percentile bootstrap: resample chunks with replacement, `iters`
// times, recomputing weightedPrecision on each resample. Pairs within one chunk are not
// independent observations (same passage, same judge read in one pass), so resampling individual
// pairs would understate the true CI width.
export function bootstrapCI(clusters, prev, iters, rng) {
  const boots = [];
  for (let b = 0; b < iters; b++) {
    const sample = Array.from({ length: clusters.length }, () => clusters[Math.floor(rng() * clusters.length)]);
    boots.push(weightedPrecision(sample, prev));
  }
  boots.sort((a, b) => a - b);
  return { boots, lo: boots[Math.floor(0.025 * boots.length)], hi: boots[Math.floor(0.975 * boots.length)] };
}

export function run(label) {
  const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
  const dir = join(EVAL_DIR, 'links');
  const paths = {
    items: join(dir, `${label}.links.judge.jsonl`),       // link-audit-sample.mjs output (the sampled pairs)
    judgeA: join(dir, `${label}.links.judge-A.jsonl`),     // judge output (LLM step, run by the controller later)
    prev: join(dir, `${label}.links.prevalence.json`),     // link-audit-sample.mjs output (per-stratum chunk counts)
  };
  // Checked separately below: a pre-blinding sample has no key file but does carry in-row labels.
  paths.key = join(dir, `${label}.links.key.jsonl`);
  for (const [k, p] of Object.entries(paths)) {
    if (k === 'key') continue;
    if (!existsSync(p)) { console.error(`LINK_AUDIT_INPUT_MISSING ${k} ${p}`); process.exit(15); }
  }
  const rawItems = readJsonl(paths.items);
  const { items, blinding } = joinProvenance(rawItems, paths.key);
  if (!blinding) {
    console.error(`LINK_AUDIT_INPUT_MISSING key ${paths.key} (and the sample rows carry no in-row provenance either)`);
    process.exit(15);
  }
  if (blinding === 'broken-legacy') console.error(`BLINDING_BROKEN_LEGACY ${label}: no key file; using the provenance labels embedded in ${paths.items}, which the judge could see`);
  const J = new Map(readJsonl(paths.judgeA).map(r => [r.jid, r.mention]));
  const prev = JSON.parse(readFileSync(paths.prev, 'utf8'));
  const clusters = clusterByChunk(items, J);
  if (!clusters.length) {
    console.error(`LINK_AUDIT_INPUT_MISSING no judged jids overlap between ${paths.items} and ${paths.judgeA}`);
    process.exit(15);
  }

  // Inter-rater reliability over the second-judge (tagged) subsample -- never an error/exit:
  // judge-B not having run yet, or sharing no tagged jids with judge-A, is a normal pipeline state
  // (Step 3's judging is a later, controller-orchestrated stage), not a failure of this merge.
  const judgeBPath = join(dir, `${label}.links.judge-B.jsonl`);
  const taggedJids = items.filter(it => it.second_judge).map(it => it.jid);
  let reliability = null, reliability_note = null;
  if (!existsSync(judgeBPath)) {
    reliability_note = `no judge-B file at ${judgeBPath} (second-judge pass has not run yet)`;
  } else {
    const pairsA = [...J.entries()].map(([jid, mention]) => ({ jid, mention }));
    const pairsB = readJsonl(judgeBPath);
    reliability = reliabilityOf(pairsA, pairsB, taggedJids);
    if (!reliability) reliability_note = `judge-B.jsonl exists but shares no jids with the ${taggedJids.length} tagged (second_judge:true) pairs present in judge-A`;
  }

  const point = weightedPrecision(clusters, prev);
  let ci95 = null;
  if (point !== null) {
    const { lo, hi } = bootstrapCI(clusters, prev, th.bootstrap.iters, mulberry32(th.bootstrap.seed + 8));
    ci95 = [+lo.toFixed(4), +hi.toFixed(4)];
  }
  const res = {
    by_stratum: byStratum(clusters),
    by_provenance: byProvenance(clusters),
    weighted_precision: point === null ? null : +point.toFixed(4),
    ci95,
    chunks: clusters.length,
    pairs: clusters.flat().length,
    reliability,
    reliability_note,
    blinding,
  };
  writeFileSync(join(EVAL_DIR, 'out', `link-precision.${label}.json`), JSON.stringify(res, null, 2) + '\n');
  const relSummary = reliability ? `n=${reliability.n} agreement=${reliability.agreement.toFixed(3)} kappa=${reliability.kappa.toFixed(3)}` : `null (${reliability_note})`;
  console.log(`${label}: link precision (name) ${res.by_provenance.name.precision} · weighted ${res.weighted_precision} CI ${res.ci95} · pairs ${res.pairs} in ${res.chunks} chunks · reliability ${relSummary}`);
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const label = process.argv[2];
  if (!CORPORA[label]) { console.error('usage: link-audit-merge.mjs <hub|uap|hal>'); process.exit(2); }
  run(label);
}
