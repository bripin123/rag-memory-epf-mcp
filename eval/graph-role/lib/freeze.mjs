import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './paths.mjs';
export const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
export function readFreeze(dir = join(EVAL_DIR, 'suite')) {
  const p = join(dir, 'FREEZE.md'); if (!existsSync(p)) return new Map();
  const m = new Map();
  for (const line of readFileSync(p, 'utf8').split('\n')) { const mm = line.match(/^\| `([^`]+)` \| ([0-9a-f]{64}) \|/); if (mm) m.set(mm[1], mm[2]); }
  return m;
}
export function assertFrozen({ rel, allowUnfrozen = false, dir = join(EVAL_DIR, 'suite'), fileDir = dir }) {
  const want = readFreeze(dir).get(rel); const have = sha256File(join(fileDir, rel));
  if (want === have) return { frozen: true };
  if (allowUnfrozen) { console.error(`UNFROZEN ${rel} (recorded=${want ?? 'none'} actual=${have.slice(0, 12)})`); return { frozen: false }; }
  console.error(`FROZEN_MISMATCH ${rel}`); process.exit(3);
}
const CLASSES = new Set(['K', 'A', 'M']), SPLITS = new Set(['dev', 'holdout']), DIRS = new Set(['out', 'in', 'any']);
export function validateSuite(rows) {
  const errs = []; const ids = new Set(); const famSplit = new Map(); const kDocs = new Map();
  rows.forEach((r, i) => {
    const at = `row ${i} (${r.id})`;
    if (!r.id || ids.has(r.id)) errs.push(`${at}: missing/duplicate id`); ids.add(r.id);
    if (!CLASSES.has(r.class)) errs.push(`${at}: class`); if (!SPLITS.has(r.split)) errs.push(`${at}: split`);
    if (!r.family) errs.push(`${at}: family`); if (typeof r.text !== 'string' || r.text.length < 8) errs.push(`${at}: text`);
    if (famSplit.has(r.family) && famSplit.get(r.family) !== r.split) errs.push(`${at}: family ${r.family} spans splits`); famSplit.set(r.family, r.split);
    if (r.class === 'K') { if (!r.oracle_chunk_id || !r.document_id) errs.push(`${at}: K needs oracle_chunk_id+document_id`); if (kDocs.has(r.document_id)) errs.push(`${at}: document ${r.document_id} used twice in K`); kDocs.set(r.document_id, r.id); }
    else {
      if (!Array.isArray(r.expected_entities) || r.expected_entities.length === 0) errs.push(`${at}: expected_entities`);
      if (!Array.isArray(r.seed_candidates) || r.seed_candidates.length === 0) errs.push(`${at}: seed_candidates`);
      if (!Array.isArray(r.source_docs) || r.source_docs.length === 0) errs.push(`${at}: source_docs`);
      if (!['source-grounded', 'kg-informed'].includes(r.author_mode)) errs.push(`${at}: author_mode`);
      for (const path of (r.expected_paths || [])) for (const e of path) if (!e.from || !e.to || !e.type || !DIRS.has(e.direction) || typeof e.required !== 'boolean') errs.push(`${at}: malformed edge ${JSON.stringify(e)}`);
      if (r.class === 'M' && !(r.expected_paths || []).some(p => p.length >= 2)) errs.push(`${at}: M needs a path with >= 2 edges`);
    }
  });
  return errs;
}
if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--validate')) {
  const { readFileSync, existsSync, readdirSync } = await import('node:fs');
  const dir = join(EVAL_DIR, 'suite'); let bad = 0;
  for (const f of readdirSync(dir).filter(f => /^queries\.\w+\.jsonl$/.test(f))) {
    const rows = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const errs = validateSuite(rows); console.log(`${f}: rows ${rows.length} errors ${errs.length}`); errs.forEach(e => console.log('  ' + e)); bad += errs.length;
  }
  if (existsSync(join(EVAL_DIR, 'out')) && readdirSync(join(EVAL_DIR, 'out')).length) { console.log('OUT_NOT_EMPTY: runners ran before freeze'); bad++; }
  process.exit(bad ? 5 : 0);
}
