// Write-sequence signal contract (hub session 251, 2026-11-02).
//
// The engine announces on stderr, one line per observation, that ITS OWN connection
// changed the database:   [rag-memory] write-seq <N>    (N strictly increasing from 1)
//
// Why: the launcher (scripts/mcp-proxy.cjs in the framework) records "the DB state this
// machine left" for the other machine to compare against. It used to record whenever the
// file changed and went quiet, which also fired when a cloud sync client swapped in the
// OTHER machine's file under an idle engine — a record that then refused a correct DB
// (measured 2026-11-02). Only the engine knows whether it wrote. Detection = SQLite
// total_changes() of the engine's own connection: rows changed by this connection,
// including vec0 shadow tables; reads and other connections do not move it
// (measured on better-sqlite3 + sqlite-vec 0.1.7).
//
// Cases: idle engine -> no new line · another connection writes -> no new line ·
// read tool -> no new line · write tool -> new line, N > previous ·
// write then SIGTERM at once -> a line is out before the process ends.
// Zero network (embeddings off), temp DB only.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');
const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SEQ_RE = /^\[rag-memory\] write-seq (\d+)$/gm;
// Engine tick is 1 s; give it two ticks plus slack before saying "no line came".
const QUIET_MS = 2600;

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
  child.stdin.on('error', () => {});
  st.exit = new Promise((res) => child.on('exit', (code, signal) => { st.exited = { code, signal }; res(st.exited); }));
  st.closed = new Promise((res) => child.on('close', res));   // stdio fully read (stderr end) — review r1 M5
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
  st.seqs = () => [...st.stderr.matchAll(SEQ_RE)].map(m => Number(m[1]));
  st.lastSeq = () => { const s = st.seqs(); return s.length ? s[s.length - 1] : 0; };
  return st;
}

async function handshake(st) {
  await st.waitFor(() => /shutdown handlers registered/.test(st.stderr), 20_000, 'handlers-ready marker');
  st.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'write-seq', version: '0' } } });
  await st.waitFor(() => st.responses.some(r => r.id === 1 && r.result), 15_000, 'initialize');
  st.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function call(st, id, name, args) {
  st.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  await st.waitFor(() => st.responses.some(r => r.id === id), 15_000, `${name} #${id}`);
  const r = st.responses.find(x => x.id === id);
  assert.ok(!r.error && r.result && !r.result.isError, `${name} failed: ${JSON.stringify(r).slice(0, 300)}`);   // review r1 should
}

function assertMonotonic(st, label) {
  const s = st.seqs();
  for (let i = 0; i < s.length; i++) assert.equal(s[i], i + 1, `[${label}] write-seq lines must be 1,2,3… — got ${JSON.stringify(s)}`);
}

const dir = mkdtempSync(join(tmpdir(), 'rag-writeseq-'));
const dbPath = join(dir, 't.db');
let st = null;
try {
  st = startEngine(dbPath);
  await handshake(st);
  await sleep(QUIET_MS);                       // startup writes (schema, meta) settle into their own line(s)
  const s0 = st.lastSeq();
  assert.ok(s0 > 0, `startup writes (schema · server_meta) were never announced: ${JSON.stringify(st.seqs())}`);

  await sleep(QUIET_MS);
  assert.equal(st.lastSeq(), s0, 'idle engine announced a write');
  console.log('  OK: idle -> no new write-seq line');

  const other = new Database(dbPath);
  other.exec("CREATE TABLE IF NOT EXISTS zz_other (x)"); other.exec("INSERT INTO zz_other VALUES (1)");
  other.close();
  await sleep(QUIET_MS);
  assert.equal(st.lastSeq(), s0, 'a write by ANOTHER connection was announced as this engine\'s write');
  console.log('  OK: other connection writes -> no new line');

  await call(st, 20, 'getKnowledgeGraphStats', {});
  await sleep(QUIET_MS);
  assert.equal(st.lastSeq(), s0, 'a read tool was announced as a write');
  console.log('  OK: read tool -> no new line');

  await call(st, 21, 'createEntities', { entities: [{ name: 'WS-1', entityType: 'TEST', observations: ['write-seq'] }] });
  await st.waitFor(() => st.lastSeq() > s0, QUIET_MS, 'write-seq after createEntities');
  console.log(`  OK: write tool -> write-seq ${st.lastSeq()} (> ${s0})`);
  assertMonotonic(st, 'live');

  if (!isWin) {
    const s1 = st.lastSeq();
    await call(st, 22, 'createEntities', { entities: [{ name: 'WS-2', entityType: 'TEST', observations: ['write-seq exit'] }] });
    st.child.kill('SIGTERM');                  // before the 1 s tick: the exit path must announce it
    const r = await Promise.race([st.exit, sleep(15_000).then(() => 'hang')]);
    if (r === 'hang') { st.child.kill('SIGKILL'); assert.fail('engine hung on SIGTERM'); }
    const closed = await Promise.race([st.closed.then(() => true), sleep(5_000).then(() => false)]);
    assert.ok(closed, 'stderr never ended after SIGTERM — cannot judge the last line');   // review r2: a timeout is a failure
    assert.ok(st.lastSeq() > s1, `write right before SIGTERM was never announced (last ${st.lastSeq()}, before ${s1})\nstderr tail: ${st.stderr.slice(-400)}`);
    assertMonotonic(st, 'exit');
    console.log(`  OK: write then SIGTERM -> write-seq ${st.lastSeq()} before exit`);
  } else {
    st.child.kill('SIGKILL'); await st.exit;
    console.log('  SKIPPED (not run, POSIX signal): write then SIGTERM');
  }
  console.log('WRITE-SEQ OK');
} finally {
  // review r1 M5: a failed assertion must not leave the engine running on a deleted folder
  let gone = !st || !!st.exited;
  if (!gone) { st.child.kill('SIGKILL'); gone = await Promise.race([st.exit.then(() => true), sleep(5_000).then(() => false)]); }
  if (gone) rmSync(dir, { recursive: true, force: true });
  else { console.error(`engine pid ${st.child.pid} did not exit; leaving ${dir} in place`); process.exitCode = 1; }   // review r2
}
