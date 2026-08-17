import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCorpus, exitOnRefuse } from './lib/db.mjs';
import { CORPORA, EVAL_DIR } from './lib/paths.mjs';
const label = process.argv[2]; const perSplit = parseInt(process.argv[3] || '30', 10);
if (!CORPORA[label]) { console.error('usage: node make-known-item.mjs <hub|uap|hal> [perSplit]'); process.exit(2); }
await exitOnRefuse(async () => {
  const { db, close } = await openCorpus({ dbPath: CORPORA[label].copy, label });
  const rows = db.prepare(`SELECT rowid, chunk_id, document_id, text FROM chunk_metadata WHERE chunk_type='document' AND LENGTH(text) >= 200 ORDER BY rowid`).all();
  const firstRowidOfDoc = new Map(); for (const r of rows) if (!firstRowidOfDoc.has(r.document_id)) firstRowidOfDoc.set(r.document_id, r.rowid);
  const total = rows.length, step = Math.max(1, Math.floor(total / (perSplit * 4)));
  const out = []; const usedDocs = new Set();
  for (let i = 0; i < rows.length && out.length < perSplit * 2; i += step) {
    const r = rows[i]; if (usedDocs.has(r.document_id)) continue;
    const start = Math.min(60, Math.max(0, r.text.length - 220)); const q = r.text.slice(start, start + 180).replace(/\s+/g, ' ').trim();
    if (q.length < 40) continue;
    const split = (firstRowidOfDoc.get(r.document_id) % 2 === 0) ? 'dev' : 'holdout';
    if (out.filter(x => x.split === split).length >= perSplit) continue;
    usedDocs.add(r.document_id);
    out.push({ id: `${label}-K-${out.length + 1}`, class: 'K', split, family: r.document_id, text: q, oracle_chunk_id: r.chunk_id, document_id: r.document_id, notes: `rowid ${r.rowid} step ${step}` });
  }
  if (out.filter(x => x.split === 'dev').length < perSplit || out.filter(x => x.split === 'holdout').length < perSplit) {
    for (let i = 0; i < rows.length; i++) {
      if (out.filter(x => x.split === 'dev').length >= perSplit && out.filter(x => x.split === 'holdout').length >= perSplit) break;
      const r = rows[i]; if (usedDocs.has(r.document_id)) continue;
      const start = Math.min(60, Math.max(0, r.text.length - 220)); const q = r.text.slice(start, start + 180).replace(/\s+/g, ' ').trim();
      if (q.length < 40) continue;
      const split = (firstRowidOfDoc.get(r.document_id) % 2 === 0) ? 'dev' : 'holdout';
      if (out.filter(x => x.split === split).length >= perSplit) continue;
      usedDocs.add(r.document_id);
      out.push({ id: `${label}-K-${out.length + 1}`, class: 'K', split, family: r.document_id, text: q, oracle_chunk_id: r.chunk_id, document_id: r.document_id, notes: `rowid ${r.rowid} step ${step} fill pass` });
    }
  }
  const p = join(EVAL_DIR, 'suite', `queries.${label}.jsonl`);
  writeFileSync(p, out.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log(`${label}: K rows ${out.length} (dev ${out.filter(x => x.split === 'dev').length} / holdout ${out.filter(x => x.split === 'holdout').length}) -> ${p}`);
  close();
});
