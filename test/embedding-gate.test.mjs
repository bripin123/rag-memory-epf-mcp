// EmbeddingGate verification: state machine, single-flight load, backoff retry,
// priority queue with inference concurrency 1, graceful shutdown discarding
// in-flight results. Spec §3, DoD 2/5/19. Injected fake loaders only — no model,
// no network, no DB.
import assert from 'node:assert/strict';
import { EmbeddingGate, GateDisabledError, GateNotReadyError } from '../dist/src/embeddingGate.js';

const vec = () => new Float32Array(1024);
let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

// (a) off: disabled, loader never invoked, embed rejects EMBEDDINGS_DISABLED
{
  let loads = 0;
  const g = new EmbeddingGate({ mode: 'off', loadModel: async () => { loads++; return async () => vec(); } });
  await g.start();
  assert.equal(g.status.state, 'disabled');
  assert.equal(loads, 0, 'off mode invoked the loader');
  await assert.rejects(() => g.embed('x', { priority: 'interactive' }), GateDisabledError);
  console.log('  OK: off mode = disabled, zero pipeline calls');
}

// (b)(c)(d) lazy start, not-ready rejection, ready transition, single-flight, onReady once
{
  let loads = 0, readies = 0;
  let release; const gateOpen = new Promise(r => { release = r; });
  const g = new EmbeddingGate({
    mode: 'lazy',
    loadModel: async () => { loads++; await gateOpen; return async () => vec(); },
    onReady: () => { readies++; },
  });
  assert.equal(g.status.state, 'idle');
  await assert.rejects(() => g.embed('x', { priority: 'interactive' }), GateNotReadyError);
  const s1 = g.start(); const s2 = g.start(); const s3 = g.start();
  release();
  await Promise.all([s1, s2, s3]);
  assert.equal(g.status.state, 'ready');
  assert.equal(loads, 1, 'single-flight violated');
  assert.equal(readies, 1, 'onReady fired more than once');
  console.log('  OK: lazy idle -> ready, single-flight, onReady once');
}

// (e) load failure -> failed(retryAt), scheduled retry recovers
{
  let attempt = 0;
  const g = new EmbeddingGate({
    mode: 'lazy', backoffMs: [50, 100],
    loadModel: async () => { if (++attempt === 1) throw new Error('net down'); return async () => vec(); },
  });
  await g.start().catch(() => {});
  assert.equal(g.status.state, 'failed');
  assert.ok(g.status.lastError?.includes('net down'));
  assert.ok(g.status.retryAt, 'retryAt missing in failed state');
  const nr = await g.embed('x', { priority: 'interactive' }).catch(e => e);
  assert.equal(nr.code, 'MODEL_NOT_READY');
  assert.ok(typeof nr.retryAfterMs === 'number', 'retryAfterMs missing');
  await new Promise(r => setTimeout(r, 250));
  assert.equal(g.status.state, 'ready', 'backoff retry did not recover');
  await g.shutdown();
  console.log('  OK: failed + backoff retry recovery, structured not-ready error');
}

// (f)(g) priority ordering + inference concurrency exactly 1
{
  const order = []; let inflight = 0, maxInflight = 0;
  const g = new EmbeddingGate({
    mode: 'lazy',
    loadModel: async () => async (text) => {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      await new Promise(r => setTimeout(r, 20));
      order.push(text); inflight--; return vec();
    },
  });
  await g.start();
  await Promise.all([
    g.embed('b1', { priority: 'backfill' }), g.embed('b2', { priority: 'backfill' }),
    g.embed('b3', { priority: 'backfill' }), g.embed('live', { priority: 'interactive' }),
  ]);
  assert.equal(maxInflight, 1, `inference concurrency ${maxInflight} > 1`);
  assert.ok(order.indexOf('live') <= 1, `interactive not prioritized: ${order.join(',')}`);
  await g.shutdown();
  console.log('  OK: priority interactive>backfill, concurrency 1');
}

// (i) systemic inference failure: 3 consecutive errors -> failed + backoff recovery (beta B6)
{
  let healthy = false;
  const g = new EmbeddingGate({
    mode: 'lazy', backoffMs: [50, 100],
    loadModel: async () => async () => {
      if (!healthy) throw new Error('onnx runtime blew up');
      return vec();
    },
  });
  await g.start();
  assert.equal(g.status.state, 'ready');
  for (let i = 0; i < 3; i++) await g.embed('x' + i, { priority: 'bulk' }).catch(() => {});
  assert.equal(g.status.state, 'failed', 'ready survived 3 consecutive inference failures');
  assert.ok(g.status.retryAt, 'no retry scheduled after systemic failure');
  healthy = true;
  await new Promise(r => setTimeout(r, 200));
  assert.equal(g.status.state, 'ready', 'reload did not recover');
  const v2 = await g.embed('post-recovery', { priority: 'interactive' });
  assert.equal(v2.length, 1024);
  // beta 2R B4: a success resets the detector — one later failure must NOT
  // instantly re-demote.
  healthy = false;
  await g.embed('single-late-failure', { priority: 'bulk' }).catch(() => {});
  assert.equal(g.status.state, 'ready', 'single failure after recovery re-demoted immediately');
  await g.shutdown();
  console.log('  OK: systemic inference failure -> failed + reload recovery + reset-on-success');
}

// (i2) distinct-input semantics (beta 2R B4): A→B→A = 2 distinct inputs, no demote
{
  const g = new EmbeddingGate({
    mode: 'lazy', backoffMs: [50],
    loadModel: async () => async (t) => { throw new Error('boom ' + t); },
  });
  await g.start();
  await g.embed('A', { priority: 'bulk' }).catch(() => {});
  await g.embed('B', { priority: 'bulk' }).catch(() => {});
  await g.embed('A', { priority: 'bulk' }).catch(() => {});
  assert.equal(g.status.state, 'ready', 'A→B→A demoted with only 2 distinct inputs');
  await g.embed('C', { priority: 'bulk' }).catch(() => {});
  assert.equal(g.status.state, 'failed', 'third distinct input did not demote');
  await g.shutdown();
  console.log('  OK: distinct-input counting (A→B→A stays ready, 3rd distinct demotes)');
}

// (j) shutdown settles an in-flight load (bounded) instead of ignoring it (beta B1)
{
  let resolveLoad;
  const g = new EmbeddingGate({
    mode: 'lazy',
    loadModel: () => new Promise(res => { resolveLoad = () => res(async () => vec()); }),
  });
  const sp = g.start();
  setTimeout(() => resolveLoad(), 100);           // load completes during settle window
  const t0 = Date.now();
  await g.shutdown(2000);
  assert.ok(Date.now() - t0 >= 90, 'shutdown did not wait for the in-flight load');
  assert.equal(g.loadInFlight, false, 'loadInFlight still true after settled load');
  await sp.catch(() => {});
  console.log('  OK: shutdown settles in-flight load; loadInFlight reflects it');
}

// (h) shutdown discards in-flight result, rejects queued + new work
{
  const g = new EmbeddingGate({
    mode: 'lazy',
    loadModel: async () => async () => { await new Promise(r => setTimeout(r, 100)); return vec(); },
  });
  await g.start();
  const p = g.embed('x', { priority: 'bulk' }).catch(e => e);
  const sd = g.shutdown(1000);
  const res = await p;
  assert.ok(res instanceof Error, 'in-flight result not discarded on shutdown');
  await sd;
  await assert.rejects(() => g.embed('y', { priority: 'interactive' }));
  console.log('  OK: shutdown discards in-flight, rejects new work');
}

await new Promise(r => setTimeout(r, 100));
assert.equal(unhandled, 0, `unhandled rejections: ${unhandled}`);
console.log('EMBEDDING-GATE OK');
