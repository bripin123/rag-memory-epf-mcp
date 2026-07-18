// Shutdown contract verification (spec §3, beta-2R-amended exception; 3R M2):
//   (1) SIGTERM while the loader waits on a HELD download lock: the gate's
//       abort settles the load as 'failed' -> NATURAL exit (no process.exit).
//   (2) A truly never-settling load (un-abortable fetch stand-in): bounded
//       process.exit AFTER DB close — the documented spec exception.
// Zero network, temp DB + temp cache only.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { ModelDownloadLock, artifactKey, preflightCacheDir } from '../dist/src/modelCache.js';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');

// ---- (1) abort chain: SIGTERM during lock wait -> failed -> natural exit ---
{
  const dir = mkdtempSync(join(tmpdir(), 'rag-bexit1-'));
  const cacheDir = join(dir, 'cache');
  preflightCacheDir(cacheDir);
  // Hold the lock for the custom model this child will use (revision 'main').
  const key = artifactKey('test/never-model', 'main', 'fp16');
  const holder = new ModelDownloadLock(cacheDir, key);
  assert.equal(await holder.acquireOrWait({ pollMs: 10, timeoutMs: 1000 }), 'owner');

  const env = { ...process.env };
  delete env.RAG_MEMORY_NO_AUTOSTART;
  const child = spawn(process.execPath, [entry], {
    env: { ...env, DB_FILE_PATH: join(dir, 't.db'), RAG_MEMORY_MODEL_CACHE_DIR: cacheDir,
      EMBEDDING_MODEL: 'test/never-model' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderrBuf = '';
  child.stderr.on('data', d => { stderrBuf += d.toString(); });
  // (beta 4R M3 + 5R residual) Wait for BOTH explicit markers — shutdown
  // handlers registered AND the loader inside the held-lock wait — so SIGTERM
  // can never race handler registration (default signal death faking a pass)
  // and the lock-wait state is proven, not assumed via sleep.
  const waitMarker = (re, what) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (re.test(stderrBuf)) { clearInterval(iv); res(); }
      else if (Date.now() - t0 > 15000) { clearInterval(iv); child.kill('SIGKILL'); rej(new Error(`marker "${what}" never appeared\n${stderrBuf.slice(-400)}`)); }
    }, 50);
  });
  await waitMarker(/shutdown handlers registered/, 'handlers-ready');
  await waitMarker(/acquiring model download lock/, 'lock-wait entered');
  child.kill('SIGTERM');
  const { code, signal } = await new Promise((res) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); res({ code: 'hang', signal: null }); }, 8000);
    child.on('exit', (c, s) => { clearTimeout(t); res({ code: c, signal: s }); });
  });
  holder.release();
  assert.notEqual(code, 'hang', `lock-waiting server hung on SIGTERM\nstderr: ${stderrBuf.slice(-400)}`);
  assert.equal(signal, null, `terminated by default signal death (signal=${signal}) — handler never ran`);
  assert.equal(code, 0, `natural exit expected code 0, got ${code}`);
  assert.ok(!/bounded exit/.test(stderrBuf), 'abortable lock wait must exit NATURALLY, not via the bounded branch');
  console.log('  OK: SIGTERM during lock wait -> abort -> natural exit (code 0, no signal death)');
  rmSync(dir, { recursive: true, force: true });
}

// ---- (2) never-settling load -> bounded exit after DB close ----------------
{
  const child = spawn(process.execPath, [join(here, 'fixtures', 'bounded-exit-child.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrBuf = '';
  child.stderr.on('data', d => { stderrBuf += d.toString(); });
  const code = await new Promise((res) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); res('hang'); }, 15000);
    child.on('exit', c => { clearTimeout(t); res(c); });
  });
  assert.notEqual(code, 'hang', `never-settling load did not bounded-exit\nstderr: ${stderrBuf.slice(-400)}`);
  assert.equal(code, 0, `bounded exit code ${code} != 0`);
  assert.ok(/bounded exit/.test(stderrBuf), 'bounded-exit marker missing from stderr');
  assert.ok(!/STILL ALIVE/.test(stderrBuf), 'code after shutdownAll executed — exit was not bounded');
  console.log('  OK: never-settling load -> bounded exit after DB close (spec §3 exception)');
}

console.log('BOUNDED-EXIT OK');
