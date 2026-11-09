// On-demand embedding model (IN-46): the model is not in memory until something needs it, every
// caller that needs it waits for it, and it leaves memory after an idle period. Falling back to
// FTS is only for "the files are not on this machine yet" and "loading really failed".
// Fake loaders only — no model, no network.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { makeManager } from './helpers/engine-test-db.mjs';

const { manager: mgr, dir } = await makeManager();
const { EmbeddingGate, GateNotReadyError } = await import('../dist/src/embeddingGate.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const vecOf = (text) => {
  const v = new Float32Array(1024);
  for (let i = 0; i < text.length; i++) v[i % 1024] += text.charCodeAt(i) / 1000;
  v[0] += 0.01;
  return v;
};
function fakeLoader(extra = {}) {
  const c = { loads: 0, disposes: 0, inferences: 0 };
  const loadModel = async () => {
    c.loads++;
    if (extra.beforeLoad) await extra.beforeLoad();
    const fn = async (text) => {
      c.inferences++;
      if (extra.inferMs) await sleep(extra.inferMs);
      return vecOf(text);
    };
    fn.dispose = async () => { c.disposes++; if (extra.onDispose) await extra.onDispose(); };
    return fn;
  };
  return { c, loadModel };
}
const P = { priority: 'interactive' };

// ---- Gate ---------------------------------------------------------------------------------

{ // an idle gate loads and answers instead of rejecting
  const { c, loadModel } = fakeLoader();
  const g = new EmbeddingGate({ mode: 'lazy', loadModel });
  assert.equal(g.status.state, 'idle');
  const v = await g.embed('hello', P);
  assert.ok(v instanceof Float32Array && v.length === 1024, 'embed did not return a vector');
  assert.equal(c.loads, 1);
  assert.equal(g.status.state, 'ready');
  await g.shutdown();
  console.log('  OK: embed on an idle gate waits for the load and returns a vector');
}

{ // concurrent callers share one load
  let open; const gateOpen = new Promise(r => { open = r; });
  const { c, loadModel } = fakeLoader({ beforeLoad: () => gateOpen });
  const g = new EmbeddingGate({ mode: 'lazy', loadModel });
  const all = Promise.all([g.embed('a', P), g.embed('b', P), g.embed('c', P)]);
  let settled = false; all.then(() => { settled = true; });
  await sleep(30);
  assert.equal(settled, false, 'callers finished before the model was loaded');
  open();
  const rs = await all;
  assert.equal(rs.length, 3);
  assert.equal(c.loads, 1, 'single-flight violated');
  await g.shutdown();
  console.log('  OK: concurrent callers wait on a single load');
}

{ // leaves memory after the idle period and comes back on demand
  const { c, loadModel } = fakeLoader();
  const g = new EmbeddingGate({ mode: 'lazy', loadModel, idleMs: 30 });
  await g.embed('a', P);
  assert.equal(g.status.state, 'ready');
  await sleep(90);
  assert.equal(g.status.state, 'idle', 'model stayed loaded past the idle period');
  assert.equal(c.disposes, 1, 'dispose not called exactly once');
  assert.equal(g.status.readySince, undefined, 'readySince kept after unload');
  await g.embed('b', P);
  assert.equal(c.loads, 2, 'second use did not reload');
  assert.equal(g.status.state, 'ready');
  await g.shutdown();
  console.log('  OK: idle unload disposes once; the next use reloads');
}

{ // activity keeps it loaded; a running inference is never unloaded
  const { c, loadModel } = fakeLoader({ inferMs: 90 });
  const g = new EmbeddingGate({ mode: 'lazy', loadModel, idleMs: 25 });
  await g.embed('a', P);                     // idle timer armed only after this completes
  const running = g.embed('b', P);           // inference longer than idleMs
  await sleep(50);
  assert.equal(c.disposes, 0, 'unloaded during a running inference');
  assert.equal(g.status.state, 'ready');
  await running;
  await sleep(70);
  assert.equal(c.disposes, 1, 'not unloaded after the inference finished');
  await g.shutdown();
  console.log('  OK: no unload while inference runs; idle clock starts after it ends');
}

{ // a request during dispose waits for dispose, then loads (never two models at once)
  const order = [];
  let finishDispose; const blocked = new Promise(r => { finishDispose = r; });
  let loads = 0;
  const g = new EmbeddingGate({ mode: 'lazy', idleMs: 10, loadModel: async () => {
    order.push(`load${++loads}`);
    const fn = async (t) => vecOf(t);
    fn.dispose = async () => { order.push('dispose-start'); await blocked; order.push('dispose-end'); };
    return fn;
  } });
  await g.embed('a', P);
  await sleep(40);
  assert.deepEqual(order, ['load1', 'dispose-start']);
  const p = g.embed('b', P);
  await sleep(20);
  assert.deepEqual(order, ['load1', 'dispose-start'], 'loaded while the old model was still being disposed');
  finishDispose();
  await p;
  assert.deepEqual(order, ['load1', 'dispose-start', 'dispose-end', 'load2']);
  await g.shutdown();
  console.log('  OK: load after unload waits for dispose to finish');
}

{ // files not on this machine: answer at once, fetch in the background
  let open; const gateOpen = new Promise(r => { open = r; });
  const { c, loadModel } = fakeLoader({ beforeLoad: () => gateOpen });
  const g = new EmbeddingGate({ mode: 'lazy', loadModel, isModelCached: () => false });
  const t0 = Date.now();
  const e = await g.embed('a', P).catch(x => x);
  assert.ok(e instanceof GateNotReadyError, 'uncached embed must reject not-ready');
  assert.ok(Date.now() - t0 < 200, 'uncached embed waited for the download');
  assert.equal(c.loads, 1, 'background fetch not started');
  const e2 = await g.embed('b', P).catch(x => x);
  assert.equal(e2.code, 'MODEL_NOT_READY');
  assert.equal(c.loads, 1, 'second request started a second fetch');
  open();
  await g.start();
  assert.equal(g.status.state, 'ready');
  await g.shutdown();
  console.log('  OK: missing model files -> immediate not-ready + one background fetch');
}

{ // downloading state rejects even if the marker appears mid-way
  let open; const gateOpen = new Promise(r => { open = r; });
  let cached = false;
  const { loadModel } = fakeLoader({ beforeLoad: () => gateOpen });
  const g = new EmbeddingGate({ mode: 'lazy', loadModel, isModelCached: () => cached });
  void g.start();
  await sleep(5);
  g.markDownloading();
  cached = true;
  const e = await g.embed('x', P).catch(x => x);
  assert.equal(e.code, 'MODEL_NOT_READY');
  assert.equal(e.state, 'downloading');
  open(); await g.start(); await g.shutdown();
  console.log('  OK: downloading state rejects');
}

{ // a real load failure is reported, not hidden
  let attempts = 0;
  const g = new EmbeddingGate({ mode: 'lazy', backoffMs: [60_000], loadModel: async () => { attempts++; throw new Error('corrupt'); } });
  const e = await g.embed('x', P).catch(x => x);
  assert.equal(e.code, 'MODEL_NOT_READY');
  assert.equal(g.status.state, 'failed');
  assert.ok(g.status.lastError?.includes('corrupt'));
  const e2 = await g.embed('y', P).catch(x => x);
  assert.equal(e2.code, 'MODEL_NOT_READY');
  assert.equal(attempts, 1, 'a request bypassed the retry backoff');
  await g.shutdown();
  console.log('  OK: load failure -> not-ready + failed state');
}

{ // the caller's wait is bounded; the load itself carries on
  let open; const gateOpen = new Promise(r => { open = r; });
  const { c, loadModel } = fakeLoader({ beforeLoad: () => gateOpen });
  const g = new EmbeddingGate({ mode: 'lazy', loadModel, loadWaitMs: 30 });
  const e = await g.embed('x', P).catch(x => x);
  assert.equal(e.code, 'MODEL_NOT_READY', 'bounded wait must reject not-ready');
  open();
  await g.start();
  assert.equal(c.loads, 1, 'wait timeout started a second load');
  assert.equal(g.status.state, 'ready');
  await g.shutdown();
  console.log('  OK: bounded wait; the load continues');
}

{ // shutdown cancels the idle timer
  const { c, loadModel } = fakeLoader();
  const g = new EmbeddingGate({ mode: 'lazy', loadModel, idleMs: 25 });
  await g.embed('a', P);
  await g.shutdown();
  await sleep(60);
  assert.equal(c.disposes, 0, 'idle timer fired after shutdown');
  console.log('  OK: shutdown clears the idle timer');
}

{ // eager and idleMs 0 stay resident
  for (const [mode, idleMs, label] of [['eager', 20, 'eager'], ['lazy', 0, 'idleMs 0']]) {
    const { c, loadModel } = fakeLoader();
    const g = new EmbeddingGate({ mode, loadModel, idleMs });
    await g.embed('a', P);
    await sleep(60);
    assert.equal(g.status.state, 'ready', `${label} unloaded`);
    assert.equal(c.disposes, 0, `${label} disposed`);
    await g.shutdown();
  }
  console.log('  OK: eager and idleMs=0 never unload');
}

{ // ensureReady
  const a = fakeLoader();
  const g1 = new EmbeddingGate({ mode: 'lazy', loadModel: a.loadModel });
  assert.equal(await g1.ensureReady(), true);
  assert.equal(a.c.loads, 1);
  await g1.shutdown();
  const b = fakeLoader({ beforeLoad: () => new Promise(() => {}) });
  const g2 = new EmbeddingGate({ mode: 'lazy', loadModel: b.loadModel, isModelCached: () => false });
  assert.equal(await g2.ensureReady(), false, 'uncached ensureReady must be false');
  const g3 = new EmbeddingGate({ mode: 'off', loadModel: a.loadModel });
  assert.equal(await g3.ensureReady(), false, 'disabled ensureReady must be false');
  console.log('  OK: ensureReady');
}

{ // the fetch for missing files starts at boot; a present model does not load at boot
  const a = fakeLoader();
  const g1 = new EmbeddingGate({ mode: 'lazy', loadModel: a.loadModel, isModelCached: () => true });
  g1.prefetchIfMissing();
  await sleep(10);
  assert.equal(a.c.loads, 0, 'present model loaded at boot');
  const b = fakeLoader();
  const g2 = new EmbeddingGate({ mode: 'lazy', loadModel: b.loadModel, isModelCached: () => false });
  g2.prefetchIfMissing();
  await sleep(10);
  assert.equal(b.c.loads, 1, 'missing model not fetched at boot');
  await g1.shutdown(); await g2.shutdown();
  console.log('  OK: prefetchIfMissing');
}

// ---- Engine paths -------------------------------------------------------------------------

mgr.embeddingsMode = 'lazy';
const install = (opts = {}, extra = {}) => {
  const fl = fakeLoader(extra);
  mgr.gate = new EmbeddingGate({ mode: 'lazy', loadModel: fl.loadModel, ...opts });
  mgr.embeddingCache = new Map();
  return fl;
};

// Seed with a loaded model, then reconcile.
let cur = install();
await mgr.syncDocumentFromFile('/nonexistent-a.md', 'doc-a', { content: 'alpha beta gamma delta epsilon' });
await mgr.createEntities([{ name: 'Seed Entity', entityType: 'CONCEPT', observations: ['seed observation text'] }]);
await mgr.startReconciliation();
assert.equal(mgr.coordinator.reconState, 'n/a');

{ // a query with no lexical match can only answer through the vector path
  cur = install();
  const noFts = 'zzqvvx';
  const ftsHits = mgr.db.prepare(`SELECT COUNT(*) c FROM chunks_fts WHERE chunks_fts MATCH ?`).get(`"${noFts}"`).c;
  assert.equal(ftsHits, 0, 'test query must not match FTS');
  assert.equal(mgr.gate.status.state, 'idle');
  const r = await mgr.hybridSearch(noFts, 5, false);
  assert.equal(r.search_mode, 'hybrid', `idle gate must not fall to FTS (got ${r.search_mode}, ${r.degradation_reason})`);
  assert.ok(r.results.length > 0, 'vector path returned nothing');
  assert.equal(cur.c.loads, 1, 'model not loaded for the search');
  console.log('  OK: hybridSearch on an idle gate loads and runs the vector path');
}

{ // searchNodes likewise
  cur = install();
  const r = await mgr.searchNodes('zzqvvx', 5);
  assert.equal(r.search_mode, 'hybrid', `idle gate must not fall to FTS (got ${r.search_mode})`);
  assert.ok(r.entities.length > 0, 'vector path returned no entity');
  assert.equal(cur.c.loads, 1);
  console.log('  OK: searchNodes on an idle gate loads and runs the vector path');
}

{ // writes embed immediately rather than queueing
  cur = install();
  const s = await mgr.syncDocumentFromFile('/nonexistent-b.md', 'doc-b', { content: 'writing while the model is out of memory' });
  assert.equal(s.embedding_status, 'embedded', `sync queued on an idle gate (${s.embedding_status})`);
  assert.ok(s.embeddedChunks > 0);
  assert.equal(cur.c.loads, 1);
  cur = install();
  const e = await mgr.createEntities([{ name: 'Idle Entity', entityType: 'CONCEPT', observations: ['created while unloaded'] }]);
  assert.equal(e[0].embedding_status, 'embedded', `entity queued on an idle gate (${e[0].embedding_status})`);
  assert.equal(cur.c.loads, 1);
  console.log('  OK: sync and createEntities on an idle gate embed immediately');
}

{ // a re-sync whose chunks are all reusable does not bring the model in
  const sec = (name) => `## ${name}\n\n${`${name} sentence with several ordinary words in it. `.repeat(120)}\n\n`;
  cur = install();
  await mgr.syncDocumentFromFile('/nonexistent-c.md', 'doc-c', { content: sec('First') + sec('Second') });
  cur = install();
  const s = await mgr.syncDocumentFromFile('/nonexistent-c.md', 'doc-c', { content: sec('Second') + sec('First') });
  assert.ok(s.reusedChunks > 0, 'fixture must reuse chunks');
  if (s.newlyEmbeddedChunks === 0) {
    assert.equal(cur.c.loads, 0, 'model loaded although every vector was reusable');
    assert.equal(s.embedding_status, 'embedded');
    console.log('  OK: fully reusable re-sync does not load the model');
  } else {
    throw new Error(`fixture invalid: ${s.newlyEmbeddedChunks} chunks not reusable`);
  }
}

{ // files missing: FTS at once, marked, nothing recorded as a data failure
  cur = install({ isModelCached: () => false }, { beforeLoad: () => new Promise(() => {}) });
  const r = await mgr.hybridSearch('alpha', 5, false);
  assert.equal(r.search_mode, 'fts-only', 'download window must answer from FTS');
  assert.equal(r.degradation_reason, 'model_not_ready');
  assert.ok(r.results.length > 0);
  const n = await mgr.searchNodes('Seed', 5);
  assert.equal(n.search_mode, 'fts-only');
  const e = await mgr.createEntities([{ name: 'Download Entity', entityType: 'CONCEPT', observations: ['during download'] }]);
  assert.equal(e[0].embedding_status, 'queued');
  const before = mgr.db.prepare(`SELECT COUNT(*) c FROM embedding_backfill_failures`).get().c;
  await mgr.coordinator.scanAndBackfill();
  const after = mgr.db.prepare(`SELECT COUNT(*) c FROM embedding_backfill_failures`).get().c;
  assert.equal(after, before, 'not-ready recorded as a per-row failure');
  console.log('  OK: missing files -> marked FTS; backfill records no failure');
}

{ // the backfill wakes the model only when there is work
  cur = install();                                  // Download Entity above still has no vector
  await mgr.coordinator.scanAndBackfill();
  assert.equal(cur.c.loads, 1, 'pending work did not load the model');
  const vecs = mgr.db.prepare(`SELECT COUNT(*) c FROM entity_embedding_metadata WHERE entity_id = 'entity_download_entity'`).get().c;
  assert.equal(vecs, 1, 'backfill did not embed the pending entity');
  cur = install();
  await mgr.coordinator.scanAndBackfill();
  assert.equal(cur.c.loads, 0, 'nothing to do but the model was loaded');
  console.log('  OK: backfill loads the model only when there is work');
}

{ // a real load failure: marked FTS
  mgr.gate = new EmbeddingGate({ mode: 'lazy', backoffMs: [60_000], loadModel: async () => { throw new Error('boom'); } });
  mgr.embeddingCache = new Map();
  const r = await mgr.hybridSearch('alpha', 5, false);
  assert.equal(r.search_mode, 'fts-only');
  assert.equal(r.degradation_reason, 'model_not_ready');
  await mgr.gate.shutdown();
  console.log('  OK: load failure -> marked FTS');
}

try { mgr.cleanup(); } catch {}
rmSync(dir, { recursive: true, force: true });
console.log('MODEL-ON-DEMAND OK');
