// Provenance reconciliation verification: grandfather (entity embedding_text
// comparison, chunk text-invariant stamp), delete-to-missing for stale/malformed,
// custom-model guard, complete invariant, and the automatic-backfill race
// barrier (model ready before reconciliation must NOT re-embed legacy rows).
// Spec §6b, DoD 3/4(부분)/9/16/17/20/21.
import { rmSync, existsSync, unlinkSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeManager } from './helpers/engine-test-db.mjs';

const { manager: mgr, dbPath, dir } = await makeManager();
const { EmbeddingGate } = await import('../dist/src/embeddingGate.js');

// Counting fake gate, READY FIRST (race precondition).
const inferences = [];
function makeCountingGate() {
  const g = new EmbeddingGate({ mode: 'lazy', loadModel: async () => async (text) => {
    inferences.push(text.slice(0, 30));
    const v = new Float32Array(1024); v[0] = 0.5; return v;
  }});
  return g;
}
const gate = makeCountingGate();
await gate.start();
mgr.gate = gate;
mgr.embeddingsMode = 'lazy'; // makeManager boots with skipModel(off); this test exercises the lazy contract

const db = mgr.db;
const VEC = Buffer.from(new Float32Array(1024).fill(0.25).buffer);

// ---- Fixture: legacy rows (provenance NULL, vectors present) --------------
// Entities: e-match (stored text == rebuilt), e-stale (obs changed after embed),
// e-null (embedding_text NULL).
function seedEntity(id, name, obs) {
  db.prepare(`INSERT INTO entities (id, name, entityType, observations) VALUES (?,?, 'CONCEPT', ?)`)
    .run(id, name, JSON.stringify(obs));
}
function seedEntityVector(entityId, embeddingText) {
  const r = db.prepare(`INSERT INTO entity_embeddings (embedding) VALUES (?)`).run(VEC);
  db.prepare(`INSERT INTO entity_embedding_metadata (rowid, entity_id, embedding_text) VALUES (?,?,?)`)
    .run(r.lastInsertRowid, entityId, embeddingText);
}
seedEntity('entity_e_match', 'e-match', ['[2026-07-18] alpha']);
const rebuilt = mgr.buildEntityEmbeddingText({ name: 'e-match', entityType: 'CONCEPT', observations: ['[2026-07-18] alpha'] }).text;
seedEntityVector('entity_e_match', rebuilt);

seedEntity('entity_e_stale', 'e-stale', ['[2026-07-18] beta CHANGED']);
seedEntityVector('entity_e_stale', 'OLD EMBEDDING INPUT (does not match rebuild)');

seedEntity('entity_e_null', 'e-null', ['[2026-07-18] gamma']);
seedEntityVector('entity_e_null', null);

// Chunks: c-ok (text present), c-null (text NULL but vector exists).
db.prepare(`INSERT INTO documents (id, content, metadata) VALUES ('doc1','chunk body text','{}')`).run();
db.prepare(`INSERT INTO chunk_metadata (chunk_id, document_id, chunk_index, text) VALUES ('c-ok','doc1',0,'chunk body text')`).run();
const cokRowid = db.prepare(`SELECT rowid FROM chunk_metadata WHERE chunk_id='c-ok'`).get().rowid;
db.prepare(`INSERT INTO chunks (rowid, embedding) VALUES (${cokRowid}, ?)`).run(VEC);
db.prepare(`INSERT INTO chunk_metadata (chunk_id, document_id, chunk_index, text) VALUES ('c-null','doc1',1,NULL)`).run();
const cnullRowid = db.prepare(`SELECT rowid FROM chunk_metadata WHERE chunk_id='c-null'`).get().rowid;
db.prepare(`INSERT INTO chunks (rowid, embedding) VALUES (${cnullRowid}, ?)`).run(VEC);

// Split-state fixtures (beta 1R B3): pre-v3.6 non-atomic writes.
// e-meta-only: metadata WITHOUT a vector row (must be removed -> backfill target).
seedEntity('entity_e_meta_only', 'e-meta-only', ['[2026-07-18] delta']);
db.prepare(`INSERT INTO entity_embedding_metadata (rowid, entity_id, embedding_text) VALUES (99991, 'entity_e_meta_only', 'whatever')`).run();
// orphan vector WITHOUT metadata (must be deleted).
db.prepare(`INSERT INTO entity_embeddings (rowid, embedding) VALUES (99992, ?)`).run(VEC);
// Old-profile verified rows (beta 1R B4): a previous compatibility profile must
// not stay searchable after reconciliation.
seedEntity('entity_e_oldprof', 'e-oldprof', ['[2026-07-18] epsilon']);
const rOld = db.prepare(`INSERT INTO entity_embeddings (embedding) VALUES (?)`).run(VEC);
db.prepare(`INSERT INTO entity_embedding_metadata (rowid, entity_id, embedding_text, input_hash, profile_id, provenance_state)
  VALUES (?, 'entity_e_oldprof', 'old profile text', 'oldhash', 999, 'verified')`).run(rOld.lastInsertRowid);
db.prepare(`INSERT INTO chunk_metadata (chunk_id, document_id, chunk_index, text, input_hash, profile_id, provenance_state)
  VALUES ('c-oldprof','doc1',2,'old profile chunk','oldhash',999,'verified')`).run();
const coldRowid = db.prepare(`SELECT rowid FROM chunk_metadata WHERE chunk_id='c-oldprof'`).get().rowid;
db.prepare(`INSERT INTO chunks (rowid, embedding) VALUES (${coldRowid}, ?)`).run(VEC);

// ---- (g) RACE: model ready first, kick before reconciliation ---------------
assert.equal(mgr.coordinator.reconState, 'pending');
assert.equal(mgr.coordinator.eligible, false, 'eligible before reconciliation');
mgr.coordinator.kick();
await new Promise(r => setTimeout(r, 400));
assert.equal(inferences.length, 0, `legacy rows re-embedded before reconciliation (race!): ${inferences}`);
console.log('  OK: backfill barrier - no inference before reconciliation (DoD 20)');

// ---- Run reconciliation ----------------------------------------------------
await mgr.startReconciliation();
assert.equal(mgr.coordinator.reconState, 'complete');

// (a) complete invariant: no VECTOR-BEARING row remains provenance NULL —
// entity side joined against entity_embeddings (beta 1R test-defect fix).
const nullEnt = db.prepare(`
  SELECT COUNT(*) c FROM entity_embedding_metadata m JOIN entity_embeddings v ON v.rowid = m.rowid
  WHERE m.provenance_state IS NULL`).get().c;
const nullChunk = db.prepare(`
  SELECT COUNT(*) c FROM chunk_metadata m JOIN chunks v ON v.rowid = m.rowid
  WHERE m.provenance_state IS NULL`).get().c;
assert.equal(nullEnt + nullChunk, 0, 'complete invariant violated (DoD 21)');
console.log('  OK: complete invariant - zero unreconciled vectors');

// (a2) split-state sanitation (beta B3): metadata-only row removed, orphan vector removed
assert.equal(db.prepare(`SELECT COUNT(*) c FROM entity_embedding_metadata WHERE entity_id='entity_e_meta_only'`).get().c, 0,
  'metadata-without-vector not sanitized');
assert.equal(db.prepare(`SELECT COUNT(*) c FROM entity_embeddings WHERE rowid NOT IN (SELECT rowid FROM entity_embedding_metadata)`).get().c, 0,
  'orphan vectors not sanitized');
console.log('  OK: split-state sanitation (meta-only removed, orphans removed)');

// (a3) old-profile sanitation (beta B4): previous-profile verified vectors deleted-to-missing
assert.equal(db.prepare(`SELECT COUNT(*) c FROM entity_embedding_metadata WHERE entity_id='entity_e_oldprof'`).get().c, 0,
  'old-profile entity vector still searchable');
assert.equal(db.prepare(`SELECT COUNT(*) c FROM chunks WHERE rowid=${coldRowid}`).get().c, 0,
  'old-profile chunk vector still searchable');
assert.equal(db.prepare(`SELECT provenance_state FROM chunk_metadata WHERE chunk_id='c-oldprof'`).get().provenance_state, null,
  'old-profile chunk not normalized to missing');
console.log('  OK: old-profile verified vectors sanitized before eligibility (DoD 3)');

// (b) matching entity grandfathered: legacy_assumed + input_hash, vector kept
const eMatch = db.prepare(`SELECT provenance_state, input_hash, profile_id FROM entity_embedding_metadata WHERE entity_id='entity_e_match'`).get();
assert.equal(eMatch.provenance_state, 'legacy_assumed');
assert.ok(eMatch.input_hash, 'input_hash not stamped');
assert.equal(eMatch.profile_id, mgr.currentProfileId);
console.log('  OK: matching entity -> legacy_assumed with hash');

// (c) stale + NULL-text entities: vectors deleted (missing)
for (const id of ['entity_e_stale', 'entity_e_null']) {
  const row = db.prepare(`SELECT COUNT(*) c FROM entity_embedding_metadata WHERE entity_id=?`).get(id);
  assert.equal(row.c, 0, `${id} vector not deleted`);
}
console.log('  OK: stale / malformed entities -> delete-to-missing');

// (d) chunks: text-present stamped, text-NULL deleted
const cOk = db.prepare(`SELECT provenance_state, input_hash FROM chunk_metadata WHERE chunk_id='c-ok'`).get();
assert.equal(cOk.provenance_state, 'legacy_assumed');
assert.ok(cOk.input_hash);
assert.equal(db.prepare(`SELECT COUNT(*) c FROM chunks WHERE rowid=?`).get(cnullRowid).c, 0, 'NULL-text chunk vector not deleted');
console.log('  OK: chunk stamp / NULL-text delete');

// (e) eligibility now open
assert.equal(mgr.coordinator.eligible, true, 'eligible after complete + ready');
console.log('  OK: eligibility = model_ready AND reconciliation complete');

// ---- (f) custom model guard: fresh DB, grandfather disallowed --------------
mgr.cleanup();
for (const suffix of ['', '-wal', '-shm']) { const p = dbPath + suffix; if (existsSync(p)) unlinkSync(p); }
const mod = await import('../dist/index.js');
const mgr2 = new mod.RAGKnowledgeGraphManager();
await mgr2.initialize({ skipModel: true });
mgr2.grandfatherAllowed = false;             // simulate custom EMBEDDING_MODEL without trust env
mgr2.embeddingsMode = 'lazy';                // guard test needs reconciliation to actually run
const db2 = mgr2.db;
db2.prepare(`INSERT INTO entities (id, name, entityType, observations) VALUES ('entity_x','x','CONCEPT','[]')`).run();
const r2 = db2.prepare(`INSERT INTO entity_embeddings (embedding) VALUES (?)`).run(VEC);
db2.prepare(`INSERT INTO entity_embedding_metadata (rowid, entity_id, embedding_text) VALUES (?,?,?)`)
  .run(r2.lastInsertRowid, 'entity_x', 'whatever');
await mgr2.startReconciliation();
assert.equal(mgr2.coordinator.reconState, 'complete');
assert.equal(db2.prepare(`SELECT COUNT(*) c FROM entity_embedding_metadata`).get().c, 0,
  'custom-model legacy vector auto-grandfathered (DoD 17)');
console.log('  OK: custom model guard - no auto grandfather');
mgr2.cleanup();

rmSync(dir, { recursive: true, force: true });
console.log('RECONCILIATION OK');
