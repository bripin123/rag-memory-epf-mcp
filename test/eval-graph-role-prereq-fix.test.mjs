// Pre-build repairs — the three findings that the graph-upstream-build change stands on.
//
// (1) OBSERVED STALENESS. DECISION.md §9's re-evaluation command list never re-ran
//     extract-observed.mjs, so shipping a graph change and re-running §9 would have re-measured
//     Stage 1's observation file against the new graph and reported "no improvement" for a
//     mechanical reason. A line in the runbook alone cannot enforce that (nothing reads it), so
//     extract-observed.mjs stamps the snapshot identity it derived from and run-upstream.mjs
//     refuses an observation file that was not derived from the current snapshot. The stamp keys
//     on snapshot.json's recorded sha256, not on a live hash of dbs/<label>.db: the pipeline's
//     own stages (run-candidates/run-final open the copy through the engine) mutate that file, so
//     a re-hash would flap for reasons unrelated to staleness.
//
// (2) SNAPSHOT OPEN MODE. snapshot.mjs's header claimed it "never opens the live DB for writing"
//     while invoking the sqlite3 CLI with no -readonly, which does open read-write and, measured
//     here, creates -wal/-shm next to the user's live DB. Plain -readonly is not a drop-in: on a
//     WAL database with no -shm present, SQLite cannot create the shared-memory file and refuses
//     to open at all. Both halves of that are pinned below as executable controls, because the
//     fallback's existence is only justified by the second one being true.
//
// (3) LINK-AUDIT BLINDING. link-audit-sample.mjs wrote `provenance` (whether the entity name
//     literally occurs in the chunk text) into the file handed to the judges, and
//     link-audit-merge.mjs then reported precision split by that same field — the judge was told
//     the answer to the lexical half of the question it was being asked. The label now travels in
//     a separate key file that only the merge reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(REPO, 'eval', 'graph-role');
const TMP = realpathSync(tmpdir());

const writeJsonl = (p, rows) => writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

// Same sandbox shape as the T7 tests: copy lib/ plus the scripts under test into a tmp dir so
// lib/paths.mjs resolves EVAL_DIR there and nothing under the real eval/graph-role is touched.
function sandbox(prefix, scripts) {
  const dir = join(mkdtempSync(join(TMP, prefix)), 'graph-role');
  for (const sub of ['suite', 'out', 'dbs', 'links']) mkdirSync(join(dir, sub), { recursive: true });
  cpSync(join(SRC, 'lib'), join(dir, 'lib'), { recursive: true });
  for (const s of scripts) copyFileSync(join(SRC, s), join(dir, s));
  copyFileSync(join(SRC, 'thresholds.json'), join(dir, 'thresholds.json'));
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}
function teardown(dir) {
  try { unlinkSync(join(dir, 'node_modules')); } catch {}
  rmSync(dirname(dir), { recursive: true, force: true });
}
const sha = (s) => createHash('sha256').update(s).digest('hex');
function freeze(dir, rels) {
  const rows = rels.map(r => `| \`${r}\` | ${createHash('sha256').update(readFileSync(join(dir, 'suite', r))).digest('hex')} | test | \`test\` |`);
  writeFileSync(join(dir, 'suite', 'FREEZE.md'), ['# FREEZE', '', '| file | sha256 | frozen_at | commit |', '|---|---|---|---|', ...rows, ''].join('\n'));
}

// A four-row corpus copy plus the queries/candidates/final rows run-upstream joins across.
// SNAP_SHA is the snapshot identity the observation file is expected to carry.
const SNAP_SHA = 'a'.repeat(64);
function upstreamFixture(dir, { observedMeta = { snapshot_sha256: SNAP_SHA }, snapshotSha = SNAP_SHA } = {}) {
  const db = new Database(join(dir, 'dbs', 'hub.db'));
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT);
           CREATE TABLE relationships (id INTEGER PRIMARY KEY, relationType TEXT, confidence REAL, source_entity INTEGER, target_entity INTEGER);
           CREATE TABLE chunk_metadata (chunk_id TEXT, document_id TEXT, chunk_type TEXT, text TEXT);
           CREATE TABLE chunk_entities (chunk_rowid INTEGER, entity_id INTEGER);
           INSERT INTO entities (id, name) VALUES (1,'E1'),(2,'E2');
           INSERT INTO relationships VALUES (1,'RELATED_TO',0.9,1,2);
           INSERT INTO chunk_metadata VALUES ('c1','d1','document','E1 text'), ('c2','d2','document','E2 text');
           INSERT INTO chunk_entities VALUES (1,1),(2,2);`);
  db.close();
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({
    taken_at: '2026-01-01T00:00:00.000Z', engine_commit: 'deadbeef',
    corpora: { hub: { source: '/live/hub.db', copy: join(dir, 'dbs', 'hub.db'), bytes: 1, sha256: snapshotSha } },
  }, null, 2) + '\n');
  const hop = { from: 'E1', to: 'E2', edge_id: 1, relation_type: 'RELATED_TO', direction: 'out', confidence: 0.9 };
  writeJsonl(join(dir, 'suite', 'queries.hub.jsonl'), [
    { id: 'hub-A-1', class: 'A', seed_candidates: ['E1'], expected_paths: [[{ from: 'E1', to: 'E2', type: 'any', direction: 'any', required: true }]] },
  ]);
  freeze(dir, ['queries.hub.jsonl']);
  const rows = [{ id: 'hub-A-1', observed_paths: [hop] }];
  writeJsonl(join(dir, 'suite', 'observed.hub.jsonl'), observedMeta ? [{ meta: true, ...observedMeta }, ...rows] : rows);
  writeJsonl(join(dir, 'out', 'candidates.hub.real.jsonl'), [{ id: 'hub-A-1', seeds: [{ name: 'E1' }] }]);
  writeJsonl(join(dir, 'out', 'final.hub.real.jsonl'), [{ id: 'hub-A-1', graphoff: { top10: [] }, graphn1: { doc100: [] } }]);
  return dir;
}
const runUpstream = (dir) => spawnSync(process.execPath, [join(dir, 'run-upstream.mjs'), 'hub'], { encoding: 'utf8' });

test('(1) run-upstream refuses an observation file stamped with a different snapshot', () => {
  const dir = sandbox('gr-pf-stale-', ['run-upstream.mjs']);
  try {
    upstreamFixture(dir, { observedMeta: { snapshot_sha256: 'b'.repeat(64) } });
    const r = runUpstream(dir);
    assert.notEqual(r.status, 0, `expected refusal, got exit 0\n${r.stdout}`);
    assert.match(r.stderr, /OBSERVED_STALE/);
    assert.match(r.stderr, /extract-observed\.mjs/, 'the refusal must name the command that fixes it');
  } finally { teardown(dir); }
});

test('(1) run-upstream refuses an observation file with no snapshot stamp at all', () => {
  const dir = sandbox('gr-pf-unstamped-', ['run-upstream.mjs']);
  try {
    upstreamFixture(dir, { observedMeta: null });
    const r = runUpstream(dir);
    assert.notEqual(r.status, 0, `expected refusal, got exit 0\n${r.stdout}`);
    assert.match(r.stderr, /OBSERVED_UNSTAMPED/);
  } finally { teardown(dir); }
});

test('(1) run-upstream runs when the stamp matches, and the meta line is not read as a query row', () => {
  const dir = sandbox('gr-pf-fresh-', ['run-upstream.mjs']);
  try {
    upstreamFixture(dir);
    const r = runUpstream(dir);
    assert.equal(r.status, 0, r.stderr);
    const out = readJsonl(join(dir, 'out', 'upstream.hub.jsonl')).filter(x => !x.meta);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'hub-A-1');
    assert.equal(out[0].edge_validity.exists, 1, 'the fixture edge exists, so validity must see it');
  } finally { teardown(dir); }
});

test('(1) DECISION.md §9 re-runs extract-observed, and does so before run-upstream', () => {
  const body = readFileSync(join(SRC, 'DECISION.md'), 'utf8');
  const sec = body.slice(body.indexOf('## 9.'), body.indexOf('## 10.'));
  assert.ok(sec.length > 0, 'section 9 must exist');
  const ex = sec.indexOf('extract-observed.mjs'), up = sec.indexOf('run-upstream.mjs');
  assert.notEqual(ex, -1, 'section 9 must invoke extract-observed.mjs');
  assert.notEqual(up, -1, 'section 9 must invoke run-upstream.mjs');
  assert.ok(ex < up, 'extract-observed must be re-run before run-upstream reads observed.<c>.jsonl');
});

test('(2) sqlite3 -readonly backs up a WAL database when its -shm is present, and writes nothing', () => {
  const dir = mkdtempSync(join(TMP, 'gr-pf-ro-'));
  try {
    const live = join(dir, 'live.db');
    const db = new Database(live);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (a); INSERT INTO t VALUES (1),(2),(3);');
    // keep the handle open: that is the state the snapshot is taken in (server up, -shm present)
    assert.ok(existsSync(live + '-shm'), 'precondition: an open WAL database has a -shm');
    execFileSync('sqlite3', ['-readonly', live, `.backup '${join(dir, 'copy.db')}'`]);
    db.close();
    const copy = new Database(join(dir, 'copy.db'), { readonly: true });
    assert.equal(copy.prepare('SELECT count(*) c FROM t').get().c, 3);
    copy.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('(2) sqlite3 -readonly CANNOT open a WAL database whose -shm is absent — the fallback exists for this', () => {
  const dir = mkdtempSync(join(TMP, 'gr-pf-noshm-'));
  try {
    const live = join(dir, 'live.db');
    const db = new Database(live);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (a); INSERT INTO t VALUES (1);');
    db.close();
    rmSync(live + '-wal', { force: true }); rmSync(live + '-shm', { force: true });
    const r = spawnSync('sqlite3', ['-readonly', live, `.backup '${join(dir, 'copy.db')}'`], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'if this ever starts passing, snapshot.mjs should drop the fallback');
    assert.match(r.stderr, /unable to open database file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('(2) snapshot.mjs chooses read-only when a -shm is present and falls back, recorded, when it is not', async () => {
  const mod = await import(join(SRC, 'snapshot.mjs'));
  assert.equal(typeof mod.chooseOpenMode, 'function', 'snapshot.mjs must export chooseOpenMode for this to be testable');
  assert.equal(mod.chooseOpenMode({ shmPresent: true }), 'read-only');
  assert.equal(mod.chooseOpenMode({ shmPresent: false }), 'read-write');
  assert.deepEqual(mod.sqliteArgs('/db.sqlite', '/copy.db', 'read-only'), ['-readonly', '/db.sqlite', ".backup '/copy.db'"]);
  assert.deepEqual(mod.sqliteArgs('/db.sqlite', '/copy.db', 'read-write'), ['/db.sqlite', ".backup '/copy.db'"]);
});

test('(3) link-audit-sample keeps provenance out of the judge file and puts it in a key file', async () => {
  const dir = sandbox('gr-pf-blind-', ['link-audit-sample.mjs']);
  try {
    const db = new Database(join(dir, 'dbs', 'hub.db'));
    db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE chunk_metadata (chunk_id TEXT, document_id TEXT, chunk_type TEXT, text TEXT);
             CREATE TABLE chunk_entities (chunk_rowid INTEGER, entity_id INTEGER);
             INSERT INTO entities (id,name) VALUES (1,'Alpha'),(2,'Beta');
             INSERT INTO chunk_metadata VALUES ('c1','d1','document','Alpha appears here'),('c2','d2','document','nothing literal here');
             INSERT INTO chunk_entities VALUES (1,1),(1,2),(2,2);`);
    db.close();
    const mod = await import(join(dir, 'link-audit-sample.mjs') + `?t=${Date.now()}`);
    const { rows } = mod.run('hub');
    const judged = readJsonl(join(dir, 'links', 'hub.links.judge.jsonl'));
    const key = readJsonl(join(dir, 'links', 'hub.links.key.jsonl'));
    assert.ok(judged.length > 0);
    for (const r of judged) {
      assert.ok(!('provenance' in r), `judge row ${r.jid} still carries provenance — the judge can read the answer`);
      assert.ok('chunk_text' in r && 'entity_name' in r, 'the judge still needs the pair itself');
    }
    assert.equal(key.length, judged.length, 'every judged pair needs a key row');
    assert.deepEqual(new Set(key.map(k => k.jid)), new Set(judged.map(r => r.jid)));
    for (const k of key) assert.ok(k.provenance === 'name' || k.provenance === 'nonliteral', `bad provenance ${k.provenance}`);
    assert.equal(rows.length, judged.length);
  } finally { teardown(dir); }
});

test('(3) link-audit-merge joins provenance from the key file and marks the run blinded', async () => {
  const dir = sandbox('gr-pf-merge-', ['link-audit-merge.mjs']);
  try {
    const items = [
      { jid: 'hub-L1', stratum: 'low', chunk_id: 'c1', chunk_links: 2, entity_name: 'Alpha', chunk_text: 'Alpha appears', second_judge: false },
      { jid: 'hub-L2', stratum: 'low', chunk_id: 'c2', chunk_links: 2, entity_name: 'Beta', chunk_text: 'no literal', second_judge: false },
    ];
    writeJsonl(join(dir, 'links', 'hub.links.judge.jsonl'), items);
    writeJsonl(join(dir, 'links', 'hub.links.key.jsonl'), [{ jid: 'hub-L1', provenance: 'name' }, { jid: 'hub-L2', provenance: 'nonliteral' }]);
    writeJsonl(join(dir, 'links', 'hub.links.judge-A.jsonl'), [{ jid: 'hub-L1', mention: 1 }, { jid: 'hub-L2', mention: 0 }]);
    writeFileSync(join(dir, 'links', 'hub.links.prevalence.json'), JSON.stringify({ low: 10, mid: 0, high: 0 }) + '\n');
    const mod = await import(join(dir, 'link-audit-merge.mjs') + `?t=${Date.now()}`);
    const res = mod.run('hub');
    assert.equal(res.blinding, 'blinded');
    assert.equal(res.by_provenance.name.precision, 1);
    assert.equal(res.by_provenance.nonliteral.precision, 0);
  } finally { teardown(dir); }
});

test('(3) link-audit-merge refuses when neither a key file nor an in-row label is available', () => {
  const dir = sandbox('gr-pf-nokey-', ['link-audit-merge.mjs']);
  try {
    writeJsonl(join(dir, 'links', 'hub.links.judge.jsonl'), [{ jid: 'hub-L1', stratum: 'low', chunk_id: 'c1', entity_name: 'A', chunk_text: 'x', second_judge: false }]);
    writeJsonl(join(dir, 'links', 'hub.links.judge-A.jsonl'), [{ jid: 'hub-L1', mention: 1 }]);
    writeFileSync(join(dir, 'links', 'hub.links.prevalence.json'), JSON.stringify({ low: 1, mid: 0, high: 0 }) + '\n');
    const r = spawnSync(process.execPath, [join(dir, 'link-audit-merge.mjs'), 'hub'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /LINK_AUDIT_INPUT_MISSING/);
    assert.match(r.stderr, /key/);
  } finally { teardown(dir); }
});
