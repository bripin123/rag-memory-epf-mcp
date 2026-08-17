import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rrf, cutK, cutUniqueDoc } from '../eval/graph-role/lib/rrf.mjs';
import { mulberry32, shuffle } from '../eval/graph-role/lib/prng.mjs';
import { validateSuite, sha256File, readFreeze } from '../eval/graph-role/lib/freeze.mjs';
import { LIVE_PATHS } from '../eval/graph-role/lib/paths.mjs';

// rrf: deterministic fusion + tie-break by id
{
  const f = rrf([['a', 'b', 'c'], ['b', 'a', 'd']]);
  assert.deepEqual(f.map(x => x.id).slice(0, 2), ['a', 'b']);
  assert.equal(cutK(f, 2).length, 2);
  const uniq = cutUniqueDoc([{ id: 'x1' }, { id: 'x2' }, { id: 'y1' }], 2, id => id[0]);
  assert.deepEqual(uniq.map(u => u.id), ['x1', 'y1']);
  console.log('  OK: rrf/cutK/cutUniqueDoc');
}
// prng: seeded, reproducible
{ const a = shuffle([1, 2, 3, 4, 5], mulberry32(7)), b = shuffle([1, 2, 3, 4, 5], mulberry32(7)); assert.deepEqual(a, b); console.log('  OK: mulberry32 reproducible'); }
// validateSuite: leakage + family + schema
{
  const ok = [{ id: 'k1', class: 'K', split: 'dev', family: 'doc1', text: 'known item query text', oracle_chunk_id: 'c1', document_id: 'doc1' },
              { id: 'a1', class: 'A', split: 'dev', family: 'fam1', text: 'what relates to X', expected_entities: ['X'], seed_candidates: ['X'], source_docs: ['d'], author_mode: 'source-grounded', expected_paths: [] }];
  assert.deepEqual(validateSuite(ok), []);
  const bad = ok.concat([{ id: 'k2', class: 'K', split: 'holdout', family: 'doc1', text: 'another query', oracle_chunk_id: 'c2', document_id: 'doc1' }]);
  const errs = validateSuite(bad);
  assert.ok(errs.some(e => /spans splits/.test(e)) && errs.some(e => /used twice/.test(e)));
  console.log('  OK: validateSuite catches leakage/family');
}
// freeze table parse + live paths present
{
  const d = mkdtempSync(join(tmpdir(), 'gr-'));
  writeFileSync(join(d, 'x.jsonl'), 'a\n');
  const h = sha256File(join(d, 'x.jsonl'));
  writeFileSync(join(d, 'FREEZE.md'), `| file | sha256 | at |\n|---|---|---|\n| \`x.jsonl\` | ${h} | now |\n`);
  assert.equal(readFreeze(d).get('x.jsonl'), h);
  rmSync(d, { recursive: true, force: true });
  assert.equal(LIVE_PATHS.size, 3);
  console.log('  OK: readFreeze parses table; 3 live paths registered');
}
console.log('eval-graph-role-libs: ALL OK');
