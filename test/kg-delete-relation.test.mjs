#!/usr/bin/env node
// kg-relation-evidence D2① (C1 RED, fixed in Task 3): deleting a relationship alone must remove its KG
// chunk, vector and FTS row in the same transaction as the row. 6.4.0 deleteRelations
// (index.ts:1501-1512) deletes only the relationships row, so the chunk stays searchable.
import assert from 'node:assert/strict';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';
import { redCase, defect } from './helpers/red-case.mjs';

const { manager: m, cleanup } = await makeManager();
try {
  const db = m.db;
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  installFakeEmbedder(m);
  await m.startReconciliation(); // fresh DB -> 'n/a', opens the coordinator eligibility barrier so vector search runs
  await m.createEntities([
    { name: 'Zqxdel Source', entityType: 'CONCEPT', observations: ['[2026-01-01] source side'] },
    { name: 'Zqxdel Target', entityType: 'CONCEPT', observations: ['[2026-01-01] target side'] },
  ]);
  await m.createRelations([{ from: 'Zqxdel Source', to: 'Zqxdel Target', relationType: 'FEEDS' }]);
  const relId = one(`SELECT id FROM relationships`).id;
  const chunkId = `kg_relationship_${relId}`;
  await m.generateKnowledgeGraphChunks();
  await m.embedKnowledgeGraphChunks();
  const rowid = one(`SELECT rowid FROM chunk_metadata WHERE chunk_id = ?`, chunkId)?.rowid;
  const vecAt = (r) => one(`SELECT count(*) n FROM chunks WHERE rowid = ${Number(r)}`).n;
  const ftsRowids = (term) => db.prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?`).all(`"${term}"`).map(r => r.rowid);

  await redCase('① deleteRelations removes the relationship KG chunk, its vector and its FTS row', {
    control: async () => {
      assert.ok(rowid !== undefined, 'control: KG relationship chunk generated');
      assert.equal(vecAt(rowid), 1, 'control: the chunk has a vector');
      assert.ok(ftsRowids('feeds').includes(rowid), 'control: FTS finds the chunk');
      const r = await m.hybridSearch('feeds', 10, false);
      assert.equal(r.search_mode, 'hybrid', 'control: vector side active (not fts-only)');
      assert.ok(r.results.some(x => x.chunk_id === chunkId), 'control: hybridSearch returns the chunk');
    },
    defect: async () => {
      await m.deleteRelations([{ from: 'Zqxdel Source', to: 'Zqxdel Target', relationType: 'FEEDS' }]);
      assert.equal(one(`SELECT count(*) n FROM relationships WHERE id = ?`, relId).n, 0, 'relationship row deleted');   // not the target defect: ERROR if it fails
      defect(one(`SELECT count(*) n FROM chunk_metadata WHERE chunk_id = ?`, chunkId).n === 0, 'KG chunk metadata left behind');
      defect(vecAt(rowid) === 0, 'KG chunk vector left behind');
      defect(!ftsRowids('feeds').includes(rowid), 'FTS row left behind');
      const r = await m.hybridSearch('feeds', 10, false);
      defect(!r.results.some(x => x.chunk_id === chunkId), 'hybridSearch still returns the deleted relationship chunk');
      assert.equal(one(`SELECT count(*) n FROM chunk_metadata WHERE chunk_type = 'entity'`).n, 2, 'endpoint entity KG chunks must survive');
    },
  });
  console.log(process.exitCode ? 'kg-delete-relation: FAIL' : 'kg-delete-relation: ALL PASS');
} finally { cleanup(); }
