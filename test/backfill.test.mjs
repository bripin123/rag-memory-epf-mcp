// Automatic backfill verification: not-ready CRUD queued contract + dirty
// invariant, deleteObservations re-embed fix, lazy sync, post-ready recovery
// without restart, failure cap with reset-on-change, no reprocessing of
// completed rows. Spec §5·§5b·§6a·§6c, DoD 3/4/5(부분)/7.
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeManager } from './helpers/engine-test-db.mjs';

const { manager: mgr, dir } = await makeManager();
const { EmbeddingGate } = await import('../dist/src/embeddingGate.js');

// Controllable fake gate: starts NOT-ready; test flips to ready later.
const inferences = [];
let failTexts = new Set();
const gate = new EmbeddingGate({ mode: 'lazy', loadModel: async () => async (text) => {
  if ([...failTexts].some(t => text.includes(t))) throw new Error(`forced failure for ${text.slice(0, 20)}`);
  inferences.push(text.slice(0, 40));
  const v = new Float32Array(1024);
  for (let i = 0; i < text.length; i++) v[i % 1024] += text.charCodeAt(i) / 1000;
  return v;
}});
mgr.gate = gate;                 // idle (not ready)
mgr.embeddingsMode = 'lazy';
const db = mgr.db;

// ---- (a) not-ready CRUD: success + queued + vectorless ---------------------
const created = await mgr.createEntities([{ name: 'Alpha Node', entityType: 'CONCEPT', observations: ['first obs'] }]);
assert.equal(created.length, 1);
assert.equal(created[0].embedding_status, 'queued', 'not-ready create must report queued');
const entityId = 'entity_alpha_node';
assert.ok(db.prepare(`SELECT id FROM entities WHERE id=?`).get(entityId), 'CRUD row missing');
assert.equal(db.prepare(`SELECT COUNT(*) c FROM entity_embedding_metadata WHERE entity_id=?`).get(entityId).c, 0,
  'not-ready create left a vector');
console.log('  OK: not-ready createEntities -> success + queued + vectorless');

// addObservations while not ready: CRUD applies, old vector would be invalidated
const addRes = await mgr.addObservations([{ entityName: 'Alpha Node', contents: ['second obs'] }]);
assert.equal(addRes[0].embedding_status, 'queued');
console.log('  OK: not-ready addObservations -> success + queued');

// ---- (c) lazy sync: stored + FTS live + embeddedChunks 0 -------------------
const syncRes = await mgr.syncDocumentFromFile('/nonexistent.md', 'lazy-doc', {
  content: 'lazy synced content mentioning Alpha Node in its body text',
});
assert.equal(syncRes.embeddedChunks, 0, 'lazy sync embedded chunks');
assert.equal(syncRes.embedding_status, 'queued');
assert.ok(syncRes.chunks >= 1);
const ftsHit = db.prepare(`SELECT COUNT(*) c FROM chunks_fts WHERE chunks_fts MATCH '"lazy"'`).get().c;
assert.ok(ftsHit >= 1, 'lazy-synced chunk not in FTS');
console.log('  OK: lazy sync -> document+chunks+FTS stored, zero vectors');

// ---- (d) post-ready automatic recovery WITHOUT restart (DoD 4) -------------
await gate.start();              // model becomes ready -> onReady wiring is external; kick manually like main() would
assert.equal(mgr.coordinator.reconState, 'pending');
await mgr.startReconciliation(); // fresh rows only -> 'n/a'
assert.equal(mgr.coordinator.reconState, 'n/a');
mgr.coordinator.kick();
await new Promise(r => setTimeout(r, 800));
const entVec = db.prepare(`SELECT provenance_state, input_hash FROM entity_embedding_metadata WHERE entity_id=?`).get(entityId);
assert.ok(entVec, 'entity not backfilled after ready');
assert.equal(entVec.provenance_state, 'verified');
const chunkCov = db.prepare(`
  SELECT COUNT(*) c FROM chunk_metadata m JOIN chunks v ON v.rowid = m.rowid
  WHERE m.document_id='lazy-doc' AND m.provenance_state='verified'`).get().c;
assert.ok(chunkCov >= 1, 'lazy-doc chunks not backfilled');
console.log('  OK: post-ready kick recovers entity + chunks without restart (DoD 4)');

// ---- (e) completed rows are not reprocessed (DoD 7) ------------------------
const before = inferences.length;
mgr.coordinator.kick();
await new Promise(r => setTimeout(r, 500));
assert.equal(inferences.length, before, 'completed rows re-embedded on second kick');
console.log('  OK: second kick reprocesses nothing (DoD 7)');

// ---- (a2) mutation atomicity (beta B2): old vector is ALREADY gone at the
// moment inference runs — the entity change and the stale-vector delete commit
// in one transaction BEFORE any embed await.
{
  let staleVisibleAtInference = null;
  const origEmbedFn = gate.embedFn;
  gate.embedFn = async (text) => {
    if (text.includes('Alpha Node')) {
      staleVisibleAtInference = db.prepare(
        `SELECT COUNT(*) c FROM entity_embedding_metadata WHERE entity_id='entity_alpha_node'`).get().c;
    }
    return origEmbedFn(text);
  };
  await mgr.addObservations([{ entityName: 'Alpha Node', contents: ['atomicity probe obs'] }]);
  gate.embedFn = origEmbedFn;
  assert.equal(staleVisibleAtInference, 0,
    'stale vector still searchable while inference was running (§6a-1 violation)');
  console.log('  OK: mutation deletes old vector in the same tx, before inference (beta B2)');
}

// ---- (b) deleteObservations re-embed fix (stale vector regression) ---------
const oldHash = db.prepare(`SELECT input_hash FROM entity_embedding_metadata WHERE entity_id=?`).get(entityId).input_hash;
const delRes = await mgr.deleteObservations([{ entityName: 'Alpha Node', observations: db.prepare(`SELECT observations FROM entities WHERE id=?`).get(entityId).observations ? JSON.parse(db.prepare(`SELECT observations FROM entities WHERE id=?`).get(entityId).observations).slice(0, 1) : [] }]);
assert.equal(delRes.results[0].deleted, 1);
assert.equal(delRes.results[0].embedding_status, 'embedded');
const newHash = db.prepare(`SELECT input_hash FROM entity_embedding_metadata WHERE entity_id=?`).get(entityId).input_hash;
assert.notEqual(newHash, oldHash, 'deleteObservations left a stale vector (pre-3.6 defect)');
assert.equal(delRes.total_deleted, 1);
console.log('  OK: deleteObservations re-embeds (stale-vector fix) + structured result');

// ---- (f) failure cap + reset-on-change -------------------------------------
failTexts.add('Failing Target');
await mgr.createEntities([{ name: 'Failing Target', entityType: 'CONCEPT', observations: ['will fail'] }]);
// embed fails inline (throws inside embedEntity -> returns false -> queued)
for (let i = 0; i < 7; i++) { mgr.coordinator.kick(); await new Promise(r => setTimeout(r, 350)); }
const failRow = db.prepare(`SELECT attempts FROM embedding_backfill_failures WHERE kind='entity' AND target_id='entity_failing_target'`).get();
assert.ok(failRow, 'failure row missing');
assert.ok(failRow.attempts >= 5, `attempts ${failRow.attempts} < cap`);
const attemptsAtCap = failRow.attempts;
mgr.coordinator.kick();
await new Promise(r => setTimeout(r, 350));
assert.equal(db.prepare(`SELECT attempts FROM embedding_backfill_failures WHERE kind='entity' AND target_id='entity_failing_target'`).get().attempts,
  attemptsAtCap, 'cap not enforced — attempts still growing');
console.log('  OK: failure cap (5) enforced');

// content change resets the failure record and recovers
failTexts.clear();
await mgr.addObservations([{ entityName: 'Failing Target', contents: ['now recoverable'] }]);
mgr.coordinator.kick();
await new Promise(r => setTimeout(r, 500));
assert.equal(db.prepare(`SELECT COUNT(*) c FROM embedding_backfill_failures WHERE target_id='entity_failing_target'`).get().c, 0,
  'failure row not cleared after recovery');
assert.equal(db.prepare(`SELECT provenance_state FROM entity_embedding_metadata WHERE entity_id='entity_failing_target'`).get().provenance_state,
  'verified');
console.log('  OK: reset-on-change + recovery clears failure record');

mgr.cleanup();
rmSync(dir, { recursive: true, force: true });
console.log('BACKFILL OK');
