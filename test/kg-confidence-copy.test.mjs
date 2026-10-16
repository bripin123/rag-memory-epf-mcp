#!/usr/bin/env node
// kg-relation-evidence D2② (C1 RED, fixed in Task 3): the relationship KG chunk copies `confidence` into
// its metadata at generation (index.ts:2319-2324); 6.4.0 updateRelations (index.ts:1515-1560) never
// refreshes that copy. Contract: refresh the copy in place; the body is unchanged, so nothing is
// re-embedded and the row is not a backfill target.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';
import { redCase, defect } from './helpers/red-case.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const { manager: m, cleanup } = await makeManager();
try {
  const db = m.db;
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const counter = installFakeEmbedder(m);
  await m.startReconciliation(); // fresh DB -> 'n/a', opens the coordinator eligibility barrier so vector search runs
  await m.createEntities([
    { name: 'Conf Left', entityType: 'CONCEPT', observations: ['[2026-01-01] left'] },
    { name: 'Conf Right', entityType: 'CONCEPT', observations: ['[2026-01-01] right'] },
  ]);
  await m.createRelations([{ from: 'Conf Left', to: 'Conf Right', relationType: 'TRUSTS' }]);
  const chunkId = `kg_relationship_${one(`SELECT id FROM relationships`).id}`;
  await m.generateKnowledgeGraphChunks();
  await m.embedKnowledgeGraphChunks();
  const row = () => one(`SELECT rowid, text, metadata, input_hash, profile_id, provenance_state FROM chunk_metadata WHERE chunk_id = ?`, chunkId);
  const vecAt = (r) => one(`SELECT count(*) n FROM chunks WHERE rowid = ${Number(r)}`).n;

  await redCase('② confidence-only update refreshes the KG chunk copy without re-embedding', {
    control: async () => {
      assert.equal(JSON.parse(row().metadata).confidence, 1, 'control: generated copy = 1.0');
      assert.equal(vecAt(row().rowid), 1, 'control: vector present');
      const s = await m.hybridSearch('trusts', 10, false);
      assert.equal(s.search_mode, 'hybrid', 'control: vector side active (not fts-only)');
      assert.ok(s.results.some(x => x.chunk_id === chunkId), 'control: the relationship chunk is retrievable before the update');
    },
    defect: async () => {
      const before = row();
      counter.calls = 0; m.embeddingCache = new Map();
      const res = await m.updateRelations([{ from: 'Conf Left', to: 'Conf Right', relationType: 'TRUSTS', confidence: 0.25 }]);
      assert.equal(res.updated, 1, 'relationship updated');
      const after = row();
      defect(JSON.parse(after.metadata).confidence === 0.25, 'chunk metadata still carries the old confidence');
      assert.deepEqual({ ...after, metadata: null }, { ...before, metadata: null }, 'text / rowid / provenance must not change');
      assert.equal(vecAt(after.rowid), 1, 'a confidence-only update must keep the vector');
      assert.equal(after.input_hash, sha(after.text), 'input_hash still matches the body, so backfill does not target the row');
      assert.equal(counter.calls, 0, 'a confidence-only update must not embed anything');
      const s = await m.hybridSearch('trusts', 10, false);
      assert.ok(s.results.some(x => x.chunk_id === chunkId), 'the chunk stays retrievable after a confidence-only update');
    },
  });
  console.log(process.exitCode ? 'kg-confidence-copy: FAIL' : 'kg-confidence-copy: ALL PASS');
} finally { cleanup(); }
