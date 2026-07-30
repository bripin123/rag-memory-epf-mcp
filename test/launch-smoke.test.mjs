// Launch smoke (v3.6): the built entry must complete a REAL MCP stdio
// handshake (initialize + tools/list) within the timeout while the model is
// completely unavailable, then shut down gracefully on SIGTERM via the
// NATURAL-exit path (the load settles as 'failed' fast here; the spec §3
// bounded-exit exception is covered separately in bounded-exit.test.mjs).
// Spec §3·§10, DoD 1/10/19.
// Pre-3.6 this test only watched for the first boot log line — it passed even
// when server.connect() was broken. It also still covers the v3.5.0 entry-point
// regression (direct launch must boot main(), as npx/bin does).
import { spawn } from 'node:child_process';
// 버전을 정규식으로 박아 두면 minor 마다 손으로 고쳐야 하고, 고치는 것을 잊으면
// 무관한 실패가 난다(실제로 3.7.0 에서 났다). 계약은 "서버가 *이 패키지의* 버전을
// 자기보고한다"이지 특정 문자열이 아니다 — package.json 을 정본으로 읽는다.
import { readFileSync } from 'node:fs';
const PKG_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');
const dir = mkdtempSync(join(tmpdir(), 'ragmem-launch-'));

const env = { ...process.env };
delete env.RAG_MEMORY_NO_AUTOSTART;                    // ensure autostart runs
const child = spawn(process.execPath, [entry], {
  env: {
    ...env,
    DB_FILE_PATH: join(dir, 't.db'),
    // Unwritable cache dir: the loader's preflight throws BEFORE any network
    // request, so the lazy path is exercised with ZERO downloads (DoD 8) and
    // the gate lands in 'failed' deterministically.
    RAG_MEMORY_MODEL_CACHE_DIR: '/dev/null/rag-smoke-nope',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderrBuf = '';
child.stderr.on('data', d => { stderrBuf += d.toString(); });

const responses = [];
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { try { responses.push(JSON.parse(line)); } catch { /* non-JSON noise */ } }
  }
});
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const waitFor = (pred, ms, what) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (pred()) { clearInterval(iv); res(); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for ${what}\nstderr tail: ${stderrBuf.slice(-500)}`)); }
  }, 50);
});

// 1) MCP initialize handshake
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
await waitFor(() => responses.some(r => r.id === 1 && r.result?.serverInfo), 15_000, 'initialize response');
const init = responses.find(r => r.id === 1);
assert.equal(init.result.serverInfo.version, PKG_VERSION,
  `serverInfo must self-report the package version (${PKG_VERSION})`);
console.log('  OK: MCP initialize handshake (lazy boot, model unavailable)');

// 2) tools/list
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
await waitFor(() => responses.some(r => r.id === 2 && Array.isArray(r.result?.tools) && r.result.tools.length >= 30), 10_000, 'tools/list');
console.log('  OK: tools/list served (>=30 tools) before any model load');

// 3) generic tool error carries isError (v3.6 handler contract)
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'embedChunks', arguments: { documentId: 'no-such-doc' } } });
await waitFor(() => responses.some(r => r.id === 3), 10_000, 'embedChunks error response');
const errResp = responses.find(r => r.id === 3);
assert.equal(errResp.result?.isError, true, `tool error missing isError: ${JSON.stringify(errResp.result).slice(0, 200)}`);
console.log('  OK: tool errors set isError=true');

// 4) startup banner self-report on stderr
assert.ok(stderrBuf.includes(`rag-memory-epf-mcp v${PKG_VERSION} | node v`),
  `startup banner missing or wrong version (expected v${PKG_VERSION})\nstderr: ${stderrBuf.slice(0, 300)}`);
console.log('  OK: startup banner self-report');

// 5) graceful SIGTERM: natural exit, no hang
child.kill('SIGTERM');
const code = await new Promise((res) => {
  const t = setTimeout(() => res('hang'), 8000);
  child.on('exit', (c) => { clearTimeout(t); res(c); });
});
assert.notEqual(code, 'hang', 'process hung after SIGTERM (shutdown contract)');
console.log(`  OK: graceful SIGTERM exit (code=${code})`);

rmSync(dir, { recursive: true, force: true });
console.log('LAUNCH OK');
