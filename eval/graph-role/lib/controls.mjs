// Edge rewiring controls for the graph-role evaluation (R5). Directed double-edge swap:
// pick two edges (u->v, x->y), rewire to (u->y, x->v) if it creates no self-loop and no duplicate.
// Each node keeps its exact (in,out) degree; relation type/confidence travel with the edge row.
import { mulberry32 } from './prng.mjs';
export function degreeSignature(edges) {
  const m = new Map();
  for (const e of edges) { const s = m.get(e.source) || [0, 0]; s[1]++; m.set(e.source, s); const t = m.get(e.target) || [0, 0]; t[0]++; m.set(e.target, t); }
  return m;
}
export function sameSignature(a, b) {
  if (!b || a.size !== b.size) return false;
  for (const [k, v] of a) { const w = b.get(k); if (!w || w[0] !== v[0] || w[1] !== v[1]) return false; }
  return true;
}
export function degreePreservingSwap(edges, { seed = 0, passes = 20, typePreserving = false } = {}) {
  const rng = mulberry32(seed);
  const es = edges.map(e => ({ ...e }));
  const key = (s, t) => `${s} ${t}`;
  const present = new Set(es.map(e => key(e.source, e.target)));
  const groups = typePreserving ? [...new Set(es.map(e => e.type))].map(t => es.map((e, i) => e.type === t ? i : -1).filter(i => i >= 0)) : [es.map((_, i) => i)];
  let swaps = 0;
  for (const idx of groups) {
    if (idx.length < 2) continue;
    const target = idx.length * passes; let tries = 0; let done = 0;
    while (done < target && tries < target * 20) {
      tries++;
      const i = idx[Math.floor(rng() * idx.length)], j = idx[Math.floor(rng() * idx.length)]; if (i === j) continue;
      const a = es[i], b = es[j];
      const ns = a.source, nt = b.target, ms = b.source, mt = a.target;    // a: ns->nt, b: ms->mt
      if (ns === nt || ms === mt) continue;
      if (present.has(key(ns, nt)) || present.has(key(ms, mt))) continue;
      present.delete(key(a.source, a.target)); present.delete(key(b.source, b.target));
      a.target = nt; b.target = mt;
      present.add(key(a.source, a.target)); present.add(key(b.source, b.target));
      done++; swaps++;
    }
  }
  return { edges: es, swaps };
}
export function erdosRenyi(edges, nodeIds, seed = 0) {
  const rng = mulberry32(seed); const present = new Set(); const out = [];
  while (out.length < edges.length) {
    const s = nodeIds[Math.floor(rng() * nodeIds.length)], t = nodeIds[Math.floor(rng() * nodeIds.length)];
    if (s === t || present.has(`${s} ${t}`)) continue;
    present.add(`${s} ${t}`); const src = edges[out.length];
    out.push({ ...src, source: s, target: t });
  }
  return out;
}
