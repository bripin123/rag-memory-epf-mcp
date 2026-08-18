// Task 7 fix round 1 — inter-rater reliability for the link-precision audit's second-judge
// subsample. link-audit-sample.mjs tags a seeded ~20% (stratified, floor 1/stratum) subsample of
// sampled pairs with second_judge: true; the controller sends those pairs to a second judge
// (codex); link-audit-merge.mjs calls reliabilityOf to report agreement between judge-A and
// judge-B over that tagged subsample. Pure: no file/DB access.
import { weightedKappa } from './metrics.mjs';

// pairsA/pairsB: arrays of {jid, mention} rows (e.g. parsed judge-A.jsonl / judge-B.jsonl; any
// meta row is expected to already be filtered out by the caller). tagged: an iterable of jids that
// were sent to the second judge (link-audit-sample.mjs's second_judge:true rows).
//
// Returns { n, agreement, kappa } computed over the jids that are in `tagged` AND present in both
// pairsA and pairsB (a plain set intersection -- a tagged jid missing from either judge file is
// silently excluded, not an error). Returns null if that intersection is empty (judge-B hasn't run
// yet, an empty pairsB, or the tagged set is empty) -- this function never throws.
//
// kappa is Cohen's kappa for the binary 0/1 labels: weightedKappa's quadratic weighting collapses
// to standard (unweighted) kappa at L=2, since the only possible distance between two categories
// is 0 or 1 -- w(0,1)=w(1,0)=(1)^2/(2-1)^2=1, w(0,0)=w(1,1)=0, which is exactly the unweighted
// disagreement indicator.
export function reliabilityOf(pairsA, pairsB, tagged) {
  const A = new Map(pairsA.map(r => [r.jid, r.mention]));
  const B = new Map(pairsB.map(r => [r.jid, r.mention]));
  const jids = [...new Set(tagged)].filter(jid => A.has(jid) && B.has(jid));
  if (!jids.length) return null;
  const a = jids.map(jid => A.get(jid));
  const b = jids.map(jid => B.get(jid));
  const agreement = a.filter((v, i) => v === b[i]).length / jids.length;
  const kappa = weightedKappa(a, b, 2);
  return { n: jids.length, agreement, kappa };
}
