// Quadratic weighted Cohen's kappa for ordinal grades 0..L-1.
export function weightedKappa(a, b, L = 3) {
  const n = a.length; if (n !== b.length || n === 0) throw new Error('length');
  const O = Array.from({ length: L }, () => Array(L).fill(0)); const ra = Array(L).fill(0), rb = Array(L).fill(0);
  for (let i = 0; i < n; i++) { O[a[i]][b[i]]++; ra[a[i]]++; rb[b[i]]++; }
  let num = 0, den = 0;
  for (let i = 0; i < L; i++) for (let j = 0; j < L; j++) { const w = ((i - j) ** 2) / ((L - 1) ** 2); num += w * O[i][j]; den += w * (ra[i] * rb[j]) / n; }
  return den === 0 ? 1 : 1 - num / den;
}
