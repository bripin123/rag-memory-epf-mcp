import { mulberry32, shuffle } from './prng.mjs';

// Natural id order: split into digit / non-digit runs, compare digit runs numerically and other runs
// lexicographically. So "hub-A-2" sorts before "hub-A-10" (numeric run 2 < 10), while class letters
// ("hub-A-1" vs "hub-M-1") keep their usual lexicographic order. A prefix of another id sorts first
// (fewer runs). Real query ids are `<corpus>-<class>-<n>` with unpadded n -- default string sort gets
// these wrong (e.g. "hub-A-10" before "hub-A-2"), which is why this is not just `.sort()`.
export function naturalCompare(a, b) {
  const ax = String(a).match(/\d+|\D+/g) || [];
  const bx = String(b).match(/\d+|\D+/g) || [];
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const x = ax[i], y = bx[i];
    if (x === y) continue;
    const xNum = /^\d+$/.test(x), yNum = /^\d+$/.test(y);
    if (xNum && yNum) { const d = Number(x) - Number(y); if (d !== 0) return d < 0 ? -1 : 1; continue; }
    return x < y ? -1 : 1;
  }
  return ax.length - bx.length;
}

// Fixed-depth-10 pooling + predeclared depth-30 subset (replaces the D2 saturation design: measured on the
// real outputs, the top10 tier alone already exceeds judging_budget_per_corpus on all 3 corpora, and an
// advisor round found outcome-dependent (saturation-based) extension has an unjudged-as-nonrelevant bias of
// unfixed direction -- fixed-depth pooling with a predeclared, stratified, representative depth-30 subset is
// the standard alternative). Pure, deterministic, no I/O.
//
// Pass 1 = every `top10` row (fixed-depth-10 pooling over all channels x conditions + finals + purevec),
// always judged, never budget-gated. Pass 2 = a predeclared subset of WHOLE queries (not individual chunks)
// promoted to depth 30: every qid with >= 1 `top30` row is a candidate, split by class (A/M); each class list
// is put into natural id order (reproducible regardless of judgeRows' incidental file order) and then shuffled
// with `mulberry32(seed)` (one continuous stream: class A first, then class M); candidates are then walked in
// A, M, A, M, ... alternation (once one class list is exhausted, the walk drains the other) and a query is
// selected only if its WHOLE top30-row count fits in the remaining budget -- otherwise it is marked
// `skipped_budget` and the walk keeps trying later (possibly smaller) queries rather than stopping. Because
// the candidate set, the shuffle, and the fit/skip rule are all fixed before any grade exists, pass 2's
// coverage cannot be biased by what the pass-1 grades turned out to be.
export function planPass2({ judgeRows, budget, seed }) {
  const pass1_rows = judgeRows.filter(r => r.tier === 'top10').length;
  let remaining = budget - pass1_rows;

  const byQid = new Map();   // qid -> { class, jids: [top30 jids] }
  for (const r of judgeRows) {
    if (r.tier !== 'top30') continue;
    let e = byQid.get(r.qid); if (!e) { e = { class: r.class, jids: [] }; byQid.set(r.qid, e); }
    e.jids.push(r.jid);
  }

  const classQids = { A: [], M: [] };
  for (const [qid, e] of byQid) classQids[e.class].push(qid);
  classQids.A.sort(naturalCompare); classQids.M.sort(naturalCompare);

  const rng = mulberry32(seed);
  const shuffledA = shuffle(classQids.A, rng), shuffledM = shuffle(classQids.M, rng);   // one continuous stream: A then M

  const order = [];   // alternate A, M, A, M, ...; once one list is exhausted, drain the other
  for (let i = 0; i < shuffledA.length || i < shuffledM.length; i++) {
    if (i < shuffledA.length) order.push(shuffledA[i]);
    if (i < shuffledM.length) order.push(shuffledM[i]);
  }

  const selected = []; const skipped_budget = [];
  for (const qid of order) {
    const n = byQid.get(qid).jids.length;
    if (n <= remaining) { selected.push(qid); remaining -= n; } else { skipped_budget.push(qid); }
  }

  const selectedSet = new Set(selected);
  const pass2_jids = judgeRows.filter(r => r.tier === 'top30' && selectedSet.has(r.qid)).map(r => r.jid);

  return {
    selected,
    not_selected: [...skipped_budget],
    skipped_budget,
    per_class: {
      A: { selected: selected.filter(qid => byQid.get(qid).class === 'A'), candidates: classQids.A },
      M: { selected: selected.filter(qid => byQid.get(qid).class === 'M'), candidates: classQids.M },
    },
    pass1_rows,
    pass2_rows: pass2_jids.length,
    pass2_jids,
    budget,
    remaining_after: remaining,
  };
}
