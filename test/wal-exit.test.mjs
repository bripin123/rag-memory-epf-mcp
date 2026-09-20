// WAL-at-exit contract: however the engine process ends, a write that was
// acknowledged must already be in the MAIN database file, and the `-wal` file
// must hold no frames (absent or 0 bytes).
//
// Why this is a contract and not hygiene: the database lives in a cloud-synced
// folder shared by two machines. A `-wal` with frames that outlives its process
// is replayed at the next open against whatever main file is there by then —
// SQLite does not check that the WAL belongs to that main file. That corrupted
// a live database twice (WAL 2026-09-17, main file 2026-09-19).
//
// Exit paths, each measured rather than assumed:
//   sigterm      graceful handler path
//   sighup       terminal/pane closed (POSIX). Had no handler: default signal death.
//   codex        what codex-cli 0.155.1 does on /quit and Ctrl+C, measured with a
//                signal-recording stand-in server: SIGTERM + stdin EOF, then
//                SIGKILL ~185 ms later. The shutdown sequence does not get to finish.
//   hardkill     no warning at all (SIGKILL; on Windows child.kill() is
//                TerminateProcess, so this is also "how Windows ends a child").
//                Nothing can run at exit, so the only defence is that the WAL was
//                already empty: the idle checkpoint.
//   not-last     a second engine keeps the same file open. SQLite only folds the WAL
//                on the LAST connection's close, so a clean exit of one engine among
//                several used to leave every frame behind.
// Zero network (embeddings off), temp DB only.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');
const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Upper bound the engine promises for "WAL folded after the last write" while idle.
const IDLE_CHECKPOINT_BOUND_MS = 1500;
// Measured codex grace between SIGTERM and SIGKILL was ~185 ms; test tighter than that.
const CODEX_GRACE_MS = 150;

function startEngine(dbPath) {
  const env = { ...process.env };
  delete env.RAG_MEMORY_NO_AUTOSTART;
  const child = spawn(process.execPath, [entry], {
    env: { ...env, DB_FILE_PATH: dbPath, RAG_MEMORY_EMBEDDINGS: 'off' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const st = { child, stderr: '', responses: [], exited: null };
  child.stderr.on('data', d => { st.stderr += d.toString(); });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) { try { st.responses.push(JSON.parse(line)); } catch { /* noise */ } }
    }
  });
  child.stdin.on('error', () => { /* child may die with stdin open */ });
  st.exit = new Promise((res) => child.on('exit', (code, signal) => { st.exited = { code, signal }; res(st.exited); }));
  st.send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  st.waitFor = (pred, ms, what) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); res(); }
      else if (st.exited || Date.now() - t0 > ms) {
        clearInterval(iv); child.kill('SIGKILL');
        rej(new Error(`timeout/exit waiting for ${what}\nstderr tail: ${st.stderr.slice(-500)}`));
      }
    }, 20);
  });
  return st;
}

async function handshake(st) {
  await st.waitFor(() => /shutdown handlers registered/.test(st.stderr), 20_000, 'handlers-ready marker');
  st.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wal-exit', version: '0' } } });
  await st.waitFor(() => st.responses.some(r => r.id === 1 && r.result), 15_000, 'initialize');
  st.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function writeEntity(st, name, id) {
  st.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'createEntities', arguments: {
    entities: [{ name, entityType: 'TEST', observations: [`written by wal-exit ${name}`] }] } } });
  await st.waitFor(() => st.responses.some(r => r.id === id), 15_000, `createEntities ${name}`);
  const r = st.responses.find(x => x.id === id);
  assert.ok(!r.result?.isError, `createEntities failed: ${JSON.stringify(r).slice(0, 300)}`);
}

// The two assertions of the contract. Reads the main file ALONE (copied without
// its sidecars), which is exactly what the other machine receives.
function assertFolded(label, dir, dbPath, names) {
  const wal = dbPath + '-wal';
  const walBytes = existsSync(wal) ? statSync(wal).size : 0;
  assert.equal(walBytes, 0, `[${label}] -wal still holds ${walBytes} bytes of frames after exit`);
  const alone = join(dir, 'alone'); mkdirSync(alone, { recursive: true });
  const copy = join(alone, `${label}.db`);
  copyFileSync(dbPath, copy);
  const db = new Database(copy, { readonly: true });
  try {
    for (const n of names) {
      const row = db.prepare('SELECT COUNT(*) AS c FROM entities WHERE name = ?').get(n);
      assert.equal(row.c, 1, `[${label}] "${n}" is not in the main file on its own — it only existed in the WAL`);
    }
  } finally { db.close(); }
}

const waitExit = async (st, ms, label) => {
  const r = await Promise.race([st.exit, sleep(ms).then(() => 'hang')]);
  if (r === 'hang') { st.child.kill('SIGKILL'); assert.fail(`[${label}] engine hung`); }
  return r;
};

const paths = [
  { name: 'sigterm', posixOnly: true, async end(st) { st.child.kill('SIGTERM'); const r = await waitExit(st, 15_000, 'sigterm');
      assert.equal(r.signal, null, `default signal death (${r.signal}) — handler never ran`); } },
  { name: 'sighup', posixOnly: true, async end(st) { st.child.kill('SIGHUP'); const r = await waitExit(st, 15_000, 'sighup');
      assert.equal(r.signal, null, `default signal death (${r.signal}) — SIGHUP has no handler`); } },
  { name: 'codex', posixOnly: true, async end(st) {
      st.child.kill('SIGTERM'); st.child.stdin.end();
      await sleep(CODEX_GRACE_MS); st.child.kill('SIGKILL'); await waitExit(st, 5_000, 'codex'); } },
  { name: 'hardkill', posixOnly: false, async end(st) {
      await sleep(IDLE_CHECKPOINT_BOUND_MS); st.child.kill('SIGKILL'); await waitExit(st, 5_000, 'hardkill'); } },
];

// WAL_EXIT_ONLY=<name> runs one path (used to take a per-path baseline).
const only = process.env.WAL_EXIT_ONLY;
let ran = 0, skipped = 0;
for (const p of paths) {
  if (only && only !== p.name) continue;
  if (p.posixOnly && isWin) { console.log(`  SKIPPED (not run, POSIX signal): ${p.name}`); skipped++; continue; }
  const dir = mkdtempSync(join(tmpdir(), `rag-walexit-${p.name}-`));
  const dbPath = join(dir, 't.db');
  const st = startEngine(dbPath);
  await handshake(st);
  await writeEntity(st, `E-${p.name}`, 10);
  await p.end(st);
  assertFolded(p.name, dir, dbPath, [`E-${p.name}`]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`  OK: ${p.name} -> main file alone has the write, -wal empty`);
  ran++;
}

// not-last: engine B stays attached while engine A writes and leaves.
if (!only || only === 'not-last') {
  const dir = mkdtempSync(join(tmpdir(), 'rag-walexit-notlast-'));
  const dbPath = join(dir, 't.db');
  const b = startEngine(dbPath); await handshake(b);
  const a = startEngine(dbPath); await handshake(a);
  await writeEntity(a, 'E-notlast', 10);
  if (isWin) { await sleep(IDLE_CHECKPOINT_BOUND_MS); a.child.kill('SIGKILL'); }
  else a.child.kill('SIGTERM');
  await waitExit(a, 15_000, 'not-last');
  assertFolded('not-last', dir, dbPath, ['E-notlast']);   // B is still running here
  b.child.kill('SIGKILL'); await waitExit(b, 5_000, 'not-last B');
  rmSync(dir, { recursive: true, force: true });
  console.log('  OK: not-last -> leaving engine folds the WAL although another engine holds the file');
  ran++;
}

console.log(`WAL-EXIT OK (${ran} paths run, ${skipped} skipped on ${process.platform})`);
