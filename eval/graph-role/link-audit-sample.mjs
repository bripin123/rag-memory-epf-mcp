// Task 7 Step 3a — link-audit sample: a stratified-by-link-count sample of chunk<->entity pairs
// from the frozen corpus copy, each labeled with provenanceOf so judges can be told whether a pair
// is a plain string match ('name') or a nonliteral (semantic/inferred) link -- entity linking in
// this engine is not purely lexical (autoLinkEntities also matches on observations), so a chunk can
// be linked to an entity whose name never appears in the chunk text at all.
//
// Read-only against dbs/<label>.db (new Database(path, { readonly: true })): never writes to dbs/,
// never boots the engine (openCorpus), never opens a live DB.
//
// Deviation from the brief: the brief's pseudocode writes to pool/<label>.links.judge.jsonl and
// pool/<label>.links.prevalence.json. pool/ is Task 6's live output directory while judging runs
// concurrently (never touch anything under it) -- per the Task 7 dispatch, both outputs are
// redirected to eval/graph-role/links/ instead. link-audit-merge.mjs reads them from there.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CORPORA, EVAL_DIR } from './lib/paths.mjs';
import { mulberry32, shuffle } from './lib/prng.mjs';
import { provenanceOf } from './lib/stages.mjs';

export function run(label) {
  const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
  const db = new Database(CORPORA[label].copy, { readonly: true });
  const chunks = db.prepare(`SELECT cm.rowid, cm.chunk_id, cm.text, (SELECT COUNT(*) FROM chunk_entities ce WHERE ce.chunk_rowid = cm.rowid) AS links FROM chunk_metadata cm WHERE cm.chunk_type='document'`).all();
  const strata = { low: chunks.filter(c => c.links >= 1 && c.links <= 5), mid: chunks.filter(c => c.links > 5 && c.links <= 30), high: chunks.filter(c => c.links > 30) };
  const rng = mulberry32(th.bootstrap.seed + 7);
  const linksOf = db.prepare(`SELECT e.name FROM chunk_entities ce JOIN entities e ON e.id = ce.entity_id WHERE ce.chunk_rowid = ? ORDER BY e.name`);
  const rows = []; let j = 0; const prevalence = {};
  for (const [s, arr] of Object.entries(strata)) {
    prevalence[s] = arr.length;
    for (const c of shuffle(arr, rng).slice(0, 20)) {
      const names = shuffle(linksOf.all(c.rowid).map(r => r.name), rng).slice(0, 15);
      for (const nm of names) rows.push({ jid: `${label}-L${++j}`, stratum: s, chunk_id: c.chunk_id, chunk_links: c.links, entity_name: nm, provenance: provenanceOf(c.text, nm), chunk_text: c.text });
    }
  }
  const outDir = join(EVAL_DIR, 'links');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${label}.links.judge.jsonl`), shuffle(rows, rng).map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(outDir, `${label}.links.prevalence.json`), JSON.stringify(prevalence) + '\n');
  console.log(`${label}: link pairs ${rows.length} (name ${rows.filter(r => r.provenance === 'name').length} / nonliteral ${rows.filter(r => r.provenance === 'nonliteral').length}) prevalence ${JSON.stringify(prevalence)}`);
  db.close();
  return { rows, prevalence };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const label = process.argv[2];
  if (!CORPORA[label]) { console.error('usage: link-audit-sample.mjs <hub|uap|hal>'); process.exit(2); }
  run(label);
}
