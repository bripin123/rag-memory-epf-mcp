#!/usr/bin/env node
// kg-relation-evidence D2④ (C1 RED, fixed in Task 6): 6.4.0 getDetailedContext joins documents with an
// INNER JOIN (index.ts:4433-4460), so every KG chunk hit fails there, while hybridSearch reports
// full_context_available: true unconditionally (index.ts:4387). Contract: KG chunks resolve to a
// type-appropriate detail; full_context_available means "the stored body can be resolved".
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeManager } from './helpers/engine-test-db.mjs';
import { redCase, defect, expectDefectError } from './helpers/red-case.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const { manager: m, cleanup } = await makeManager();
try {
  const db = m.db;
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  await m.createEntities([
    { name: 'Zqxdetail Alpha', entityType: 'CONCEPT', observations: ['[2026-01-01] alpha fact'] },
    { name: 'Zqxdetail Beta', entityType: 'CONCEPT', observations: ['[2026-01-01] beta fact'] },
  ]);
  await m.createRelations([{ from: 'Zqxdetail Alpha', to: 'Zqxdetail Beta', relationType: 'LINKS' }]);
  const relId = one(`SELECT id FROM relationships`).id;
  const relChunk = `kg_relationship_${relId}`;
  const entChunk = 'kg_entity_entity_zqxdetail_alpha';
  await m.generateKnowledgeGraphChunks();
  const relText = one(`SELECT text FROM chunk_metadata WHERE chunk_id = ?`, relChunk)?.text;
  const hit = async (q, chunkId) => (await m.hybridSearch(q, 10, false)).results.find(x => x.chunk_id === chunkId);

  await redCase('④ getDetailedContext resolves a legacy KG relationship chunk', {
    control: async () => { assert.ok(relText, 'control: relationship chunk generated'); assert.ok(await hit('zqxdetail', relChunk), 'control: hybridSearch returns it'); },
    defect: async () => {
      // On 6.4.0 the INNER JOIN makes this throw "not found" — that throw IS the defect (RED);
      // any other error is ERROR.
      const d = await expectDefectError(() => m.getDetailedContext(relChunk), /not found/, 'KG relationship chunk has no detail');
      assert.equal(d.source_kind, 'relationship'); assert.equal(d.source_id, relId);
      assert.equal(d.document_id, null); assert.equal(d.document_title, null);
      assert.equal(d.full_text, relText, 'the stored body is returned');
      assert.equal(d.evidence_status, 'claim_only', 'a triplet is a claim, not verified evidence');
      assert.deepEqual(d.evidence_refs, []);
      assert.deepEqual(d.relationship, { id: relId, source: 'Zqxdetail Alpha', target: 'Zqxdetail Beta', relationType: 'LINKS', confidence: 1 });
    },
  });
  await redCase('④ getDetailedContext resolves a KG entity chunk', {
    control: async () => { assert.ok(one(`SELECT 1 x FROM chunk_metadata WHERE chunk_id = ?`, entChunk), 'control: entity chunk generated'); },
    defect: async () => {
      const d = await expectDefectError(() => m.getDetailedContext(entChunk), /not found/, 'KG entity chunk has no detail');
      assert.equal(d.source_kind, 'entity'); assert.equal(d.source_id, 'entity_zqxdetail_alpha');
      assert.equal(d.document_id, null); assert.equal(d.document_title, null);
      assert.deepEqual(d.entity.observations.map(o => o.content), ['[2026-01-01] alpha fact']);
    },
  });
  await redCase('④ full_context_available is false and detail fails once the relationship row is gone', {
    control: async () => { const h = await hit('zqxdetail', relChunk); assert.ok(h && h.full_context_available === true, 'control: true while the row exists'); },
    defect: async () => {
      // Raw delete on purpose: a reader meets this state when a writer that does not clean KG chunks
      // (another engine build on the same file, 6.4.0 deleteRelations, a hand edit) removed the row.
      db.prepare(`DELETE FROM relationships WHERE id = ?`).run(relId);
      const h = await hit('zqxdetail', relChunk);
      assert.ok(h, 'the orphan chunk is still a search candidate (FTS)');
      defect(h.full_context_available === false, 'search claims the body can be resolved');
      assert.equal(typeof h.document_title, 'string', 'search field types unchanged');
      await assert.rejects(() => m.getDetailedContext(relChunk), /not found/, 'detail must fail like an unknown chunk');
    },
  });
  // TASK6-APPEND (Task 6 inserts the C4 block here)
  console.log(process.exitCode ? 'kg-detail-context: FAIL' : 'kg-detail-context: ALL PASS');
} finally { cleanup(); }
