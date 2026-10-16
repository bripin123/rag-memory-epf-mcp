#!/usr/bin/env node
// kg-relation-evidence D2⑤ (C1 RED, fixed in Task 4): a KG chunk vector computed for an input that
// changed during inference must be dropped — on the dedicated path (6.4.0 embedKnowledgeGraphChunks,
// index.ts:2333-2377, re-checks nothing) and on the shared backfill callback (6.4.0
// reembedChunkByRowid, index.ts:665-689, re-checks text only and stamps the profile current at WRITE
// time). The side effect runs inside the stub model call, i.e. between capture and write-back.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';
import { redCase, defect, fixture } from './helpers/red-case.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const { manager: m, cleanup } = await makeManager();
try {
  const db = m.db;
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  installFakeEmbedder(m);
  const baseEmbed = m.gate.embedFn;
  // Run fn once, the first time `text` reaches the model; everything else embeds normally.
  const during = (text, fn) => {
    m.embeddingCache = new Map();
    let fired = false;
    m.gate.embedFn = async (t, ...rest) => { if (!fired && t === text) { fired = true; await fn(); } return baseEmbed(t, ...rest); };
    return () => fired;
  };
  const restore = () => { m.gate.embedFn = baseEmbed; m.embeddingCache = new Map(); };
  const vecAt = (rowid) => one(`SELECT count(*) n FROM chunks WHERE rowid = ${Number(rowid)}`).n;
  // vec0 deletes need a literal rowid; an orphan left by a RED case must not leak into the next case.
  const dropOrphanVectors = () => {
    const meta = new Set(db.prepare(`SELECT rowid FROM chunk_metadata`).all().map(r => r.rowid));
    for (const { rowid } of db.prepare(`SELECT rowid FROM chunks`).all()) if (!meta.has(rowid)) db.exec(`DELETE FROM chunks WHERE rowid = ${Number(rowid)}`);
  };
  const p1 = m.currentProfileId;
  const p2 = Number(db.prepare(`INSERT INTO embedding_profiles (model_id, revision, dtype, dims, pooling, normalize)
    VALUES ('test/profile-b', 'r1', 'fp16', 1024, 'cls', 1)`).run().lastInsertRowid);

  await m.createEntities([
    { name: 'Cas Left', entityType: 'CONCEPT', observations: ['[2026-01-01] left'] },
    { name: 'Cas Right', entityType: 'CONCEPT', observations: ['[2026-01-01] right'] },
  ]);
  await m.createRelations([{ from: 'Cas Left', to: 'Cas Right', relationType: 'GUARDS' }]);
  const relChunk = `kg_relationship_${one(`SELECT id FROM relationships`).id}`;
  const relRow = () => one(`SELECT rowid, text FROM chunk_metadata WHERE chunk_id = ?`, relChunk);
  const plant = (rowid, chunkId, relationshipId, text) => db.prepare(`INSERT INTO chunk_metadata
      (rowid, chunk_id, chunk_type, relationship_id, chunk_index, text, start_pos, end_pos, metadata)
      VALUES (?, ?, 'relationship', ?, 0, ?, 0, ?, '{}')`).run(rowid, chunkId, relationshipId, text, text.length);
  const fresh = async () => { restore(); await m.generateKnowledgeGraphChunks(); dropOrphanVectors(); return relRow(); };

  const ftsRowids = (t) => db.prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?`).all(`"${t}"`).map(x => x.rowid);
  // C1 positive control for every case below (R2): on the SAME path that will be attacked, a normal
  // embedding writes a vector and the chunk is retrievable. Then the state is reset (fresh(): new
  // generation, no vector, empty cache) and only then is the side effect installed.
  const paths = {
    dedicated: async () => { await m.embedKnowledgeGraphChunks(); },
    backfill: async (rowid) => m.reembedChunkByRowid(rowid),
  };
  const positive = async (path) => {
    const r = await fresh();
    await paths[path](r.rowid);
    assert.equal(vecAt(r.rowid), 1, `control(${path}): a normal embedding writes a vector`);
    assert.ok(ftsRowids('guards').includes(r.rowid), `control(${path}): FTS finds the chunk`);
    assert.ok((await m.hybridSearch('guards', 10, false)).results.some(x => x.chunk_id === relChunk), `control(${path}): hybridSearch returns it`);
  };
  const cases = [
    { name: '⑤ dedicated: chunk deleted during inference -> no orphan vector', path: 'dedicated',
      inject: (r) => () => { db.prepare(`DELETE FROM chunk_metadata WHERE rowid = ?`).run(r.rowid); },
      check: (r) => { defect(vecAt(r.rowid) === 0, 'a vector was written for a chunk deleted during inference'); } },
    { name: '⑤ dedicated: rowid reused by another chunk during inference -> old vector not attached', path: 'dedicated',
      inject: (r) => () => { db.prepare(`DELETE FROM chunk_metadata WHERE rowid = ?`).run(r.rowid);
                             plant(r.rowid, 'kg_relationship_rel_planted_b', 'rel_planted_b', 'a different body planted at the same rowid'); },
      check: (r) => {
        fixture(one(`SELECT chunk_id FROM chunk_metadata WHERE rowid = ?`, r.rowid)?.chunk_id === 'kg_relationship_rel_planted_b', 'the rowid now belongs to the planted chunk');
        defect(vecAt(r.rowid) === 0, 'the vector of the old body was attached to the planted chunk');
      } },
    { name: '⑤ backfill: profile switched during inference -> result dropped', path: 'backfill',
      inject: () => () => { m.currentProfileId = p2; },
      check: (r, ok) => { defect(ok === false, 'reembedChunkByRowid reported a write'); defect(vecAt(r.rowid) === 0, 'a vector was stamped with a profile that changed during inference'); } },
    { name: '⑤ backfill: same rowid + same text but another chunk -> result dropped', path: 'backfill',
      inject: (r) => () => { db.prepare(`DELETE FROM chunk_metadata WHERE rowid = ?`).run(r.rowid);
                             plant(r.rowid, 'kg_relationship_rel_planted_d', 'rel_planted_d', r.text); },
      check: (r, ok) => { defect(ok === false, 'reembedChunkByRowid reported a write'); defect(vecAt(r.rowid) === 0, 'a vector was written for a different chunk that happens to share the text'); } },
  ];
  for (const c of cases) {
    await redCase(c.name, {
      control: () => positive(c.path),
      defect: async () => {
        const r = await fresh();
        fixture(r && vecAt(r.rowid) === 0, 'fresh state: chunk generated, no vector');
        const fired = during(r.text, c.inject(r));
        let ok;
        try { ok = await paths[c.path](r.rowid); } finally { m.currentProfileId = p1; restore(); }
        fixture(fired(), 'the side effect ran during inference');
        c.check(r, ok);
      },
    });
  }
  // Non-atomic swap on 6.4.0, WITHOUT the hook Task 4 adds (R2): a trigger in this isolated test DB
  // makes the INSERT of one NEW chunk fail inside generateKnowledgeGraphChunks. 6.4.0 has already deleted
  // the old KG chunks and vectors at that point (cleanupKnowledgeGraphChunks, index.ts:2261), so the old
  // KG is gone and a partial new one is published. After Task 4 the swap is one transaction.
  await redCase('⑤ regeneration failing mid-way publishes nothing and keeps the old KG', {
    control: () => positive('dedicated'),
    defect: async () => {
      const snap = () => JSON.stringify({
        meta: db.prepare(`SELECT rowid, chunk_id, text, metadata FROM chunk_metadata WHERE chunk_type IN ('entity','relationship') ORDER BY rowid`).all(),
        vec: db.prepare(`SELECT rowid FROM chunks ORDER BY rowid`).all(),
      });
      await m.createRelations([{ from: 'Cas Right', to: 'Cas Left', relationType: 'WARNS' }]);
      const newChunk = `kg_relationship_${one(`SELECT id FROM relationships WHERE relationType = 'WARNS'`).id}`;
      const before = snap();
      db.exec(`CREATE TRIGGER c1_fail_kg_insert BEFORE INSERT ON chunk_metadata WHEN NEW.chunk_id = '${newChunk}'
               BEGIN SELECT RAISE(ABORT, 'c1 injected KG insert failure'); END`);
      let threw = null;
      try { await m.generateKnowledgeGraphChunks(); } catch (e) { threw = e; } finally { db.exec(`DROP TRIGGER IF EXISTS c1_fail_kg_insert`); }
      fixture(threw && /c1 injected KG insert failure/.test(threw.message), 'the injected insert failure fired');
      defect(snap() === before, 'a failed regeneration changed the published KG (old chunks or vectors gone, partial rows published)');
      defect((await m.hybridSearch('guards', 10, false)).results.some(x => x.chunk_id === relChunk), 'the previously retrievable chunk is no longer retrievable');
      await m.deleteRelations([{ from: 'Cas Right', to: 'Cas Left', relationType: 'WARNS' }]);
    },
  });
  restore();
  // TASK4-APPEND (Task 4 inserts its positive / atomicity / document-regression block here)
  console.log(process.exitCode ? 'kg-embed-cas: FAIL' : 'kg-embed-cas: ALL PASS');
} finally { cleanup(); }
