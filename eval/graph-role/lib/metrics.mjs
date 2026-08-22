// Quadratic weighted Cohen's kappa for ordinal grades 0..L-1.
export function weightedKappa(a, b, L = 3) {
  const n = a.length; if (n !== b.length || n === 0) throw new Error('length');
  const O = Array.from({ length: L }, () => Array(L).fill(0)); const ra = Array(L).fill(0), rb = Array(L).fill(0);
  for (let i = 0; i < n; i++) { O[a[i]][b[i]]++; ra[a[i]]++; rb[b[i]]++; }
  let num = 0, den = 0;
  for (let i = 0; i < L; i++) for (let j = 0; j < L; j++) { const w = ((i - j) ** 2) / ((L - 1) ** 2); num += w * O[i][j]; den += w * (ra[i] * rb[j]) / n; }
  return den === 0 ? 1 : 1 - num / den;
}

// ---------------------------------------------------------------------------
// Task 8 — retrieval metrics, paired statistics, and the two gold sources that
// report.mjs and power.mjs share. Appended below T6's weightedKappa; nothing
// above this line is redefined.
// ---------------------------------------------------------------------------
import { mulberry32 } from './prng.mjs';

// Engine chunk id form is `${document_id}_chunk_${index}`. Document ids in these
// corpora may themselves contain "_chunk_", so only the LAST separator splits.
export const docOfChunk = (id) => { const i = String(id).lastIndexOf('_chunk_'); return i < 0 ? String(id) : String(id).slice(0, i); };

export const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
export const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
export const pctile = (arr, p) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// rank is 1-based; 0 or -1 means "not retrieved" (findIndex(-1)+1 = 0).
export const hitAtK = (rank, k) => (rank > 0 && rank <= k) ? 1 : 0;

// Document-level recall over the first K entries of a chunk ranking. Returns
// null (not 0) when the query has no gold — 0 would read as "missed everything".
export function recallAtKDoc(ranked, goldDocs, docOf, K) {
  if (!goldDocs || !goldDocs.size) return null;
  const seen = new Set(); for (const id of ranked.slice(0, K)) seen.add(docOf(id));
  let hit = 0; for (const g of goldDocs) if (seen.has(g)) hit++;
  return hit / goldDocs.size;
}

// Reciprocal rank of the first gold DOCUMENT, ranking distinct documents.
export function mrrDoc(ranked, goldDocs, docOf) {
  if (!goldDocs || !goldDocs.size) return null;
  const seen = new Set(); let pos = 0;
  for (const id of ranked) { const d = docOf(id); if (seen.has(d)) continue; seen.add(d); pos++; if (goldDocs.has(d)) return 1 / pos; }
  return 0;
}

// Graded nDCG@10 over distinct documents. allGoldDocs = the full gold set makes
// the ideal include gold the run never retrieved (report.mjs passes it); null
// falls back to the retrieved-only ideal (the Step 1 fixture).
export function ndcg10Graded(ranked, gradeOfDoc, docOf, allGoldDocs = null) {
  const seen = new Set(); const gains = [];
  for (const id of ranked) { const d = docOf(id); if (seen.has(d)) continue; seen.add(d); gains.push(gradeOfDoc(d)); if (gains.length === 10) break; }
  const dcg = gains.reduce((a, g, i) => a + (Math.pow(2, g) - 1) / Math.log2(i + 2), 0);
  const goldGrades = allGoldDocs ? [...allGoldDocs].map(gradeOfDoc) : gains.slice();
  const ideal = goldGrades.sort((a, b) => b - a).slice(0, 10).reduce((a, g, i) => a + (Math.pow(2, g) - 1) / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

// Two-sided exact binomial sign test on discordant pairs only.
export function signTestExact(worse, better) {
  const n = worse + better; if (n === 0) return 1;
  const k = Math.min(worse, better); let p = 0;
  const C = (n, r) => { let x = 1; for (let i = 1; i <= r; i++) x = x * (n - r + i) / i; return x; };
  for (let i = 0; i <= k; i++) p += C(n, i) / Math.pow(2, n);
  return Math.min(1, 2 * p);
}

// Percentile bootstrap of the paired mean Δ, resampling CLUSTERS (K = document,
// A/M = family) with replacement so a query's paired results move together.
export function bootstrapPairedCI(deltas, clusterIds, { iters = 10000, seed = 20260817, alpha = 0.05 } = {}) {
  if (!deltas.length) return null;
  const groups = new Map();
  deltas.forEach((d, i) => { const k = clusterIds ? clusterIds[i] : i; (groups.get(k) || groups.set(k, []).get(k)).push(d); });
  const cl = [...groups.values()]; const rng = mulberry32(seed); const means = [];
  for (let b = 0; b < iters; b++) {
    let s = 0, n = 0;
    for (let j = 0; j < cl.length; j++) { const g = cl[Math.floor(rng() * cl.length)]; for (const d of g) { s += d; n++; } }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(alpha / 2 * iters)], means[Math.floor((1 - alpha / 2) * iters) - 1]];
}

// One-sided 95% lower bound = the two-sided 90% lower bound (5th percentile).
export function oneSidedLowerCI(deltas, clusterIds, opts = {}) { const ci = bootstrapPairedCI(deltas, clusterIds, { ...opts, alpha: 0.10 }); return ci ? ci[0] : null; }

// Holm-Bonferroni step-down. Family size = pvals.length, so a caller that wants
// a pre-declared family keeps its size and pads non-estimable entries with 1.
export function holm(pvals) {
  const idx = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const m = pvals.length; const adj = Array(m); let prev = 0;
  idx.forEach(([p, i], r) => { const v = Math.min(1, Math.max(prev, p * (m - r))); adj[i] = v; prev = v; });
  return adj;
}

// Inverse standard normal CDF (Acklam), |rel err| < 1.15e-9 — enough for a z that
// is squared into an integer sample size.
export function invNorm(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00],
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01],
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00],
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425; let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= 1 - pl) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// Paired-t (normal) sample size for detecting `mcid` at two-sided `alpha`.
// Pass alpha = 2*a for a one-sided test at level a.
export function powerN(sd, mcid, { alpha = 0.05, power = 0.8 } = {}) {
  if (!mcid) return null;
  const za = invNorm(1 - alpha / 2), zb = invNorm(power);
  return Math.ceil(Math.pow((za + zb) * sd / mcid, 2));
}

// --- gold sources -----------------------------------------------------------
// (a) authored: the suite's own gold. Available for every corpus with no judging.
// (b) judged:   qrels. Document grade = max over that document's judged chunks.

export function authoredGoldDocs(q) {
  if (q.class === 'K') return new Set(q.document_id ? [q.document_id] : []);
  const s = new Set(q.source_docs || []);
  if (q.class === 'M' && q.family) s.add(q.family);   // M's bridge target document
  return s;
}

export function buildAuthoredGold(queryRows) {
  const gold = new Map(), grade = new Map(), oracleChunk = new Map(), depth = new Map();
  for (const q of queryRows) {
    const g = authoredGoldDocs(q);
    gold.set(q.id, g);
    grade.set(q.id, new Map([...g].map(d => [d, 1])));   // binary: authored gold has no 0/1/2 scale
    if (q.oracle_chunk_id) oracleChunk.set(q.id, q.oracle_chunk_id);
    depth.set(q.id, null);
  }
  return { source: 'authored', label: 'authored (suite gold: K document_id · A/M source_docs, M + family)', gold, grade, oracleChunk, depth, deep30: null, qrels_grade: null, pool_truncated: null };
}

export function buildJudgedGold(qrelsRows) {
  if (!qrelsRows || !qrelsRows.length) return null;
  const gold = new Map(), grade = new Map(), depth = new Map(), deep30 = new Set();
  let qrels_grade = null, pool_truncated = false;
  for (const r of qrelsRows) {
    const g = grade.get(r.qid) || grade.set(r.qid, new Map()).get(r.qid);
    g.set(r.doc_id, Math.max(g.get(r.doc_id) ?? 0, r.grade));
    if (!gold.has(r.qid)) gold.set(r.qid, new Set());
    if (r.grade >= 1) gold.get(r.qid).add(r.doc_id);
    const d = r.judged_depth ?? null;
    if (d !== null) { depth.set(r.qid, Math.max(depth.get(r.qid) ?? 0, d)); if (d >= 30) deep30.add(r.qid); }
    if (r.qrels_grade) qrels_grade = r.qrels_grade;
    if (r.pool_truncated) pool_truncated = true;
  }
  return { source: 'judged', label: `judged qrels (${qrels_grade ?? 'grade unlabelled'})`, gold, grade, oracleChunk: new Map(), depth, deep30, qrels_grade, pool_truncated };
}

// --- paired endpoint constructors -------------------------------------------
// report.mjs and power.mjs both call these, so the SD power.mjs turns into a
// holdout N is the SD of exactly the deltas report.mjs printed. Each returns
// { deltas, clusters, n, usable }: n = rows the endpoint was eligible for,
// usable = rows the delta could actually be computed on.

export function kSafetyDeltas(finRows, queryById, k = 5) {
  const K = finRows.filter(f => f.class === 'K');
  const deltas = [], clusters = [];
  for (const f of K) {
    const q = queryById.get(f.id); const oracle = q?.oracle_chunk_id; if (!oracle) continue;
    const rOff = f.off.top10.findIndex(x => x.chunk_id === oracle) + 1;
    const rOn = f.on.top10.findIndex(x => x.chunk_id === oracle) + 1;
    deltas.push(hitAtK(rOn, k) - hitAtK(rOff, k)); clusters.push(q.family);   // K family = its document
  }
  return { deltas, clusters, n: K.length, usable: deltas.length };
}

// On JUDGED gold, recall@K needs the query to have been judged at least K deep.
// Pass 1 judged depth 10, so recall@30 is estimable only where judged_depth >= 30.
export function candidateDeltas(candRows, queryById, src, K = 30, a = 'rrf3', b = 'rrf2') {
  const AM = candRows.filter(c => c.class !== 'K');
  const deltas = [], clusters = [];
  for (const c of AM) {
    const g = src.gold.get(c.id); if (!g || !g.size) continue;
    if (src.source === 'judged' && K > 10 && !(src.deep30 && src.deep30.has(c.id))) continue;
    deltas.push(recallAtKDoc(c.channels[a][`chunk${K}`], g, docOfChunk, K) - recallAtKDoc(c.channels[b][`chunk${K}`], g, docOfChunk, K));
    clusters.push(queryById.get(c.id).family);
  }
  return { deltas, clusters, n: AM.length, usable: deltas.length };
}

// nDCG@10 needs no depth-30 subset: the fixed pool is 30 wide but only its top 10
// documents carry gain, and every judged query was judged to depth 10.
export function rerankDeltas(finRows, queryById, src) {
  const AM = finRows.filter(f => f.class !== 'K');
  const deltas = [], clusters = [];
  for (const f of AM) {
    const g = src.gold.get(f.id); if (!g || !g.size) continue;
    const gr = src.grade.get(f.id) || new Map(); const gof = (d) => gr.get(d) ?? 0;
    deltas.push(ndcg10Graded(f.fixedpool_rerank.with_graph, gof, docOfChunk, g) - ndcg10Graded(f.fixedpool_rerank.base, gof, docOfChunk, g));
    clusters.push(queryById.get(f.id).family);
  }
  return { deltas, clusters, n: AM.length, usable: deltas.length };
}
