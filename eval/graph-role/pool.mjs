import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CORPORA, EVAL_DIR } from './lib/paths.mjs';
import { mulberry32, shuffle, pick } from './lib/prng.mjs';
const label = process.argv[2]; const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const need = ['real', 'shuffled-r0', 'random'];
const files = need.flatMap(c => [`candidates.${label}.${c}.jsonl`, `final.${label}.${c}.jsonl`]).map(f => join(EVAL_DIR, 'out', f));
const missing = files.filter(f => !existsSync(f)); if (missing.length) { console.error(`POOL_INCOMPLETE missing ${missing.map(f => f.split('/').pop()).join(', ')}`); process.exit(7); }
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const queries = new Map(readJsonl(join(EVAL_DIR, 'suite', `queries.${label}.jsonl`)).map(q => [q.id, q]));
// qid -> Map(chunk_id -> { tier, channels: Set<name>, conds: Set<cond> }). Fixed-depth pooling, 3 tiers by
// precedence top10 > top30 > deep: 'top10' = rank <= 10 in ANY channel/condition list or ANY final list (all
// 10-long); 'top30' = appears only at ranks 11-30 (chunk30 minus chunk10) in some channel/condition; 'deep' =
// only at ranks 31-100. channels/conds accumulate from every rank<=30 occurrence (top10 or top30), for
// diagnostics -- deep-only chunks keep empty channels/conds.
const TIER_RANK = { deep: 1, top30: 2, top10: 3 };
const pooled = new Map();
const add = (qid, ids, tier, channel, cond) => {
  const s = pooled.get(qid) || new Map();
  for (const id of ids) {
    if (!id) continue;
    let cur = s.get(id); if (!cur) { cur = { tier: 'deep', channels: new Set(), conds: new Set() }; s.set(id, cur); }
    if (TIER_RANK[tier] > TIER_RANK[cur.tier]) cur.tier = tier;
    if (tier === 'top10' || tier === 'top30') { cur.channels.add(channel); cur.conds.add(cond); }
  }
  pooled.set(qid, s);
};
for (const c of need) {
  for (const r of readJsonl(join(EVAL_DIR, 'out', `candidates.${label}.${c}.jsonl`))) { if (r.class === 'K') continue;
    for (const [chName, ch] of Object.entries(r.channels)) { add(r.id, ch.chunk10, 'top10', chName, r.cond); add(r.id, ch.chunk30.slice(10), 'top30', chName, r.cond); add(r.id, ch.chunk100.slice(30), 'deep'); } }
  for (const r of readJsonl(join(EVAL_DIR, 'out', `final.${label}.${c}.jsonl`))) { if (r.class === 'K') continue;
    add(r.id, r.off.top10.map(x => x.chunk_id), 'top10', 'final-off', r.cond); add(r.id, r.on.top10.map(x => x.chunk_id), 'top10', 'final-on', r.cond); add(r.id, r.fixedpool_rerank.with_graph, 'top10', 'final-fixedpool', r.cond); }
}
// purevec channel (T5b, real-only, post-hoc; not part of `need`/the exit-7 completeness gate — pool it when present, skip silently when not). Its channel names are prefixed `purevec:` so they never collide with the candidates-file channel names of the same corpus/condition.
const purevecPath = join(EVAL_DIR, 'out', `purevec.${label}.jsonl`);
if (existsSync(purevecPath)) { for (const r of readJsonl(purevecPath)) { if (r.class === 'K') continue;
  for (const [chName, ch] of Object.entries(r.channels)) { add(r.id, ch.chunk10, 'top10', `purevec:${chName}`, r.cond); add(r.id, ch.chunk30.slice(10), 'top30', `purevec:${chName}`, r.cond); add(r.id, ch.chunk100.slice(30), 'deep'); } } }
const db = new Database(CORPORA[label].copy, { readonly: true });
const meta = db.prepare(`SELECT cm.chunk_id, cm.document_id, cm.chunk_index, cm.text FROM chunk_metadata cm WHERE cm.chunk_id = ?`);
const neighbor = db.prepare(`SELECT text FROM chunk_metadata WHERE document_id = ? AND chunk_index = ?`);
const title = db.prepare(`SELECT substr(content, 1, 120) AS t FROM documents WHERE id = ?`);
mkdirSync(join(EVAL_DIR, 'pool'), { recursive: true });
const rows = []; let jn = 0; const stats = { queries: 0, chunks: 0, docs: 0 };
for (const [qid, set] of pooled) {
  const q = queries.get(qid); stats.queries++;
  const docsSeen = new Set();
  for (const [chunk_id, prov] of [...set.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const m = meta.get(chunk_id); if (!m) continue; stats.chunks++; docsSeen.add(m.document_id);
    rows.push({ jid: `${label}-J${++jn}`, tier: prov.tier, qid, class: q.class, query: q.text, doc_id: m.document_id, doc_title: (title.get(m.document_id)?.t || m.document_id).replace(/\s+/g, ' ').slice(0, 100), chunk_id, chunk_text: m.text,
                prev_text: neighbor.get(m.document_id, m.chunk_index - 1)?.text ?? '', next_text: neighbor.get(m.document_id, m.chunk_index + 1)?.text ?? '' });
  }
  stats.docs += docsSeen.size;
}
const corpusIndex = { hub: 0, uap: 1, hal: 2 }[label];
const shuffled = shuffle(rows, mulberry32(th.bootstrap.seed + corpusIndex));
// pool.jsonl carries provenance (tier/channels/conds) for the pass-2 selection and for diagnostics; judge.jsonl
// stays exactly the blind row shape below (jid, tier, qid, class, query, doc_id, doc_title, chunk_id, chunk_text,
// prev_text, next_text) — tier (now 3-valued: top10/top30/deep) is present there too but channels/conds are NOT,
// so a judge never sees which channel/condition surfaced an item.
writeFileSync(join(EVAL_DIR, 'pool', `${label}.pool.jsonl`), rows.map(r => { const prov = pooled.get(r.qid).get(r.chunk_id); return JSON.stringify({ qid: r.qid, chunk_id: r.chunk_id, doc_id: r.doc_id, jid: r.jid, tier: r.tier, channels: [...prov.channels].sort(), conds: [...prov.conds].sort() }); }).join('\n') + '\n');
writeFileSync(join(EVAL_DIR, 'pool', `${label}.judge.jsonl`), shuffled.map(r => JSON.stringify({ jid: r.jid, tier: r.tier, qid: r.qid, class: r.class, query: r.query, doc_id: r.doc_id, doc_title: r.doc_title, chunk_id: r.chunk_id, chunk_text: r.chunk_text, prev_text: r.prev_text, next_text: r.next_text })).join('\n') + '\n');
// deepsample: 100 (qid, chunk) pairs sampled uniformly at random WITHOUT replacement from the deep (ranks
// 31-100) tier, for a missed-relevant-rate diagnostic. Reuses the already-built `rows` entries (already carry
// the full blind shape via the neighbor lookups above) — just relabels jid.
const deepRowsAll = rows.filter(r => r.tier === 'deep');
const sampledDeep = pick(deepRowsAll, 100, mulberry32(th.bootstrap.seed + 300 + corpusIndex));
const deepsample = sampledDeep.map((r, i) => ({ jid: `${label}-D${i + 1}`, tier: r.tier, qid: r.qid, class: r.class, query: r.query, doc_id: r.doc_id, doc_title: r.doc_title, chunk_id: r.chunk_id, chunk_text: r.chunk_text, prev_text: r.prev_text, next_text: r.next_text }));
writeFileSync(join(EVAL_DIR, 'pool', `${label}.deepsample.jsonl`), deepsample.map(r => JSON.stringify(r)).join('\n') + '\n');
// unpooled random sample (missed-relevant rate): 100 (query, chunk) pairs not in the pool at all
const allChunks = db.prepare(`SELECT chunk_id, document_id FROM chunk_metadata WHERE chunk_type='document'`).all();
const rng = mulberry32(th.bootstrap.seed + 100 + corpusIndex); const unp = [];
const qids = [...pooled.keys()];
while (unp.length < 100) { const qid = qids[Math.floor(rng() * qids.length)]; const c = allChunks[Math.floor(rng() * allChunks.length)]; if (pooled.get(qid).has(c.chunk_id)) continue; const m = meta.get(c.chunk_id); const q = queries.get(qid);
  unp.push({ jid: `${label}-U${unp.length + 1}`, qid, class: q.class, query: q.text, doc_id: m.document_id, doc_title: (title.get(m.document_id)?.t || m.document_id).slice(0, 100), chunk_id: c.chunk_id, chunk_text: m.text, prev_text: '', next_text: '' }); }
writeFileSync(join(EVAL_DIR, 'pool', `${label}.unpooled.jsonl`), unp.map(r => JSON.stringify(r)).join('\n') + '\n');
const nTop10 = rows.filter(r => r.tier === 'top10').length, nTop30 = rows.filter(r => r.tier === 'top30').length, nDeep = rows.length - nTop10 - nTop30;
console.log(`${label}: pooled queries ${stats.queries} chunks ${stats.chunks} (top10 ${nTop10} · top30 ${nTop30} · deep ${nDeep}; query-doc pairs ${stats.docs}) budget ${th.judging_budget_per_corpus}${nTop10 > th.judging_budget_per_corpus ? ' OVER_BUDGET' : ''}; unpooled 100; deepsample ${deepsample.length}`);
db.close();
