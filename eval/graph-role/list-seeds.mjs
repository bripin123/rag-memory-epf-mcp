import { openCorpus, exitOnRefuse } from './lib/db.mjs';
import { CORPORA } from './lib/paths.mjs';
import { mulberry32, shuffle } from './lib/prng.mjs';
const label = process.argv[2]; const n = parseInt(process.argv[3] || '45', 10);
await exitOnRefuse(async () => {
  const { db, close } = await openCorpus({ dbPath: CORPORA[label].copy, label });
  const ents = db.prepare(`SELECT id, name, entityType FROM entities`).all();
  const docs = db.prepare(`SELECT id, content FROM documents`).all();
  const lower = docs.map(d => ({ id: d.id, c: d.content.toLowerCase(), title: (d.content.match(/^#\s*(.+)$/m) || [, d.id])[1].slice(0, 80) }));
  const rows = [];
  for (const e of ents) {
    const nm = e.name.toLowerCase(); if (nm.length < 4) continue;
    const hits = lower.filter(d => d.c.includes(nm));
    if (hits.length >= 3) rows.push({ name: e.name, type: e.entityType, docs: hits.length, titles: hits.slice(0, 3).map(h => h.title) });
  }
  const strat = { low: rows.filter(r => r.docs <= 5), mid: rows.filter(r => r.docs > 5 && r.docs <= 20), high: rows.filter(r => r.docs > 20) };
  const rng = mulberry32(2026); const per = Math.ceil(n / 3);
  for (const [k, arr] of Object.entries(strat)) for (const r of shuffle(arr, rng).slice(0, per)) console.log(`${k}\t${r.docs}\t${r.type}\t${r.name}\t${r.titles.join(' | ')}`);
  console.error(`candidates low/mid/high = ${strat.low.length}/${strat.mid.length}/${strat.high.length} of ${rows.length} (text-mention ≥3)`);
  close();
});
