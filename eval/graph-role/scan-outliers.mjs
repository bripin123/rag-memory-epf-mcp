// Sleep-outlier scan (ruling: the Mac slept ~07:45-08:45 KST while the driver ran; timing rows
// spanning the sleep carry ms > 30,000). Reads every out/*.jsonl, reports which files/(corpus,cond)
// pairs are affected so the controller can re-run just those. No DB — reads finished JSONL only.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './lib/paths.mjs';
import { CORPUS_ORDER, CONDS, outlierRows, pairsFromFilenames } from './lib/manifest.mjs';

const args = process.argv.slice(2); const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dir = get('--dir', join(EVAL_DIR, 'out'));
const threshold = Number(get('--threshold', '30000'));
const jsonOut = args.includes('--json');

const names = readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
const outlierFiles = [];
for (const name of names) {
  let text;
  try { text = readFileSync(join(dir, name), 'utf8'); }
  catch (e) { console.error(`SKIP ${name}: unreadable (${e instanceof Error ? e.message : String(e)})`); continue; }
  const lines = text.split('\n');
  const rows = [];
  lines.forEach((line, idx) => {
    if (!line) return;
    try { rows.push(JSON.parse(line)); }
    catch {
      // A concurrent writer can leave the last line half-written; anywhere else is worth a note,
      // but neither case should crash the scan.
      if (idx === lines.length - 1) return;
      console.error(`SKIP ${name}:${idx + 1} unparsable line`);
    }
  });
  const { n, max_ms } = outlierRows(rows, threshold);
  if (n > 0) outlierFiles.push({ file: name, rows: n, max_ms });
}

// Unique (corpus,cond) pairs in CORPUS_ORDER x CONDS order; purevec files collapse to PUREVEC <corpus>.
const condIndex = new Map(CONDS.map((c, i) => [c, i]));
const corpusIndex = new Map(CORPUS_ORDER.map((c, i) => [c, i]));
const pairs = pairsFromFilenames(outlierFiles.map(f => f.file));
const seenPair = new Set(), regular = [];
const seenPurevec = new Set(), purevec = [];
for (const p of pairs) {
  if (p.runner === 'purevec') { if (!seenPurevec.has(p.corpus)) { seenPurevec.add(p.corpus); purevec.push(p.corpus); } }
  else { const key = `${p.corpus}|${p.cond}`; if (!seenPair.has(key)) { seenPair.add(key); regular.push({ corpus: p.corpus, cond: p.cond }); } }
}
regular.sort((a, b) => (corpusIndex.get(a.corpus) - corpusIndex.get(b.corpus)) || (condIndex.get(a.cond) - condIndex.get(b.cond)));
purevec.sort((a, b) => corpusIndex.get(a) - corpusIndex.get(b));

if (jsonOut) {
  console.log(JSON.stringify({ files: outlierFiles, pairs: [...regular, ...purevec.map(corpus => ({ corpus, cond: null }))], threshold }));
} else {
  for (const f of outlierFiles) console.log(`OUTLIER ${f.file} rows=${f.rows} max_ms=${f.max_ms}`);
  for (const { corpus, cond } of regular) console.log(`PAIR ${corpus} ${cond}`);
  for (const corpus of purevec) console.log(`PUREVEC ${corpus}`);
  console.log(`SUMMARY files=${names.length} outlier_files=${outlierFiles.length} pairs=${regular.length + purevec.length} threshold=${threshold}`);
}
process.exit(outlierFiles.length > 0 ? 13 : 0);
