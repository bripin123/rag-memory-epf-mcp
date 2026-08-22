import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCorpus, exitOnRefuse } from './lib/db.mjs';
import { CORPORA, EVAL_DIR } from './lib/paths.mjs';
const argv = process.argv.slice(2);
const devDocsIdx = argv.indexOf('--dev-docs');
const devDocsPath = devDocsIdx >= 0 ? argv[devDocsIdx + 1] : null;
const positional = devDocsIdx >= 0 ? [...argv.slice(0, devDocsIdx), ...argv.slice(devDocsIdx + 2)] : argv;
const label = positional[0]; const perSplit = parseInt(positional[1] || '30', 10);
if (!CORPORA[label]) { console.error('usage: node make-known-item.mjs <hub|uap|hal> [perSplit] [--dev-docs <path>]'); process.exit(2); }
await exitOnRefuse(async () => {
  const { db, close } = await openCorpus({ dbPath: CORPORA[label].copy, label });
  const rows = db.prepare(`SELECT rowid, chunk_id, document_id, text FROM chunk_metadata WHERE chunk_type='document' AND LENGTH(text) >= 200 ORDER BY rowid`).all();
  const firstRowidOfDoc = new Map(); for (const r of rows) if (!firstRowidOfDoc.has(r.document_id)) firstRowidOfDoc.set(r.document_id, r.rowid);
  const total = rows.length, step = Math.max(1, Math.floor(total / (perSplit * 4)));
  const out = []; const usedDocs = new Set();
  const pinned = new Set();
  if (devDocsPath) {
    for (const line of readFileSync(devDocsPath, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)) pinned.add(line);
    for (const docId of pinned) {
      const docRows = rows.filter(x => x.document_id === docId); // already rowid-ordered (subset of `rows`)
      let chosen = null;
      for (const r of docRows) {
        const start = Math.min(60, Math.max(0, r.text.length - 220)); const q = r.text.slice(start, start + 180).replace(/\s+/g, ' ').trim();
        if (q.length >= 40) { chosen = { r, q }; break; }
      }
      if (!chosen) continue;
      usedDocs.add(docId);
      out.push({ id: `${label}-K-${out.length + 1}`, class: 'K', split: 'dev', family: docId, text: chosen.q, oracle_chunk_id: chosen.r.chunk_id, document_id: docId, notes: `rowid ${chosen.r.rowid} pinned-dev(M target)` });
    }
  }
  const pinnedCount = out.length;
  for (let i = 0; i < rows.length && out.length < pinnedCount + perSplit * 2; i += step) {
    const r = rows[i]; if (usedDocs.has(r.document_id)) continue;
    const start = Math.min(60, Math.max(0, r.text.length - 220)); const q = r.text.slice(start, start + 180).replace(/\s+/g, ' ').trim();
    if (q.length < 40) continue;
    const split = (firstRowidOfDoc.get(r.document_id) % 2 === 0) ? 'dev' : 'holdout';
    if (out.filter(x => x.split === split && !pinned.has(x.family)).length >= perSplit) continue;
    usedDocs.add(r.document_id);
    out.push({ id: `${label}-K-${out.length + 1}`, class: 'K', split, family: r.document_id, text: q, oracle_chunk_id: r.chunk_id, document_id: r.document_id, notes: `rowid ${r.rowid} step ${step}` });
  }
  if (out.filter(x => x.split === 'dev' && !pinned.has(x.family)).length < perSplit || out.filter(x => x.split === 'holdout' && !pinned.has(x.family)).length < perSplit) {
    for (let i = 0; i < rows.length; i++) {
      if (out.filter(x => x.split === 'dev' && !pinned.has(x.family)).length >= perSplit && out.filter(x => x.split === 'holdout' && !pinned.has(x.family)).length >= perSplit) break;
      const r = rows[i]; if (usedDocs.has(r.document_id)) continue;
      const start = Math.min(60, Math.max(0, r.text.length - 220)); const q = r.text.slice(start, start + 180).replace(/\s+/g, ' ').trim();
      if (q.length < 40) continue;
      const split = (firstRowidOfDoc.get(r.document_id) % 2 === 0) ? 'dev' : 'holdout';
      if (out.filter(x => x.split === split && !pinned.has(x.family)).length >= perSplit) continue;
      usedDocs.add(r.document_id);
      out.push({ id: `${label}-K-${out.length + 1}`, class: 'K', split, family: r.document_id, text: q, oracle_chunk_id: r.chunk_id, document_id: r.document_id, notes: `rowid ${r.rowid} step ${step} fill pass` });
    }
  }
  const p = join(EVAL_DIR, 'suite', `queries.${label}.jsonl`);
  writeFileSync(p, out.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log(`${label}: K rows ${out.length} (pinned ${pinnedCount} / dev ${out.filter(x => x.split === 'dev').length} / holdout ${out.filter(x => x.split === 'holdout').length}) -> ${p}`);
  close();
});
