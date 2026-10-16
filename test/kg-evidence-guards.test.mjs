#!/usr/bin/env node
// kg-relation-evidence final-review minors, each a C1 case (test/helpers/red-case.mjs):
// A2 (D2⑤): an evidence-v1 row whose evidence_refs is empty or holds a malformed ref is ineligible for the
//     reader and for every dependency lookup (src/kg/relation-evidence.ts isWellFormedRef), so its comparison
//     value must be null even when the stored fingerprint recomputes from that metadata — otherwise the
//     backfill write-back stamps a vector the reader cannot resolve.
// A1 (D2③): deleteEntities removes entity vectors and KG/evidence chunks, so it must drop the coordinator's
//     cached coverage like every other D2③ writer; otherwise coverage() and the search envelope keep
//     reporting the pre-delete totals.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';
import { redCase, defect, fixture } from './helpers/red-case.mjs';
import { fingerprintFromMetadata, kgComparisonValue } from '../dist/src/kg/relation-evidence.js';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const F = { formatVersion: 'evidence-v1' };
const { manager: m, cleanup } = await makeManager();
try {
  const db = m.db;
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  installFakeEmbedder(m);
  await m.startReconciliation();
  const vecAt = (r) => one(`SELECT count(*) n FROM chunks WHERE rowid = ${Number(r)}`).n;
  const rowAt = (r) => one(`SELECT rowid, chunk_id, chunk_type, entity_id, relationship_id, text, metadata FROM chunk_metadata WHERE rowid = ?`, r);

  await m.createEntities([
    { name: 'Grd Alpha', entityType: 'CONCEPT', observations: ['[2026-01-01] alpha'] },
    { name: 'Grd Beta', entityType: 'CONCEPT', observations: ['[2026-01-01] beta'] },
  ]);
  await m.createRelations([{ from: 'Grd Alpha', to: 'Grd Beta', relationType: 'SUPPORTS' }]);
  const R = 'rel_entity_grd_alpha_supports_entity_grd_beta';
  const CH = `kg_relationship_${R}`;
  const DOC = 'Grd Alpha supports Grd Beta with zqxgrd61.';
  await m.syncDocumentFromFile('/grd.md', 'grd', { content: DOC });
  const docRef = { kind: 'document', chunk_id: 'grd_chunk_0', start: 0, end: [...DOC].length, quote_sha256: sha(DOC) };

  // ---- A2 ----
  // Plant `refs` into a freshly generated row, re-stamp a fingerprint that recomputes from the planted
  // metadata, and drop the vector so a backfill write-back is observable.
  const plant = async (refs) => {
    await m.generateRelationEvidenceChunks([{ relationship_id: R, evidence: [docRef] }], F);
    const row = one(`SELECT rowid, metadata FROM chunk_metadata WHERE chunk_id = ?`, CH);
    assert.ok(row, 'fixture: evidence chunk generated');
    assert.ok(kgComparisonValue(rowAt(row.rowid))?.startsWith('fp:'), 'fixture: the generated well-formed row is comparable');
    const meta = JSON.parse(row.metadata);
    meta.evidence_refs = refs;
    meta.input_fingerprint = fingerprintFromMetadata(meta, meta.fingerprint_profile_id);
    db.prepare(`UPDATE chunk_metadata SET metadata = ?, provenance_state = NULL WHERE rowid = ?`).run(JSON.stringify(meta), row.rowid);
    db.exec(`DELETE FROM chunks WHERE rowid = ${Number(row.rowid)}`);
    return row.rowid;
  };
  const a2Case = async (label, refs) => {
    let r;
    await redCase(`A2 ${label}: comparison value null, write-back refused`, {
      control: async () => {
        r = await plant(refs);
        const meta = JSON.parse(rowAt(r).metadata);
        assert.equal(fingerprintFromMetadata(meta, meta.fingerprint_profile_id), meta.input_fingerprint, 'control: the stored fingerprint recomputes from the row');
        assert.equal((await m.getDetailedContext(CH)).evidence_status, 'refs_unavailable', 'control: the reader treats the row as ineligible');
        assert.equal(vecAt(r), 0, 'control: no vector before the write-back');
      },
      defect: async () => {
        const cmp = kgComparisonValue(rowAt(r));
        m.embeddingCache = new Map();
        const written = await m.reembedChunkByRowid(r);
        const state = `comparison value ${cmp}; backfill returned ${written}, vector ${vecAt(r)}`;
        defect(written === false && vecAt(r) === 0, `backfill wrote a vector for an ineligible row (${state})`);
        defect(cmp === null, `comparison value not null for an ineligible row (${state})`);
        defect(one(`SELECT provenance_state s FROM chunk_metadata WHERE rowid = ?`, r).s !== 'verified', 'row stamped verified');
      },
    });
  };
  await a2Case('evidence_refs []', []);
  await a2Case('malformed ref (chunk_id not a string)', [{ ...docRef, document_id: 'grd', chunk_text_sha256: sha(DOC), chunk_id: 123 }]);

  // ---- A1 ----
  // The real totals, computed the same way as the coordinator snapshot.
  const realCoverage = () => ({
    chunk: [one(`SELECT count(*) n FROM chunk_metadata`).n,
            one(`SELECT count(*) n FROM chunk_metadata m JOIN chunks v ON v.rowid = m.rowid WHERE m.provenance_state IN ('verified','legacy_assumed')`).n],
    entity: [one(`SELECT count(*) n FROM entities`).n,
             one(`SELECT count(*) n FROM entity_embedding_metadata m JOIN entity_embeddings v ON v.rowid = m.rowid WHERE m.provenance_state IN ('verified','legacy_assumed')`).n],
  });
  await redCase('A1 coverage matches the real totals right after deleteEntities', {
    control: async () => {
      await m.createEntities([{ name: 'Grd Gone', entityType: 'CONCEPT', observations: ['[2026-01-01] gone'] }]);
      // one unembedded entity, so the cached graph coverage is below 100 and the delete changes it
      const em = one(`SELECT rowid FROM entity_embedding_metadata WHERE entity_id = 'entity_grd_gone'`);
      assert.ok(em, 'control: Grd Gone was embedded');
      db.exec(`DELETE FROM entity_embeddings WHERE rowid = ${Number(em.rowid)}`);
      m.coordinator.invalidateCoverage();
      // cancel the debounced backfill kick so it cannot refresh the snapshot behind the writer
      if (m.coordinator?.kickTimer) { clearTimeout(m.coordinator.kickTimer); m.coordinator.kickTimer = null; }
      const s = await m.hybridSearch('zqxgrd61', 10, false);   // caches the snapshot
      const c = m.coordinator.coverage();
      const real = realCoverage();
      assert.deepEqual([c.entity.total, c.entity.embedded], real.entity, 'control: snapshot = real before the delete');
      assert.ok(real.entity[1] < real.entity[0], 'control: one entity is unembedded');
      assert.ok(s.coverage.graph_coverage_pct < 100, `control: cached graph_coverage_pct ${s.coverage.graph_coverage_pct}`);
    },
    defect: async () => {
      if (m.coordinator?.kickTimer) { clearTimeout(m.coordinator.kickTimer); m.coordinator.kickTimer = null; }
      await m.deleteEntities(['Grd Gone']);
      fixture(one(`SELECT count(*) n FROM entities WHERE id = 'entity_grd_gone'`).n === 0, 'the entity was deleted');
      const real = realCoverage();
      const c = m.coordinator.coverage();
      defect(c.entity.total === real.entity[0] && c.entity.embedded === real.entity[1],
        `coverage().entity ${c.entity.embedded}/${c.entity.total}, real ${real.entity[1]}/${real.entity[0]} (stale snapshot)`);
      defect(c.chunk.total === real.chunk[0] && c.chunk.embedded === real.chunk[1], `coverage().chunk ${c.chunk.embedded}/${c.chunk.total}, real ${real.chunk[1]}/${real.chunk[0]}`);
      const s = await m.hybridSearch('zqxgrd61', 10, false);
      const pct = real.entity[0] > 0 ? Math.round((real.entity[1] / real.entity[0]) * 100) : 100;
      defect(s.coverage.graph_coverage_pct === pct, `search envelope graph_coverage_pct ${s.coverage.graph_coverage_pct}, real ${pct}`);
    },
  });
  // Precision: deleting a name that does not exist deletes nothing; the snapshot may stay cached.
  { const before = JSON.stringify(m.coordinator.coverage());
    await m.deleteEntities(['Grd Never Existed']);
    assert.equal(JSON.stringify(m.coordinator.coverage()), before, 'a no-op delete changes no totals');
    console.log('  PASS no-op deleteEntities: totals unchanged'); }

  console.log(process.exitCode ? 'kg-evidence-guards: FAIL' : 'kg-evidence-guards: ALL PASS');
} finally { cleanup(); }
