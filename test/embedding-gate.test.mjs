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
