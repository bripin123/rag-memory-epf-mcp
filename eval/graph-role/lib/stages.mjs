// Stage instrumentation for one query: seam (product 1-hop) -> harness 2-hop -> chunk links -> channels at fixed budgets.
import { rrf, cutK, cutUniqueDoc } from './rrf.mjs';
import { DIST_INDEX } from './paths.mjs';
export function rankGraphChunks(linkRows, entityScore) {           // linkRows: {chunk_id, entity_id}
  const per = new Map();
  for (const r of linkRows) { const s = entityScore.get(r.entity_id); if (s === undefined) continue; const set = per.get(r.chunk_id) || new Map(); set.set(r.entity_id, s); per.set(r.chunk_id, set); }
  return [...per.entries()].map(([chunk_id, m]) => ({ chunk_id, score: [...m.values()].reduce((a, b) => a + b, 0) })).sort((a, b) => b.score - a.score || (a.chunk_id < b.chunk_id ? -1 : 1));
}
export function applyBudgets(chunkIds, Ks, docOf) {
  const out = { chunk: {}, doc: {} };
  for (const K of Ks) { out.chunk[K] = cutK(chunkIds, K); out.doc[K] = cutUniqueDoc(chunkIds, K, docOf); }
  return out;
}
const now = () => Number(process.hrtime.bigint() / 1000000n);
let compileFts = null;
async function ftsCompiler() { if (!compileFts) { const mod = await import(DIST_INDEX); compileFts = mod.compileFtsLiteralQuery; } return compileFts; }
export async function channelsForQuery({ m, db, query, Ks = [10, 30, 100], n2cap = 50 }) {
  const docOfStmt = db.prepare(`SELECT document_id FROM chunk_metadata WHERE chunk_id = ?`); const docCache = new Map();
  const docOf = (id) => { if (!docCache.has(id)) docCache.set(id, docOfStmt.get(id)?.document_id ?? id); return docCache.get(id); };
  const KMAX = Math.max(...Ks); const ms = {};
  // vector channel: product path with graph off at limit=KMAX (limit*3 pool -> top KMAX)
  let t = now(); const off = await m.hybridSearch(query, KMAX, false); ms.vector = now() - t;
  const vector = off.results.map(r => r.chunk_id);
  // fts channel: BM25 only (same expression builder as the product)
  t = now();
  const compile = await ftsCompiler(); const ftsExpr = compile ? compile(query) : null;
  const fts = ftsExpr ? db.prepare(`SELECT cm.chunk_id FROM chunks_fts JOIN chunk_metadata cm ON chunks_fts.rowid = cm.rowid WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`).all(ftsExpr, KMAX).map(r => r.chunk_id) : [];
  ms.fts = now() - t;
  // seam: seeds + 1-hop (product), then harness 2-hop
  t = now(); const seam = await m.explainGraphContext(query); ms.seam = now() - t;
  const seedScore = new Map(seam.seeds.map(s => [s.entity_id, s.similarity]));
  const n1Score = new Map();
  for (const c of seam.connected) { const via = seedScore.get(c.via_seed_id) ?? 0; const s = via * 0.5; if ((n1Score.get(c.entity_id) ?? -1) < s) n1Score.set(c.entity_id, s); }
  const nb = db.prepare(`SELECT CASE WHEN source_entity = ? THEN target_entity ELSE source_entity END AS nid FROM relationships WHERE source_entity = ? OR target_entity = ? ORDER BY id LIMIT ?`);
  const n2Score = new Map();
  for (const [eid, s1] of [...n1Score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    for (const r of nb.all(eid, eid, eid, n2cap)) { if (seedScore.has(r.nid) || n1Score.has(r.nid)) continue; const s = s1 * 0.5; if ((n2Score.get(r.nid) ?? -1) < s) n2Score.set(r.nid, s); }
  }
  const links = (ids) => ids.length ? db.prepare(`SELECT cm.chunk_id, ce.entity_id FROM chunk_entities ce JOIN chunk_metadata cm ON cm.rowid = ce.chunk_rowid WHERE ce.entity_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  t = now(); const gSeed = rankGraphChunks(links([...seedScore.keys()]), seedScore).map(r => r.chunk_id); ms['graph-seed'] = now() - t;
  t = now(); const gN1 = rankGraphChunks(links([...n1Score.keys()]), n1Score).map(r => r.chunk_id); ms['graph-n1'] = now() - t;
  t = now(); const gN2 = rankGraphChunks(links([...n2Score.keys()]), n2Score).map(r => r.chunk_id); ms['graph-n2'] = now() - t;
  const reachSet = new Set([...gSeed, ...gN1, ...gN2]);
  // graph-vec: graph-n1 eligible set ordered by query-chunk vector similarity (upper bound, not semantics)
  t = now(); let gVec = [];
  if (gN1.length && seam.status === 'vector') {
    const emb = await m.generateEmbedding(query, 1024, true);
    const rows = db.prepare(`SELECT cm.chunk_id, c.distance FROM chunks c JOIN chunk_metadata cm ON cm.rowid = c.rowid WHERE c.embedding MATCH ? AND k = ?`).all(Buffer.from(emb.buffer), Math.min(4096, Math.max(KMAX * 10, gN1.length)));
    const inSet = new Set(gN1); gVec = rows.filter(r => inSet.has(r.chunk_id)).sort((a, b) => a.distance - b.distance || (a.chunk_id < b.chunk_id ? -1 : 1)).map(r => r.chunk_id);
  } ms['graph-vec'] = now() - t;
  const rrf2 = rrf([vector, fts]).map(x => x.id), rrf3 = rrf([vector, fts, gN1]).map(x => x.id), rrf3n2 = rrf([vector, fts, gN1, gN2]).map(x => x.id);
  const chans = { vector, fts, 'graph-seed': gSeed, 'graph-n1': gN1, 'graph-n2': gN2, 'graph-vec': gVec, rrf2, rrf3, 'rrf3-n2': rrf3n2 };
  const channels = {}; for (const [name, ids] of Object.entries(chans)) channels[name] = { ...applyBudgets(ids, Ks, docOf), ms: ms[name] ?? null };
  return { seam, seeds: seam.seeds, n_connected: seam.connected.length, n2_count: n2Score.size, channels, reach: { chunks: reachSet.size, docs: [...new Set([...reachSet].map(docOf))] }, docOf };
}
