// Reciprocal rank fusion over ranked id lists. Deterministic: ties broken by id asc.
export function rrf(lists, k = 60) {
  const score = new Map();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (k + i + 1)));
  return [...score.entries()].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}
export const cutK = (list, K) => list.slice(0, K);
export function cutUniqueDoc(list, K, docOf) {   // first K distinct documents, keeps chunk order
  const seen = new Set(); const out = [];
  for (const x of list) { const d = docOf(x.id ?? x); if (seen.has(d)) continue; seen.add(d); out.push(x); if (out.length >= K) break; }
  return out;
}
