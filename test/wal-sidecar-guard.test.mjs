// WAL sidecar guard (specs/changes/wal-sidecar-guard): a sync client must not be able to swap
// the -wal out from under the engine, and if a sidecar at the path does change, the engine
// notices and reopens instead of failing every write with SQLITE_IOERR until restarted.
//
// What the live failure looked like (macOS + Google Drive, 2026-09-25): the engine's -wal
// descriptor pointed into FileProvider/…/wharf/delete/ while the path held a new inode.
// Here the swap is simulated the way the file system saw it: the open file is moved aside and
// a new empty file is put at the path.
// Zero network (no model), temp DB only. The IOERR used below is an Error with the code better-
// sqlite3 puts on SqliteError; isIoError() reads only the code, so no import is needed.
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, writeFileSync, copyFileSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { makeManager, assert } from './helpers/engine-test-db.mjs';

const ATTR = 'com.apple.fileprovider.ignore#P';
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const readAttr = (p) => {
  try { return execFileSync('/usr/bin/xattr', ['-p', ATTR, p], { encoding: 'utf8' }).trim(); }
  catch { return null; }
};
const ioErr = () => Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR_WRITE' });
const swap = (p) => { renameSync(p, p + '.gone-' + Date.now()); writeFileSync(p, ''); };
const resetStorm = (m) => { m.reopenTimes = []; m.walWatchPausedUntil = 0; };

const { manager, dbPath, dir, cleanup } = await makeManager();
try {
  const wal = dbPath + '-wal', shm = dbPath + '-shm';

  // 1) After initialize (which writes), both sidecars exist and — on macOS — are excluded.
  assert(existsSync(wal) && existsSync(shm), 'sidecars exist after initialize');
  if (isMac) {
    assert(readAttr(wal) === '1', `-wal carries ${ATTR} (got ${readAttr(wal)})`);
    assert(readAttr(shm) === '1', `-shm carries ${ATTR} (got ${readAttr(shm)})`);
  } else {
    console.log('  SKIPPED (not macOS): attribute assertions');
  }
  assert(manager.reopenCount === 0, 'no reopen before any swap');
  assert(manager.walTick() === false && manager.reopenCount === 0, 'tick with unchanged sidecars does not reopen');

  // 2) Swap the -wal: needs two consecutive ticks (a flicker is not a swap), then reopens.
  await manager.createEntities([{ name: 'before-swap', entityType: 'TEST', observations: ['a'] }]);
  const oldIno = statSync(wal, { bigint: true }).ino;
  swap(wal);
  assert(statSync(wal, { bigint: true }).ino !== oldIno, 'path now holds a different inode');
  assert(manager.walTick() === false && manager.reopenCount === 0, 'first mismatching tick waits');
  assert(manager.walTick() === true && manager.reopenCount === 1, 'second mismatching tick reopens');
  if (isMac) assert(readAttr(wal) === '1', 'the new -wal is marked after the reopen');

  // 3) The next write works and reaches the main file; the pre-swap write was salvaged.
  await manager.createEntities([{ name: 'after-swap', entityType: 'TEST', observations: ['b'] }]);
  manager.checkpointWal();
  const alone = join(dir, 'alone.db');
  copyFileSync(dbPath, alone);
  const ro = new Database(alone, { readonly: true });
  try {
    for (const n of ['before-swap', 'after-swap']) {
      const c = ro.prepare('SELECT COUNT(*) AS c FROM entities WHERE name = ?').get(n).c;
      assert(c === 1, `"${n}" is in the main file on its own`);
    }
  } finally { ro.close(); }

  // 4) A -shm swap is detected too.
  resetStorm(manager);
  swap(shm);
  manager.walTick();
  assert(manager.walTick() === true && manager.reopenCount === 2, 'a -shm swap reopens');

  // 5) A reopen waits for a running tool call, then happens at its end.
  resetStorm(manager);
  swap(wal);
  let during = null;
  await manager.runWithIoRecovery('readGraph', async () => {
    manager.walTick(); manager.walTick();
    during = manager.reopenCount;
  });
  assert(during === 2 && manager.reopenCount === 3, `reopen deferred during a call, done after it (during=${during}, after=${manager.reopenCount})`);

  // 6) runWithIoRecovery — the retry rules.
  resetStorm(manager);
  let calls = 0;
  const r1 = await manager.runWithIoRecovery('createEntities', async () => {
    calls++; if (calls === 1) throw ioErr(); return 'ok';
  });
  assert(r1 === 'ok' && calls === 2, `idempotent tool: one IOERR → reopen + one retry (calls=${calls})`);
  assert(manager.reopenCount === 4, 'the IOERR reopened the connection');

  for (const tool of ['syncDocumentFromFile', 'deleteObservations', 'deleteDocuments']) {
    resetStorm(manager);
    calls = 0; let got = null;
    try { await manager.runWithIoRecovery(tool, async () => { calls++; throw ioErr(); }); }
    catch (e) { got = e; }
    assert(got && got.code === 'SQLITE_IOERR_WRITE' && calls === 1, `${tool}: IOERR returned, not retried (calls=${calls})`);
  }
  const afterNonIdem = manager.reopenCount;
  assert(afterNonIdem === 7, `non-idempotent IOERRs still reopen (reopenCount=${afterNonIdem})`);

  calls = 0; let got = null;
  try { await manager.runWithIoRecovery('createEntities', async () => { calls++; throw new Error('boom'); }); }
  catch (e) { got = e; }
  assert(got && got.message === 'boom' && calls === 1 && manager.reopenCount === afterNonIdem,
    'a non-IO error is rethrown untouched, no reopen');

  // 7) Storm brake. An IOERR still reopens (a dead handle helps nobody) but is not retried;
  //    the inode watch is what the brake stops.
  let now = Date.now();
  manager.reopenTimes = [now, now, now];
  calls = 0; got = null;
  try { await manager.runWithIoRecovery('createEntities', async () => { calls++; throw ioErr(); }); }
  catch (e) { got = e; }
  assert(got && calls === 1 && manager.reopenCount === afterNonIdem + 1, `storm: IOERR reopens but no retry (calls=${calls})`);
  now = Date.now();
  manager.reopenTimes = [now, now, now];
  const before7 = manager.reopenCount;
  swap(wal);
  manager.walTick(); manager.walTick();
  assert(manager.reopenCount === before7 && manager.walWatchPausedUntil > Date.now(), 'storm: the watch does not reopen and pauses');
  manager.walTick(); manager.walTick();
  assert(manager.reopenCount === before7, 'paused watch does not reopen');
  resetStorm(manager);
  manager.walTick(); manager.walTick();
  assert(manager.reopenCount === before7 + 1, 'watch resumes after the pause');

  // 7b) One swap, several calls: a call whose handle was already replaced does not reopen again.
  resetStorm(manager);
  const before7b = manager.reopenCount;
  calls = 0;
  const r7b = await manager.runWithIoRecovery('readGraph', async () => {
    calls++;
    if (calls === 1) { manager.reopenDb('other-call', true); throw ioErr(); }
    return 'ok';
  });
  assert(r7b === 'ok' && calls === 2 && manager.reopenCount === before7b + 1, 'second caller reuses the new handle: one reopen, one retry');

  // 8) A checkpoint that fails with an I/O error reopens.
  resetStorm(manager);
  const before8 = manager.reopenCount;
  const realPragma = manager.db.pragma.bind(manager.db);
  const wrapped = manager.db;
  wrapped.pragma = (sql, o) => { if (/wal_checkpoint/.test(sql)) throw ioErr(); return realPragma(sql, o); };
  await manager.createEntities([{ name: 'ckpt', entityType: 'TEST', observations: ['c'] }]); // WAL has bytes
  manager.checkpointWal();
  assert(manager.reopenCount === before8 + 1 && manager.db !== wrapped, 'checkpoint IOERR → reopen with a new handle');

  // 9) Reopen failure: the engine stays up, retries with backoff, and recovers.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (!isWin && !isRoot) {
    resetStorm(manager);
    const before9 = manager.reopenCount;
    chmodSync(dir, 0o000);
    let ok9 = null;
    try { ok9 = manager.reopenDb('test-fail'); } finally { chmodSync(dir, 0o755); }
    assert(ok9 === false && manager.db === null && manager.dbDown?.tries === 1, 'failed reopen leaves db null and records dbDown');
    manager.dbDown.nextAt = 0;
    assert(manager.walTick() === true && manager.db !== null && manager.dbDown === null, 'next tick retries and recovers');
    assert(manager.reopenCount === before9 + 1, 'the recovery counts as one reopen');

    // 9b) The last failed try hands over to the full shutdown (onFatal), not a live dead server.
    resetStorm(manager);
    let fatal = 0;
    manager.onFatal = () => { fatal++; };
    chmodSync(dir, 0o000);
    try {
      manager.reopenDb('test-fail-2');                 // try 1
      manager.dbDown.tries = 9; manager.dbDown.nextAt = 0;
      manager.walTick();                               // try 10 → fatal
    } finally { chmodSync(dir, 0o755); }
    assert(fatal === 1 && process.exitCode === 1, `10th failed reopen calls onFatal once (fatal=${fatal})`);
    process.exitCode = 0;
    manager.onFatal = null;
    manager.dbDown.tries = 0; manager.dbDown.nextAt = 0;
    assert(manager.walTick() === true && manager.db !== null, 'recovers once the path is readable again');
  } else {
    console.log('  SKIPPED (Windows or root): chmod-based reopen failure');
  }

  // 9c) A reconciliation cut by a reconnect reruns by itself and completes.
  {
    const c = manager.coordinator;
    let nulls = 1, entityRuns = 0, first = true;
    const saved = { sanitize: c.sanitize, count: c.countNullWithVector, ents: c.reconcileEntities,
                    chunks: c.reconcileChunks, kick: c.kick, mode: c.deps.mode };
    c.sanitize = async () => 0;
    c.countNullWithVector = () => nulls;
    c.reconcileEntities = async () => {
      entityRuns++;
      if (first) { first = false; throw new TypeError('The database connection is not open'); }
      nulls = 0;
    };
    c.reconcileChunks = async () => {};
    c.kick = () => {};
    c.deps.mode = () => 'lazy';
    c.recon = 'pending'; c.reconPromise = null;
    await c.runReconciliation();
    for (let i = 0; i < 50 && c.reconState !== 'complete'; i++) await new Promise(r => setTimeout(r, 10));
    assert(c.reconState === 'complete' && entityRuns === 2, `reconciliation reruns after a reconnect (state=${c.reconState}, runs=${entityRuns})`);
    Object.assign(c, { sanitize: saved.sanitize, countNullWithVector: saved.count, reconcileEntities: saved.ents,
                       reconcileChunks: saved.chunks, kick: saved.kick });
    c.deps.mode = saved.mode;
  }

  // 10) No reopen while shutting down.
  resetStorm(manager);
  manager.shuttingDown = true;
  const before10 = manager.reopenCount;
  swap(wal);
  manager.walTick(); manager.walTick();
  assert(manager.reopenDb('late') === false && manager.reopenCount === before10, 'no reopen once shutting down');

  console.log('wal-sidecar-guard: ALL PASS');
} finally {
  cleanup();
}
