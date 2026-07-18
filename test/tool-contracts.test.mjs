// Tool response shape verification across ready / not-ready / disabled states.
// Spec §5c exact shapes: per-item embedding_status, endpoint_embedding_status,
// structured deleteObservations, sync embedding_status, structured gate errors.
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeManager, installFakeEmbedder, simulateModelDown } from './helpers/engine-test-db.mjs';

const { manager: mgr, dir } = await makeManager();
const { GateNotReadyError, GateDisabledError } = await import('../dist/src/embeddingGate.js');
mgr.embeddingsMode = 'lazy';
installFakeEmbedder(mgr);

// ---- ready state ----------------------------------------------------------
{
  const created = await mgr.createEntities([{ name: 'Shape One', entityType: 'CONCEPT', observations: ['obs'] }]);
  assert.equal(created[0].embedding_status, 'embedded');
  const rels = await mgr.createRelations([{ from: 'Shape One', to: 'Shape Two', relationType: 'RELATED_TO' }]);
  assert.equal(rels.length, 1);
  assert.deepEqual(Object.keys(rels[0].endpoint_embedding_status).sort(), ['from', 'to']);
  assert.equal(rels[0].endpoint_embedding_status.from, 'n/a', 'existing endpoint must be n/a');
  assert.equal(rels[0].endpoint_embedding_status.to, 'embedded', 'new endpoint must report its embed status');
  const added = await mgr.addObservations([{ entityName: 'Shape One', contents: ['more'] }]);
  assert.equal(added[0].embedding_status, 'embedded');
  const del = await mgr.deleteObservations([
    { entityName: 'Shape One', observations: [] },          // no-op
    { entityName: 'Ghost Entity', observations: ['x'] },    // missing entity
  ]);
  assert.equal(del.results.length, 2);
  assert.equal(del.results[0].embedding_status, 'n/a');
  assert.equal(del.results[1].deleted, 0);
  assert.equal(del.total_deleted, 0);
  const sync = await mgr.syncDocumentFromFile('/x', 'sd1', { content: 'shape sync body' });
  assert.equal(sync.embedding_status, 'embedded');
  console.log('  OK: ready-state shapes (per-item, endpoint map, structured delete, sync)');
}

// ---- not-ready state ------------------------------------------------------
{
  simulateModelDown(mgr);
  const created = await mgr.createEntities([{ name: 'Queued Ent', entityType: 'CONCEPT', observations: ['q'] }]);
  assert.equal(created[0].embedding_status, 'queued');
  const rels = await mgr.createRelations([{ from: 'Queued Ent', to: 'Queued Peer', relationType: 'RELATED_TO' }]);
  assert.equal(rels[0].endpoint_embedding_status.to, 'queued');
  const sync = await mgr.syncDocumentFromFile('/x', 'sd2', { content: 'queued sync body' });
  assert.equal(sync.embedding_status, 'queued');
  // explicit embed tools: structured retryable error, no infinite wait
  const err = await mgr.embedChunks('sd2').catch(e => e);
  assert.ok(err instanceof GateNotReadyError, `embedChunks must throw GateNotReadyError, got ${err?.constructor?.name}`);
  assert.equal(err.code, 'MODEL_NOT_READY');
  console.log('  OK: not-ready shapes (queued everywhere, MODEL_NOT_READY on explicit embed)');
}

// ---- disabled state -------------------------------------------------------
{
  mgr.gate.state = 'disabled';
  const created = await mgr.createEntities([{ name: 'Disabled Ent', entityType: 'CONCEPT', observations: ['d'] }]);
  assert.equal(created[0].embedding_status, 'disabled');
  const sync = await mgr.syncDocumentFromFile('/x', 'sd3', { content: 'disabled sync body' });
  assert.equal(sync.embedding_status, 'disabled');
  const err = await mgr.embedAllEntities().catch(e => e);
  assert.ok(err instanceof GateDisabledError, `embedAllEntities must throw GateDisabledError, got ${err?.constructor?.name}`);
  assert.equal(err.code, 'EMBEDDINGS_DISABLED');
  console.log('  OK: disabled shapes (disabled status, EMBEDDINGS_DISABLED on explicit embed)');
}

// ---- stats server block (spec §8-2, T9) -----------------------------------
{
  const stats = await mgr.getKnowledgeGraphStats();
  assert.ok(stats.server, 'server block missing');
  for (const k of ['version', 'node', 'embeddings_mode', 'model', 'model_state', 'reconciliation_state', 'coverage']) {
    assert.ok(k in stats.server, `server.${k} missing`);
  }
  assert.match(stats.server.version, /^3\.6\./);
  assert.ok(stats.server.coverage.entity.total >= 1);
  assert.ok('verified' in stats.server.coverage.chunk && 'legacy_assumed' in stats.server.coverage.chunk);
  console.log('  OK: stats server block (version, states, 3-way provenance coverage)');
}

mgr.cleanup();
rmSync(dir, { recursive: true, force: true });
console.log('TOOL-CONTRACTS OK');
