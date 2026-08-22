// Task 7 Step 3a — link-audit sample: a stratified-by-link-count sample of chunk<->entity pairs
// from the frozen corpus copy. Each pair is classified by provenanceOf as a plain string match
// ('name') or a nonliteral (semantic/inferred) link -- entity linking in this engine is not purely
// lexical (autoLinkEntities also matches on observations), so a chunk can be linked to an entity
// whose name never appears in the chunk text at all.
//
// Blinding (review finding, 2026-08-22): that label used to be written into the judge file itself.
// The judge is asked whether the chunk mentions the entity, and `provenance` answers the lexical
// half of exactly that question -- and link-audit-merge.mjs then reported precision split by the
// same field, so the split was partly measuring the cue rather than the linker. The label now goes
// to <label>.links.key.jsonl, which only the merge reads; the judge file carries the pair alone.
//
// Read-only against dbs/<label>.db (new Database(path, { readonly: true })): never writes to dbs/,
// never boots the engine (openCorpus), never opens a live DB.
//
// Deviation from the brief: the brief's pseudocode writes to pool/<label>.links.judge.jsonl and
// pool/<label>.links.prevalence.json. pool/ is Task 6's live output directory while judging runs
// concurrently (never touch anything under it) -- per the Task 7 dispatch, both outputs are
// redirected to eval/graph-role/links/ instead. link-audit-merge.mjs reads them from there.
//
// Fix round 1: every row is also tagged second_judge: true|false -- a seeded ~20% (stratified,
// floor 1/stratum) subsample the controller sends to a second judge (codex) so
// link-audit-merge.mjs can report inter-rater reliability (lib/reliability.mjs's reliabilityOf)
// instead of shipping precision numbers with no agreement signal at all.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CORPORA, EVAL_DIR } from './lib/paths.mjs';
import { mulberry32, shuffle } from './lib/prng.mjs';
import { provenanceOf } from './lib/stages.mjs';

// Deterministic stratified subsample selection for the second-judge tag: ~20% of rows per
// stratum, floor 1 per non-empty stratum (so even a tiny high-links stratum still gets an
// inter-rater data point). Pure: takes the already-built sample rows and an rng, returns the Set
// of jids to tag -- the caller sets `second_judge` on each row from membership in that set.
export function selectSecondJudgeJids(rows, rng) {
  const byStratum = { low: [], mid: [], high: [] };
  for (const r of rows) byStratum[r.stratum].push(r);
  const tagged = new Set();
  for (const s of ['low', 'mid', 'high']) {
    const arr = byStratum[s]; if (!arr.length) continue;
    const want = Math.max(1, Math.round(arr.length * 0.2));
    for (const r of shuffle(arr, rng).slice(0, want)) tagged.add(r.jid);
  }
  return tagged;
}

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
  // second-judge tag: a separate rng stream (seed+9, independent of the seed+7 stream above) so
  // adding this tag does not perturb which chunks/names were sampled -- re-running produces the
  // same 572/590/577-style pair counts and jids as before this fix round, only `second_judge` is new.
  const secondJudgeJids = selectSecondJudgeJids(rows, mulberry32(th.bootstrap.seed + 9));
  for (const r of rows) r.second_judge = secondJudgeJids.has(r.jid);
  const bySecond = { low: 0, mid: 0, high: 0 };
  for (const r of rows) if (r.second_judge) bySecond[r.stratum]++;

  const outDir = join(EVAL_DIR, 'links');
  mkdirSync(outDir, { recursive: true });
  // One shuffle, two projections: the judge file and the key must stay row-aligned by jid, and
  // re-shuffling for the key would not change that but would make the two files needlessly hard to
  // diff by eye during an audit.
  const shuffled = shuffle(rows, rng);
  writeFileSync(join(outDir, `${label}.links.judge.jsonl`), shuffled.map(({ provenance, ...blinded }) => JSON.stringify(blinded)).join('\n') + '\n');
  writeFileSync(join(outDir, `${label}.links.key.jsonl`), shuffled.map(r => JSON.stringify({ jid: r.jid, provenance: r.provenance })).join('\n') + '\n');
  writeFileSync(join(outDir, `${label}.links.prevalence.json`), JSON.stringify(prevalence) + '\n');
  console.log(`${label}: link pairs ${rows.length} (name ${rows.filter(r => r.provenance === 'name').length} / nonliteral ${rows.filter(r => r.provenance === 'nonliteral').length}) prevalence ${JSON.stringify(prevalence)} second_judge ${secondJudgeJids.size}/${rows.length} (${JSON.stringify(bySecond)})`);
  db.close();
  return { rows, prevalence, secondJudgeJids };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const label = process.argv[2];
  if (!CORPORA[label]) { console.error('usage: link-audit-sample.mjs <hub|uap|hal>'); process.exit(2); }
  run(label);
}
