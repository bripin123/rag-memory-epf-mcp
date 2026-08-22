// Makes .backup copies of the three corpora into eval/graph-role/dbs/ and records snapshot.json.
// Uses the sqlite3 CLI's `.backup` (Online Backup API; WAL-safe).
//
// Open mode (review finding, 2026-08-22): the previous header claimed this "never opens the live DB
// for writing" while invoking sqlite3 with no -readonly, which does open read-write. Measured, that
// creates -wal/-shm next to the user's live database -- observed for real on the hal corpus while
// this repair was being written. The live DB's own mtime never moved (the guard below held), but
// writing anything into a cloud-synced .memory/ directory is exactly what the guard was meant to
// prevent.
//
// -readonly is not a drop-in, which is why the fallback below exists rather than a flat flag:
// on a WAL database whose -shm is absent, SQLite cannot create the shared-memory file and refuses
// to open at all ("unable to open database file"). Both facts are pinned as executable controls in
// test/eval-graph-role-prereq-fix.test.mjs. `file:...?immutable=1` does open such a database, but it
// asserts the file cannot change while it is read -- on a live DB that trades a visible side effect
// for a silent wrong-answer risk, so it is deliberately not used.
//
// So: read-only whenever a -shm is present (the normal case -- a server or another reader has the
// DB open), read-write otherwise, and either way the chosen mode and any side files the backup
// created are written into snapshot.json. A read-only backup that somehow creates a side file is an
// anomaly and exits 11; a read-write fallback that creates them is expected and merely recorded.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPORA, EVAL_DIR, REPO_ROOT } from './lib/paths.mjs';
import { sha256File } from './lib/freeze.mjs';

const SIDE_SUFFIXES = ['-wal', '-shm'];

// A WAL database can only be opened read-only when its -shm already exists; see the header.
export const chooseOpenMode = ({ shmPresent }) => (shmPresent ? 'read-only' : 'read-write');

export const sqliteArgs = (live, copy, mode) =>
  mode === 'read-only' ? ['-readonly', live, `.backup '${copy}'`] : [live, `.backup '${copy}'`];

const sideFilesPresent = (live) => SIDE_SUFFIXES.filter((s) => existsSync(live + s));

// One corpus, with the guards that make "this did not disturb the source" checkable rather than
// asserted. `exec` is injectable so the decision logic can be exercised without a real sqlite3.
export function backupCorpus(c, { exec = execFileSync } = {}) {
  const sideBefore = sideFilesPresent(c.live);
  const before = statSync(c.live).mtimeMs;
  let mode = chooseOpenMode({ shmPresent: existsSync(c.live + '-shm') });
  let ro_error = null;
  try {
    exec('sqlite3', sqliteArgs(c.live, c.copy, mode));
  } catch (e) {
    if (mode !== 'read-only') throw e;
    // A -shm existed but the read-only open still failed (stale/unreadable shm, permissions).
    // Say so loudly and fall back rather than aborting the whole snapshot run.
    ro_error = e instanceof Error ? e.message : String(e);
    console.error(`SNAPSHOT_RO_FAILED ${c.label} falling back to read-write: ${ro_error}`);
    mode = 'read-write';
    exec('sqlite3', sqliteArgs(c.live, c.copy, mode));
  }
  const after = statSync(c.live).mtimeMs;
  if (before !== after) { console.error(`SOURCE_MTIME_CHANGED ${c.label}`); process.exit(10); }
  const side_files_created = sideFilesPresent(c.live).filter((s) => !sideBefore.includes(s));
  if (side_files_created.length) {
    if (mode === 'read-only') {
      console.error(`SOURCE_SIDEFILE_CREATED ${c.label} ${side_files_created.join(',')} (read-only backup must not write beside the source)`);
      process.exit(11);
    }
    console.error(`SOURCE_SIDEFILE_CREATED ${c.label} ${side_files_created.join(',')} (read-write fallback: no -shm was present, recorded in snapshot.json)`);
  }
  return { source: c.live, copy: c.copy, bytes: statSync(c.copy).size, sha256: sha256File(c.copy), open_mode: mode, side_files_created, ro_error };
}

export function run() {
  mkdirSync(join(EVAL_DIR, 'dbs'), { recursive: true });
  const engineCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim();
  const snap = { taken_at: new Date().toISOString(), engine_commit: engineCommit, corpora: {} };
  for (const c of Object.values(CORPORA)) {
    snap.corpora[c.label] = backupCorpus(c);
    const r = snap.corpora[c.label];
    console.log(`${c.label}: ${r.bytes} bytes sha256=${r.sha256.slice(0, 12)} open_mode=${r.open_mode}`);
  }
  writeFileSync(join(EVAL_DIR, 'snapshot.json'), JSON.stringify(snap, null, 2) + '\n');
  return snap;
}

// CLI guard (review finding, 2026-08-22): without it, merely importing this module -- a test, a
// tool that wants chooseOpenMode -- re-snapshots all three live corpora and overwrites dbs/. That
// is not hypothetical; it happened while these repairs were being written and destroyed Stage 1's
// corpus copies (dbs/ is gitignored). Every other script here already has this guard.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) run();
