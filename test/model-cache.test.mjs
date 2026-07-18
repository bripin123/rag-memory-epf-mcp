// modelCache verification: version-independent cache path resolution, preflight,
// cross-process download lock/marker, stale-lock reclaim, marker atomicity.
// Spec §7, DoD 6. No network, no user cache — everything under tmpdir.
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { resolveModelCacheDir, preflightCacheDir, artifactKey, ModelDownloadLock, isCacheIntegrityError } from '../dist/src/modelCache.js';

// (a)-(c) resolution matrix
assert.equal(resolveModelCacheDir({ RAG_MEMORY_MODEL_CACHE_DIR: '/x' }, 'darwin', '/h'), '/x');
assert.equal(resolveModelCacheDir({ XDG_CACHE_HOME: '/xdg' }, 'linux', '/h'), join('/xdg', 'rag-memory-epf-mcp'));
assert.equal(resolveModelCacheDir({}, 'darwin', '/h'), join('/h', 'Library', 'Caches', 'rag-memory-epf-mcp'));
assert.equal(resolveModelCacheDir({}, 'linux', '/h'), join('/h', '.cache', 'rag-memory-epf-mcp'));
assert.equal(resolveModelCacheDir({ LOCALAPPDATA: '/la' }, 'win32', '/h'), join('/la', 'rag-memory-epf-mcp'));
console.log('  OK: cache dir resolution matrix');

// (d) preflight
const base = mkdtempSync(join(tmpdir(), 'rag-cache-'));
assert.equal(preflightCacheDir(join(base, 'ok')).ok, true);
const bad = preflightCacheDir('/dev/null/nope');
assert.equal(bad.ok, false);
assert.ok(bad.error, 'preflight failure must carry error text');
console.log('  OK: preflight mkdir + write probe');

// (e) two contenders: exactly one owner; waiter resolves ready after marker
const key = artifactKey('Xenova/bge-m3', 'main', 'fp16');
assert.equal(artifactKey('Xenova/bge-m3', 'main', 'fp16'), key, 'artifactKey not deterministic');
const cacheDir = join(base, 'ok');
const a = new ModelDownloadLock(cacheDir, key);
const b = new ModelDownloadLock(cacheDir, key);
const ra = a.acquireOrWait({ pollMs: 50, timeoutMs: 5000 });
const first = await ra;
assert.equal(first, 'owner');
const rb = b.acquireOrWait({ pollMs: 50, timeoutMs: 5000 });
a.markComplete();
a.release();
assert.equal(await rb, 'ready');
console.log('  OK: single owner + waiter sees completion marker');

// (f) stale lock from a dead pid is reclaimed
const c = new ModelDownloadLock(cacheDir, 'stale-' + key);
writeFileSync(c.lockPath, JSON.stringify({ pid: 999999, startedAt: 0 }));
assert.equal(await c.acquireOrWait({ pollMs: 50, timeoutMs: 5000 }), 'owner');
c.markComplete();
c.release();
console.log('  OK: stale lock reclaimed');

// (g) marker atomicity: no temp files left behind
assert.ok(!readdirSync(cacheDir).some(f => f.includes('.tmp')), 'marker temp file leaked');
console.log('  OK: marker temp-rename leaves no residue');

// (h) abort-first (beta 2R B5): an already-aborted waiter must never become an
// owner or report ready — even when the lock is free and a marker exists.
{
  const ac = new AbortController();
  ac.abort();
  const l = new ModelDownloadLock(cacheDir, 'abort-' + key); // key has a marker from (e)? no — distinct key, free lock
  const r = await l.acquireOrWait({ pollMs: 10, timeoutMs: 1000, signal: ac.signal }).catch(e => e);
  assert.ok(r instanceof Error && /abort/.test(r.message), `aborted waiter proceeded: ${r}`);
  const l2 = new ModelDownloadLock(cacheDir, key);           // this key DOES have a completion marker
  const r2 = await l2.acquireOrWait({ pollMs: 10, timeoutMs: 1000, signal: ac.signal }).catch(e => e);
  assert.ok(r2 instanceof Error && /abort/.test(r2.message), `aborted waiter returned ready despite abort: ${r2}`);
  console.log('  OK: abort checked before marker/acquire (beta 2R B5)');
}

// (i) error classification (beta 4R M1 -> 5R M2): only STRONG integrity
// signatures quarantine; generic words and out-of-cache ENOENT preserve.
{
  const CD = '/tmp/model-cache-x';
  for (const msg of ['invalid protobuf detected', 'Failed to deserialize model',
    'unexpected end of file', 'corrupt data detected', 'checksum mismatch', 'file truncated']) {
    assert.equal(isCacheIntegrityError(new Error(msg), CD), true, `integrity not detected: ${msg}`);
  }
  for (const msg of ['std::bad_alloc', 'out of memory', 'session allocation failed: OOM',
    'fetch failed', 'read ECONNRESET', 'some entirely unknown runtime condition',
    'invalid model architecture xyz',                       // config, not corruption (5R)
    'failed to parse proxy response',                       // generic parse (5R)
    'ENOENT: no such file /usr/lib/libonnxruntime.so']) {   // ENOENT outside the cache (5R)
    assert.equal(isCacheIntegrityError(new Error(msg), CD), false, `wrongly quarantines on: ${msg}`);
  }
  // ENOENT pointing INSIDE the cache dir IS integrity
  assert.equal(isCacheIntegrityError(new Error(`ENOENT: no such file ${CD}/Xenova/bge-m3/onnx/model_fp16.onnx`), CD), true);
  // precedence: a network error mentioning corruption-ish words still preserves
  assert.equal(isCacheIntegrityError(new Error('fetch failed: response truncated'), CD), false);
  console.log('  OK: cache error classification (strong signatures only, cache-scoped ENOENT)');
}

// (j) loader-failure policy by role (beta 5R M1): a ready-role reader may drop
// the marker but must NEVER touch shared cache files; only a locked owner
// quarantines.
{
  const { handleLoaderFailure } = await import('../dist/src/modelCache.js');
  const { mkdirSync, writeFileSync: wf, existsSync: ex, readdirSync: rd } = await import('node:fs');
  const pdir = mkdtempSync(join(tmpdir(), 'rag-policy-'));
  const modelDir = join(pdir, 'Org', 'model-x');
  mkdirSync(modelDir, { recursive: true });
  wf(join(modelDir, 'weights.onnx'), 'data');
  const plock = new ModelDownloadLock(pdir, 'pol');
  plock.markComplete();
  const integrity = new Error('invalid protobuf detected');

  // ready-role: marker gone, cache untouched
  let action = handleLoaderFailure({ role: 'ready', error: integrity, lock: plock, cacheDir: pdir, modelId: 'Org/model-x', terminal: false });
  assert.equal(action, 'marker-invalidated');
  assert.ok(ex(join(modelDir, 'weights.onnx')), 'ready-role deleted shared cache files!');
  assert.ok(!ex(plock.markerPath), 'ready-role left the marker');

  // owner-role: quarantined
  action = handleLoaderFailure({ role: 'owner', error: integrity, lock: plock, cacheDir: pdir, modelId: 'Org/model-x', terminal: false });
  assert.equal(action, 'quarantined');
  assert.ok(!ex(modelDir), 'owner quarantine left the dir in place');
  assert.ok(rd(join(pdir, 'Org')).some(f => f.startsWith('model-x.quarantine.')), 'quarantine dir missing');

  // non-integrity: nothing happens either role
  mkdirSync(modelDir, { recursive: true });
  action = handleLoaderFailure({ role: 'owner', error: new Error('out of memory'), lock: plock, cacheDir: pdir, modelId: 'Org/model-x', terminal: false });
  assert.equal(action, 'none');
  assert.ok(ex(modelDir), 'OOM owner failure touched the cache');
  // terminal config: nothing happens
  action = handleLoaderFailure({ role: 'owner', error: integrity, lock: plock, cacheDir: pdir, modelId: 'Org/model-x', terminal: true });
  assert.equal(action, 'none');
  rmSync(pdir, { recursive: true, force: true });
  console.log('  OK: loader-failure policy (reader never deletes, owner quarantines, OOM/terminal preserve)');
}

rmSync(base, { recursive: true, force: true });
console.log('MODEL-CACHE OK');
