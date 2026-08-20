// T7 — run-upstream.mjs must produce its structural metrics with or without qrels.
//
// Stage 1's judging ended on the authored axis (weighted kappa 0.619 < 0.67), so
// suite/qrels.<label>.jsonl was never written. The upstream runner still has to emit seed
// recall / edge validity / encoded-path coverage, and every judged-gold-dependent number has
// to come out as `null` beside an explicit marker so a consumer cannot read "not measured"
// as 0. These tests pin both paths.
//
// Every run happens inside a tmp-dir sandbox that copies eval/graph-role's `lib/` and the
// script under test, so `lib/paths.mjs` resolves EVAL_DIR to the sandbox: nothing under the
// real eval/graph-role/{suite,out,dbs,pool,links} is read or written. The corpus DB is a
// four-row SQLite file built here, not a copy of any real corpus. `node_modules` is a
// symlink (the script imports better-sqlite3) and is unlinked before the sandbox is removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(REPO, 'eval', 'graph-role');
const SCRIPT = 'run-upstream.mjs';
// realpath: on macOS tmpdir() is /var/... which is a symlink to /private/var/..., and the
// script's `import.meta.url === file://${process.argv[1]}` CLI guard compares the resolved
// module URL against the raw argv path — an unresolved tmp path makes the script a silent no-op.
const TMP = realpathSync(tmpdir());

function sandbox() {
  const dir = join(mkdtempSync(join(TMP, 'gr-t7-')), 'graph-role');
  for (const sub of ['suite', 'out', 'dbs']) mkdirSync(join(dir, sub), { recursive: true });
  cpSync(join(SRC, 'lib'), join(dir, 'lib'), { recursive: true });
  copyFileSync(join(SRC, SCRIPT), join(dir, SCRIPT));
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}
function teardown(dir) {
  const nm = join(dir, 'node_modules');
  if (existsSync(nm)) unlinkSync(nm);                       // unlink the symlink, never its target
  rmSync(dirname(dir), { recursive: true, force: true });
}
const run = (dir, label) => spawnSync(process.execPath, [join(dir, SCRIPT), label], { encoding: 'utf8' });
const writeJsonl = (p, rows) => writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// FREEZE.md is what assertFrozen reads; freeze exactly the files named.
function freeze(dir, rels) {
  const rows = rels.map(r => `| \`${r}\` | ${sha(join(dir, 'suite', r))} | test | \`test\` |`);
  writeFileSync(join(dir, 'suite', 'FREEZE.md'), ['# FREEZE', '', '| file | sha256 | frozen_at | commit |', '|---|---|---|---|', ...rows, ''].join('\n'));
}

const edge = (from, to, required = true) => ({ from, to, type: 'any', direction: 'any', required });

// Suite + runner inputs. Two non-K rows (one per author_mode) plus a K row that must be
// filtered out. hub-A-1's gold document doc2 sits at rank 3 of its graph-off top10 and is
// linked to seed entity E1; hub-M-1's gold doc4 is reachable from nothing, so its judged
// numbers are a real 0 / -1 rather than an absence.
function fixture(dir) {
  writeJsonl(join(dir, 'suite', 'queries.hub.jsonl'), [
    { id: 'hub-A-1', class: 'A', split: 'dev', family: 'famA', text: 'authored A row', author_mode: 'source-grounded', expected_entities: ['E1'], seed_candidates: ['E1', 'E9'], source_docs: ['doc2'], expected_paths: [[edge('E1', 'E2')]] },
    { id: 'hub-M-1', class: 'M', split: 'dev', family: 'famM', text: 'authored M row', author_mode: 'kg-informed', expected_entities: ['E2'], seed_candidates: ['E2'], source_docs: ['doc4'], expected_paths: [[edge('E1', 'E2'), edge('E2', 'E7')]] },
    { id: 'hub-K-1', class: 'K', split: 'dev', family: 'kdoc', text: 'known item', oracle_chunk_id: 'doc2_chunk_0', document_id: 'doc2' },
  ]);
  const hop = { from: 'E1', to: 'E2', edge_id: 'rel_1', relation_type: 'R', direction: 'out', confidence: 1 };
  writeJsonl(join(dir, 'suite', 'observed.hub.jsonl'), [
    { id: 'hub-A-1', observed_paths: [hop] },
    { id: 'hub-M-1', observed_paths: [hop, { from: 'E2', to: 'E7', missing_entity: 'E7' }] },
    { id: 'hub-K-1', observed_paths: [] },
  ]);
  const chans = (docs) => ({ 'graph-n1': { doc100: docs } });
  writeJsonl(join(dir, 'out', 'candidates.hub.real.jsonl'), [
    { id: 'hub-A-1', class: 'A', cond: 'real', seeds: [{ name: 'E1', sim: 0.55 }], channels: chans(['doc3']) },
    { id: 'hub-M-1', class: 'M', cond: 'real', seeds: [{ name: 'E5', sim: 0.41 }], channels: chans(['doc3']) },
    { id: 'hub-K-1', class: 'K', cond: 'real', seeds: [{ name: 'E1', sim: 0.55 }], channels: chans(['doc3']) },
  ]);
  const t = (docs) => ({ top10: docs.map(d => ({ doc: d, chunk_id: `${d}_chunk_0` })) });
  writeJsonl(join(dir, 'out', 'final.hub.real.jsonl'), [
    { id: 'hub-A-1', class: 'A', cond: 'real', off: t(['doc9', 'doc8', 'doc2']), on: t(['doc9', 'doc8', 'doc2']) },
    { id: 'hub-M-1', class: 'M', cond: 'real', off: t(['doc9']), on: t(['doc9']) },
  ]);
  freeze(dir, ['queries.hub.jsonl']);

  const db = new Database(join(dir, 'dbs', 'hub.db'));
  db.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT);
           CREATE TABLE chunk_metadata (rowid INTEGER PRIMARY KEY, chunk_id TEXT UNIQUE, document_id TEXT);
           CREATE TABLE chunk_entities (chunk_rowid INTEGER, entity_id TEXT, PRIMARY KEY (chunk_rowid, entity_id));`);
  const ent = db.prepare('INSERT INTO entities VALUES (?, ?)');
  for (const [id, name] of [['e1', 'E1'], ['e2', 'E2'], ['e5', 'E5']]) ent.run(id, name);
  const chunk = db.prepare('INSERT INTO chunk_metadata VALUES (?, ?, ?)');
  for (const [rid, doc] of [[1, 'doc2'], [2, 'doc9'], [3, 'doc8'], [4, 'doc7']]) chunk.run(rid, `${doc}_chunk_0`, doc);
  const link = db.prepare('INSERT INTO chunk_entities VALUES (?, ?)');
  for (const [rid, eid] of [[1, 'e1'], [2, 'e1'], [2, 'e2'], [3, 'e2']]) link.run(rid, eid);   // doc9 has 2 links, doc8 has 1
  db.close();
  return dir;
}

// Structural metrics are identical on both paths — they never touch gold.
function assertStructural(rows) {
  assert.deepEqual(rows.map(r => r.id), ['hub-A-1', 'hub-M-1'], 'K rows are excluded');
  const [a, m] = rows;
  assert.equal(a.seed_recall, 1); assert.deepEqual(a.seeds_hit, ['E1']);
  assert.equal(m.seed_recall, 0); assert.deepEqual(m.seeds_hit, []);
  assert.deepEqual(a.edge_validity, { total: 1, exists: 1, direction_ok: 1, type_ok: 1, required_missing: 0 });
  assert.deepEqual(m.edge_validity, { total: 2, exists: 1, direction_ok: 1, type_ok: 1, required_missing: 1 });
  assert.equal(a.encoded_path_coverage, null, 'source-grounded rows carry no encoded-path coverage');
  assert.equal(m.encoded_path_coverage, 0.5, 'kg-informed row: 1 of 2 encoded edges exists');
}

// ---- qrels absent: exit 0, marker present, judged metrics null -------------------------

test('T7 run-upstream: qrels absent — exits 0, announces it, and marks the skipped metrics', () => {
  const dir = fixture(sandbox());
  try {
    assert.ok(!existsSync(join(dir, 'suite', 'qrels.hub.jsonl')), 'this test needs qrels to be genuinely missing');
    const r = run(dir, 'hub');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^QRELS_ABSENT hub \(kappa gate fail — authored-axis run\); judged-gold metrics skipped$/m);
    assert.match(r.stdout, /projection_recall\/hubdeg_misrank null — qrels-absent \(not measured, not 0\)/);

    const rows = readJsonl(join(dir, 'out', 'upstream.hub.jsonl'));
    assertStructural(rows);
    for (const row of rows) {
      assert.equal(row.projection_recall, null, `${row.id}: judged-gold metric must be null, never 0`);
      assert.equal(row.hubdeg_misrank, null, `${row.id}: judged-gold metric must be null, never 0`);
      assert.equal(row.skipped, 'qrels-absent', `${row.id}: the null needs an explicit cause`);
      assert.deepEqual(row.skipped_metrics, ['projection_recall', 'hubdeg_misrank']);
    }
    // the marker survives serialisation as a real field, not an undefined dropped by JSON
    assert.match(readFileSync(join(dir, 'out', 'upstream.hub.jsonl'), 'utf8'), /"skipped":"qrels-absent"/);
  } finally { teardown(dir); }
});

// ---- qrels present: unchanged behaviour ------------------------------------------------

test('T7 run-upstream: qrels present — judged metrics are numeric and no marker is emitted', () => {
  const dir = fixture(sandbox());
  try {
    writeJsonl(join(dir, 'suite', 'qrels.hub.jsonl'), [
      { qid: 'hub-A-1', doc_id: 'doc2', chunk_id: 'doc2_chunk_0', grade: 2 },
      { qid: 'hub-A-1', doc_id: 'doc7', chunk_id: 'doc7_chunk_0', grade: 0 },   // graded 0 => not gold
      { qid: 'hub-M-1', doc_id: 'doc4', chunk_id: 'doc4_chunk_0', grade: 1 },
    ]);
    freeze(dir, ['queries.hub.jsonl', 'qrels.hub.jsonl']);

    const r = run(dir, 'hub');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/QRELS_ABSENT/.test(r.stderr), r.stderr);
    assert.ok(!/qrels-absent/.test(r.stdout), r.stdout);

    const rows = readJsonl(join(dir, 'out', 'upstream.hub.jsonl'));
    assertStructural(rows);
    const [a, m] = rows;
    assert.equal(a.projection_recall, 1, 'doc2 is reachable from seed E1');
    assert.deepEqual(a.hubdeg_misrank, { gold_rank_off: 3, above_gold_link_counts: [2, 1] });
    assert.equal(m.projection_recall, 0, 'doc4 is reachable from nothing — a measured 0');
    assert.deepEqual(m.hubdeg_misrank, { gold_rank_off: -1, above_gold_link_counts: [] });
    for (const row of rows) {
      assert.equal(row.skipped, undefined, 'no marker when qrels exist');
      assert.equal(row.skipped_metrics, undefined);
    }
  } finally { teardown(dir); }
});

test('T7 run-upstream: qrels present but nothing graded >= 1 — null without the absent marker', () => {
  const dir = fixture(sandbox());
  try {
    writeJsonl(join(dir, 'suite', 'qrels.hub.jsonl'), [{ qid: 'hub-A-1', doc_id: 'doc2', chunk_id: 'doc2_chunk_0', grade: 0 }]);
    freeze(dir, ['queries.hub.jsonl', 'qrels.hub.jsonl']);
    const r = run(dir, 'hub');
    assert.equal(r.status, 0, r.stderr);
    const rows = readJsonl(join(dir, 'out', 'upstream.hub.jsonl'));
    for (const row of rows) {
      assert.equal(row.projection_recall, null, 'no gold for this query => null');
      assert.equal(row.skipped, undefined, 'that null is NOT "qrels absent" — the marker must distinguish them');
    }
  } finally { teardown(dir); }
});

// ---- the freeze gate is not weakened for the files that do exist -----------------------

test('T7 run-upstream: an unfrozen queries file still exits 3 (qrels-absent mode does not relax it)', () => {
  const dir = fixture(sandbox());
  try {
    writeFileSync(join(dir, 'suite', 'FREEZE.md'), '# FREEZE\n\n| file | sha256 | frozen_at | commit |\n|---|---|---|---|\n');
    const r = run(dir, 'hub');
    assert.equal(r.status, 3, r.stdout);
    assert.match(r.stderr, /FROZEN_MISMATCH queries\.hub\.jsonl/);
    assert.ok(!existsSync(join(dir, 'out', 'upstream.hub.jsonl')), 'nothing is written when the gate fails');
  } finally { teardown(dir); }
});

test('T7 run-upstream: an existing but unfrozen qrels file still exits 3', () => {
  const dir = fixture(sandbox());
  try {
    writeJsonl(join(dir, 'suite', 'qrels.hub.jsonl'), [{ qid: 'hub-A-1', doc_id: 'doc2', chunk_id: 'doc2_chunk_0', grade: 2 }]);
    freeze(dir, ['queries.hub.jsonl', 'qrels.hub.jsonl']);
    writeJsonl(join(dir, 'suite', 'qrels.hub.jsonl'), [{ qid: 'hub-A-1', doc_id: 'doc9', chunk_id: 'doc9_chunk_0', grade: 2 }]);  // edited after freezing
    const r = run(dir, 'hub');
    assert.equal(r.status, 3, r.stdout);
    assert.match(r.stderr, /FROZEN_MISMATCH qrels\.hub\.jsonl/);
  } finally { teardown(dir); }
});

// ---- the pure helper, on its own --------------------------------------------------------

test('T7 loadGoldDocs: reports absence explicitly and groups graded documents by query', async () => {
  const { loadGoldDocs } = await import('../eval/graph-role/run-upstream.mjs');
  const dir = mkdtempSync(join(TMP, 'gr-t7u-'));
  try {
    const missing = loadGoldDocs(join(dir, 'nope.jsonl'));
    assert.equal(missing.skipped, 'qrels-absent');
    assert.equal(missing.goldDocs.size, 0);

    const p = join(dir, 'qrels.jsonl');
    writeJsonl(p, [
      { qid: 'q1', doc_id: 'd1', grade: 2 },
      { qid: 'q1', doc_id: 'd2', grade: 1 },
      { qid: 'q1', doc_id: 'd3', grade: 0 },
      { qid: 'q2', doc_id: 'd4', grade: 0 },
    ]);
    const got = loadGoldDocs(p);
    assert.equal(got.skipped, null, 'a file that exists is never "skipped"');
    assert.deepEqual([...got.goldDocs.get('q1')], ['d1', 'd2']);
    assert.equal(got.goldDocs.has('q2'), false, 'a query whose only judgement is 0 has no gold');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
