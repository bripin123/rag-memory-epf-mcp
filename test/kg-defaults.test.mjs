#!/usr/bin/env node
// kg-relation-evidence C7.2 / C7.3 + Review Focus 4. Default behaviour where nothing opted in:
// ordinary writers create no KG metadata; the no-argument generator writes 6.4.0's bodies, ids,
// metadata, offsets and counts (6.4.0 formulas restated here; byte comparison against the real 6.4.0
// build = eval/kg-defaults/generate-snapshot.mjs); KG search results keep their field types.
import assert from 'node:assert/strict';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';

const { manager: m, cleanup } = await makeManager();
try {
  const db = m.db;
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const kgCount = () => one(`SELECT count(*) n FROM chunk_metadata WHERE chunk_type IN ('entity','relationship')`).n;
  installFakeEmbedder(m);
  const D = '[2026-01-01] ';
  const steps = [
    ['createEntities', () => m.createEntities([{ name: 'Def Alpha', entityType: 'ORG', observations: [`${D}alpha one`, `${D}alpha two`] }, { name: '기본 베타', entityType: 'TEAM', observations: [`${D}베타 🎉 관찰`] }])],
    ['addObservations', () => m.addObservations([{ entityName: 'Def Alpha', contents: [`${D}alpha three`] }])],
    ['createRelations', () => m.createRelations([{ from: 'Def Alpha', to: '기본 베타', relationType: 'FUNDS_PROJECT' }, { from: '기본 베타', to: 'Def Gamma', relationType: 'uses' }])],
    ['updateRelations', () => m.updateRelations([{ from: 'Def Alpha', to: '기본 베타', relationType: 'FUNDS_PROJECT', confidence: 0.7 }])],
    ['correctObservation', async () => { const o = one(`SELECT observation_id FROM entity_observations WHERE content = ?`, `${D}alpha two`).observation_id; await m.correctObservation(o, `${D}alpha two, corrected`); }],
    ['syncDocumentFromFile', () => m.syncDocumentFromFile('/def.md', 'def-doc', { content: '# Def\n\nDef Alpha funds 기본 베타.\n' })],
    ['storeDocument + chunkDocument', async () => { await m.storeDocument('def-doc-2', 'Plain body for the default check.', {}); await m.chunkDocument('def-doc-2'); }],
    // embeds def-doc-2 too, so the search control below sees full chunk coverage ('hybrid', not 'hybrid-partial')
    ['embedChunks', () => m.embedChunks('def-doc-2')],
  ];
  for (const [name, fn] of steps) { await fn(); assert.equal(kgCount(), 0, `${name} created KG chunk metadata`); }
  console.log('  PASS C7.2 ordinary CRUD and ingest create no KG chunks');

  // C7.3: the no-argument generator = 6.4.0 formulas (index.ts:2381-2391 on 6.4.0)
  const res = await m.generateKnowledgeGraphChunks();
  const ents = db.prepare(`SELECT id, name, entityType, observations FROM entities ORDER BY id`).all();
  const rels = db.prepare(`SELECT r.id, r.relationType, r.confidence, e1.name s, e2.name t FROM relationships r JOIN entities e1 ON e1.id = r.source_entity JOIN entities e2 ON e2.id = r.target_entity ORDER BY r.id`).all();
  assert.deepEqual(res, { entityChunks: ents.length, relationshipChunks: rels.length });
  for (const e of ents) {
    const obs = JSON.parse(e.observations);
    const text = `${e.name} is a ${e.entityType}. ${obs.length > 0 ? obs.join('. ') : 'No additional information available.'}`;
    const row = one(`SELECT chunk_type, entity_id, chunk_index, text, start_pos, end_pos, metadata FROM chunk_metadata WHERE chunk_id = ?`, `kg_entity_${e.id}`);
    assert.deepEqual(row, { chunk_type: 'entity', entity_id: e.id, chunk_index: 0, text, start_pos: 0, end_pos: text.length,
      metadata: JSON.stringify({ entity_name: e.name, entity_type: e.entityType }) }, `entity chunk ${e.id}`);
  }
  for (const r of rels) {
    const text = `${r.s} ${r.relationType.toLowerCase().replace(/_/g, ' ')} ${r.t}`;
    const row = one(`SELECT chunk_type, relationship_id, chunk_index, text, start_pos, end_pos, metadata FROM chunk_metadata WHERE chunk_id = ?`, `kg_relationship_${r.id}`);
    assert.deepEqual(row, { chunk_type: 'relationship', relationship_id: r.id, chunk_index: 0, text, start_pos: 0, end_pos: text.length,
      metadata: JSON.stringify({ source_entity: r.s, target_entity: r.t, relation_type: r.relationType, confidence: r.confidence }) }, `relationship chunk ${r.id}`);
  }
  console.log('  PASS C7.3 no-argument generator: 6.4.0 bodies, ids, metadata, offsets, counts');

  // C7.2: KG hits keep their search field types and meaning. This is a positive search control, so the
  // vector side must run: without startReconciliation the coordinator is not eligible and the answer is
  // FTS-only (fresh DB -> 'n/a' opens the eligibility barrier).
  await m.startReconciliation();
  await m.embedKnowledgeGraphChunks(); // the generator writes rows only; vectors come from the embed step
  const s = await m.hybridSearch('Def Alpha', 10, false);
  assert.equal(s.search_mode, 'hybrid', `control: vector side active (search_mode=${s.search_mode})`);
  const kgHits = s.results.filter(x => x.chunk_type !== 'document');
  assert.ok(kgHits.some(x => x.chunk_type === 'entity') && kgHits.some(x => x.chunk_type === 'relationship'), 'fixture: both KG kinds are hits');
  for (const x of kgHits) {
    assert.equal(typeof x.document_title, 'string');
    assert.equal(x.document_title, x.chunk_type === 'entity' ? 'Knowledge Graph Entity' : 'Knowledge Graph Relationship');
    assert.equal(typeof x.source_id, 'string');
    assert.equal(x.source_id.startsWith(x.chunk_type === 'entity' ? 'entity_' : 'rel_'), true);
  }
  console.log('  PASS C7.2 KG search result field types unchanged');

  // Review Focus 4: the no-argument generator replaces evidence chunks with triplets for every relationship
  await m.syncDocumentFromFile('/rf.md', 'rf', { content: 'Def Alpha funds 기본 베타 now.' });
  const { createHash } = await import('node:crypto');
  const q = 'Def Alpha funds 기본 베타 now.';
  await m.generateRelationEvidenceChunks([{ relationship_id: rels[0].id, evidence: [{ kind: 'document', chunk_id: 'rf_chunk_0', start: 0, end: [...q].length, quote_sha256: createHash('sha256').update(q, 'utf8').digest('hex') }] }], { formatVersion: 'evidence-v1' });
  assert.equal(one(`SELECT count(*) n FROM chunk_metadata WHERE metadata LIKE '%"kg_format":"evidence-v1"%'`).n, 1, 'fixture: one evidence chunk');
  await m.generateKnowledgeGraphChunks();
  assert.equal(one(`SELECT count(*) n FROM chunk_metadata WHERE metadata LIKE '%"kg_format":"evidence-v1"%'`).n, 0, 'evidence chunk survived the no-argument generator');
  assert.equal(one(`SELECT count(*) n FROM chunk_metadata WHERE chunk_type = 'relationship'`).n, rels.length, 'every relationship has its triplet again');
  console.log('  PASS Review Focus 4: no-argument generator replaces evidence with triplets (documented)');
  console.log(process.exitCode ? 'kg-defaults: FAIL' : 'kg-defaults: ALL PASS');
} finally { cleanup(); }
