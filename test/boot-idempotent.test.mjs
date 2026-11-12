// Booting must leave an already-initialised database file byte-identical (IN-48, 2026-11-12).
//
// The framework launcher (scripts/mcp-proxy.cjs) compares the sha256 of the whole DB file with
// the record the OTHER machine left. An engine that changes the file just by starting makes a
// session that was only opened and closed look like a write: the other machine is then refused
// on every connect until a new record crosses over (measured 2026-11-12, five refusals in a row).
//
// What moved the file: ensureCurrentProfile() ran `INSERT OR IGNORE INTO embedding_profiles` on
// every boot. The table is `INTEGER PRIMARY KEY AUTOINCREMENT` + UNIQUE(...): SQLite reserves the
// next rowid in sqlite_sequence before the UNIQUE conflict makes it skip the row, and OR IGNORE
// keeps that bump. No row changes, so total_changes() — and the write-seq signal — never see it.
//
// Cases: fresh DB -> exactly one profile row (existing behaviour kept) ·
// boot again twice with no tool call -> same file sha256, same sqlite_sequence value ·
// control: a boot that DOES write through a tool -> the sha256 changes (the comparison is not vacuous).
// Zero network (embeddings off), temp DB only.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Engine tick is 1 s (noteWrites, idle checkpoint); stay up for more than one before leaving.
const UP_MS = 1500;

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

// One session as a client sees it: start, MCP handshake, optional tool calls, stdin EOF, exit 0.
async function session(dbPath, label, toolCalls = []) {
  const st = startEngine(dbPath);
  await st.waitFor(() => /shutdown handlers registered/.test(st.stderr), 20_000, `[${label}] handlers-ready marker`);
  st.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'boot-idempotent', version: '0' } } });
  await st.waitFor(() => st.responses.some(r => r.id === 1 && r.result), 15_000, `[${label}] initialize`);
  st.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  let id = 10;
  for (const [name, args] of toolCalls) {
    const callId = id++;
    st.send({ jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name, arguments: args } });
    await st.waitFor(() => st.responses.some(r => r.id === callId), 15_000, `[${label}] ${name}`);
    const r = st.responses.find(x => x.id === callId);
    assert.ok(!r.error && r.result && !r.result.isError, `[${label}] ${name} failed: ${JSON.stringify(r).slice(0, 300)}`);
  }
  await sleep(UP_MS);
  st.child.stdin.end();
  const timer = sleep(15_000).then(() => 'hang');
  const r = await Promise.race([st.exit, timer]);
  if (r === 'hang') { st.child.kill('SIGKILL'); assert.fail(`[${label}] engine did not exit on stdin EOF`); }
  assert.equal(st.exited.code, 0, `[${label}] exit code ${st.exited.code} (signal ${st.exited.signal})\n${st.stderr.slice(-500)}`);
}

// The state the launcher hashes: the main file alone. A -wal with frames would mean the main file
// is not the whole state, and comparing its hash would say nothing.
function fileState(dbPath, label) {
  const wal = dbPath + '-wal';
  const walBytes = existsSync(wal) ? statSync(wal).size : 0;
  assert.equal(walBytes, 0, `[${label}] -wal holds ${walBytes} bytes after a clean exit`);
  const sha = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
  const db = new Database(dbPath, { readonly: true });
  const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='embedding_profiles'").pluck().get();
  const rows = db.prepare('SELECT COUNT(*) FROM embedding_profiles').pluck().get();
  db.close();
  // The probe itself must not be what moves the file.
  const shaAfterProbe = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
  assert.equal(shaAfterProbe, sha, `[${label}] reading the DB read-only changed the file — the probe is broken`);
  return { sha, seq: Number(seq), rows: Number(rows) };
}

const dir = mkdtempSync(join(tmpdir(), 'rag-bootidem-'));
const dbPath = join(dir, 't.db');
try {
  await session(dbPath, 'first boot');
  const s1 = fileState(dbPath, 'first boot');
  assert.equal(s1.rows, 1, `a fresh DB must get exactly one profile row — got ${s1.rows}`);
  assert.equal(s1.seq, 1, `a fresh DB must end its first boot at sqlite_sequence 1 — got ${s1.seq}`);
  console.log('  OK: fresh DB -> one profile row, sequence 1');

  for (const label of ['second boot', 'third boot']) {
    await session(dbPath, label);
    const s = fileState(dbPath, label);
    assert.equal(s.rows, 1, `[${label}] profile rows ${s.rows}`);
    assert.equal(s.seq, s1.seq,
      `[${label}] sqlite_sequence for embedding_profiles moved ${s1.seq} -> ${s.seq} without a new row`);
    assert.equal(s.sha, s1.sha, `[${label}] the DB file changed although no tool was called`);
    console.log(`  OK: ${label}, no tool call -> same sha256, sequence still ${s.seq}`);
  }

  await session(dbPath, 'writing boot', [
    ['createEntities', { entities: [{ name: 'BI-1', entityType: 'TEST', observations: ['boot-idempotent control'] }] }],
  ]);
  const s4 = fileState(dbPath, 'writing boot');
  assert.notEqual(s4.sha, s1.sha, 'control: a session that wrote left the same sha256 — the comparison proves nothing');
  assert.equal(s4.seq, s1.seq, `control: a tool write moved the profile sequence ${s1.seq} -> ${s4.seq}`);
  console.log('  OK: control, a session that writes -> sha256 changes');

  console.log('boot-idempotent: PASS');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
