#!/usr/bin/env node
// kg-relation-evidence D2④ (C1 RED, fixed in Task 6): 6.4.0 getDetailedContext joins documents with an
// INNER JOIN (index.ts:4433-4460), so every KG chunk hit fails there, while hybridSearch reports
// full_context_available: true unconditionally (index.ts:4387). Contract: KG chunks resolve to a
// type-appropriate detail; full_context_available means "the stored body can be resolved".
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';
import { redCase, defect, fixture, expectDefectError } from './helpers/red-case.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const { manager: m, cleanup } = await makeManager();
try {
  const db = m.db;
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  installFakeEmbedder(m);
  await m.startReconciliation(); // fresh DB -> 'n/a', opens the coordinator eligibility barrier so vector search runs
  await m.createEntities([
    { name: 'Zqxdetail Alpha', entityType: 'CONCEPT', observations: ['[2026-01-01] alpha fact'] },
    { name: 'Zqxdetail Beta', entityType: 'CONCEPT', observations: ['[2026-01-01] beta fact'] },
  ]);
  await m.createRelations([{ from: 'Zqxdetail Alpha', to: 'Zqxdetail Beta', relationType: 'LINKS' }]);
  const relId = one(`SELECT id FROM relationships`).id;
  const relChunk = `kg_relationship_${relId}`;
  const entChunk = 'kg_entity_entity_zqxdetail_alpha';
  await m.generateKnowledgeGraphChunks();
  await m.embedKnowledgeGraphChunks();   // every chunk has a vector -> chunk coverage 100% -> 'hybrid'
  const relText = one(`SELECT text FROM chunk_metadata WHERE chunk_id = ?`, relChunk)?.text;
  // The search controls must run the vector side: without startReconciliation the coordinator is not
  // eligible and hybridSearch silently degrades to FTS ('fts-only'), which proves nothing about
  // hybridSearch -> fixture() = NOT-RUN, never PASS. Every chunk is embedded above, so 'hybrid'.
  const search = async (q) => {
    const r = await m.hybridSearch(q, 10, false);
    fixture(r.search_mode === 'hybrid', `vector side active: search_mode=${r.search_mode} (expected 'hybrid')`);
    return r;
  };
  const hit = async (q, chunkId) => (await search(q)).results.find(x => x.chunk_id === chunkId);

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
  // ---- C4 (Task 6). States other than "all resolved" are produced with raw SQL on purpose: a reader
  // meets them when a writer that does not invalidate (another engine build on the same file, or a
  // hand edit) changed a source. The reader must not assume invalidation always ran.
  // Run through redCase so a degraded search ('fts-only') or an unmet fixture is NOT-RUN, never PASS,
  // and so the 6.4.0 "not found" on the first KG detail call is RED (the D2④ defect), not a crash.
  await redCase('C4 getDetailedContext document/entity/relationship detail + search availability', {
    control: async () => {
      // Fresh state: the three cases above left two entities, their KG chunks and an orphan
      // relationship chunk (its row was deleted raw, so no writer removed the chunk). Remove them all
      // so nothing below depends on what those cases did.
      await m.deleteEntities(['Zqxdetail Alpha', 'Zqxdetail Beta']);
      await m.generateKnowledgeGraphChunks();   // rebuild from rows = every KG chunk dropped, the orphan included
      for (const t of ['entities', 'relationships', 'entity_observations', 'documents', 'chunk_metadata', 'chunks']) {
        assert.equal(one(`SELECT count(*) n FROM ${t}`).n, 0, `control: fresh state, ${t} empty`);
      }
    },
    defect: async () => {
      const F = { formatVersion: 'evidence-v1' };
      await m.createEntities([
        { name: 'Zqxdetail Gamma', entityType: 'CONCEPT', observations: ['[2026-01-01] gamma notes zqxobs64'] },
        { name: 'Zqxdetail Delta', entityType: 'CONCEPT', observations: ['[2026-01-01] delta fact'] },
        { name: 'Zqxdetail Epsilon', entityType: 'CONCEPT', observations: ['[2026-01-01] epsilon first', '[2026-01-01] epsilon second'] },
      ]);
      await m.createRelations([{ from: 'Zqxdetail Gamma', to: 'Zqxdetail Delta', relationType: 'CITES' }]);
      const R = 'rel_entity_zqxdetail_gamma_cites_entity_zqxdetail_delta';
      const CH = `kg_relationship_${R}`;
      const DOC = 'Detail note: Zqxdetail Gamma cites Zqxdetail Delta via zqxquote63.';
      await m.syncDocumentFromFile('/detail.md', 'detail', { content: DOC });
      const q = 'Zqxdetail Gamma cites Zqxdetail Delta via zqxquote63.';
      const start = [...DOC.slice(0, DOC.indexOf(q))].length;
      const ref = { kind: 'document', chunk_id: 'detail_chunk_0', start, end: start + [...q].length, quote_sha256: sha(q) };
      const oid = one(`SELECT observation_id FROM entity_observations WHERE content LIKE '%zqxobs64%'`).observation_id;
      const oContent = one(`SELECT content FROM entity_observations WHERE observation_id = ?`, oid).content;
      const oref = { kind: 'observation', observation_id: oid, revision_no: 1, content_sha256: sha(oContent) };
      const regen = () => m.generateRelationEvidenceChunks([{ relationship_id: R, evidence: [ref, oref] }], F);
      const statuses = (d) => d.evidence_refs.map(r => r.status);

      // document detail: string fields and shape unchanged. Placed first so it also runs on 6.4.0 and
      // proves the expected key list IS 6.4.0's. The list is the return literal of getDetailedContext in
      // the base commit 7ac45b3 (index.ts:4510-4518: chunk_id, document_id, full_text, document_title,
      // surrounding_chunks, entities, metadata); surrounding_chunks is always set as a key (undefined for
      // a one-chunk document, base index.ts:4515).
      const dd = await m.getDetailedContext('detail_chunk_0');
      assert.deepEqual(Object.keys(dd).sort(), ['chunk_id', 'document_id', 'document_title', 'entities', 'full_text', 'metadata', 'surrounding_chunks']);
      assert.equal(typeof dd.document_id, 'string'); assert.equal(typeof dd.document_title, 'string'); assert.equal(dd.full_text, DOC);
      assert.equal(dd.document_id, 'detail'); assert.equal(dd.chunk_id, 'detail_chunk_0'); assert.equal(dd.surrounding_chunks, undefined);
      assert.ok(Array.isArray(dd.entities)); assert.equal(typeof dd.metadata, 'object');
      assert.ok(!('source_kind' in dd) && !('evidence_status' in dd), 'the document branch gains no KG fields');
      console.log('  PASS C4 document detail shape unchanged');

      // entity: active observations only; a superseded revision does not appear
      const e1 = one(`SELECT observation_id FROM entity_observations WHERE content = '[2026-01-01] epsilon first'`).observation_id;
      await m.correctObservation(e1, '[2026-01-01] epsilon first, corrected');
      await m.generateKnowledgeGraphChunks();
      // 6.4.0: the INNER JOIN on documents throws "not found" for every KG chunk — that throw IS the defect
      const de = await expectDefectError(() => m.getDetailedContext('kg_entity_entity_zqxdetail_epsilon'), /not found/, 'KG entity chunk has no detail');
      assert.deepEqual(de.entity.observations.map(o => o.content), ['[2026-01-01] epsilon first, corrected', '[2026-01-01] epsilon second']);
      assert.ok(!JSON.stringify(de).includes('"[2026-01-01] epsilon first"'), 'a superseded revision leaked into entity detail');
      console.log('  PASS C4 entity detail = active observations only');

      // evidence-v1, every reference matches now
      await regen();
      let d = await m.getDetailedContext(CH);
      assert.equal(d.evidence_status, 'refs_available'); assert.deepEqual(statuses(d), ['available', 'available']);
      assert.equal(d.evidence_refs[0].text, q); assert.equal(d.evidence_refs[1].text, oContent);
      assert.equal(d.document_id, null); assert.equal(d.document_title, null); assert.equal(d.source_kind, 'relationship'); assert.equal(d.source_id, R);
      assert.deepEqual(d.support, { why_status: 'unjudged', valid_time: null, scope_note: null });
      const body = d.full_text;
      console.log('  PASS C4 refs_available');

      // one reference missing (cited document chunk removed behind the writers' back)
      const dr = one(`SELECT rowid FROM chunk_metadata WHERE chunk_id = 'detail_chunk_0'`).rowid;
      db.exec(`DELETE FROM chunks WHERE rowid = ${Number(dr)}`); db.prepare(`DELETE FROM chunk_metadata WHERE rowid = ?`).run(dr);
      d = await m.getDetailedContext(CH);
      assert.equal(d.evidence_status, 'refs_unavailable'); assert.deepEqual(statuses(d), ['missing', 'available']);
      assert.equal(d.evidence_refs[0].text, null); assert.equal(d.full_text, body, 'the stored body is still readable');
      // search control: every remaining chunk gets a vector (the regenerated KG rows have none yet), so
      // chunk coverage is 100% and the vector side must run ('hybrid'); 'fts-only' = NOT-RUN
      await m.embedKnowledgeGraphChunks();
      const hs = await m.hybridSearch('zqxquote63', 10, false);
      fixture(hs.search_mode === 'hybrid', `vector side active: search_mode=${hs.search_mode} (expected 'hybrid')`);
      const h = hs.results.find(x => x.chunk_id === CH);
      assert.equal(h?.full_context_available, true, 'body resolvable + refs_unavailable is a normal combination');
      db.prepare(`DELETE FROM documents WHERE id = 'detail'`).run();
      await m.syncDocumentFromFile('/detail.md', 'detail', { content: DOC });
      await regen();

      // content mismatch on the cited chunk
      db.prepare(`UPDATE chunk_metadata SET text = ? WHERE chunk_id = 'detail_chunk_0'`).run(DOC + ' edited');
      d = await m.getDetailedContext(CH);
      assert.equal(d.evidence_status, 'refs_unavailable'); assert.deepEqual(statuses(d), ['mismatch', 'available']);
      db.prepare(`UPDATE chunk_metadata SET text = ? WHERE chunk_id = 'detail_chunk_0'`).run(DOC);

      // inactive / historical revision = mismatch, never available
      for (const st of ['retracted', 'superseded']) {
        db.prepare(`UPDATE entity_observations SET status = ? WHERE observation_id = ?`).run(st, oid);
        d = await m.getDetailedContext(CH);
        assert.equal(d.evidence_status, 'refs_unavailable', `status ${st}`); assert.deepEqual(statuses(d), ['available', 'mismatch'], `status ${st}`);
        db.prepare(`UPDATE entity_observations SET status = 'active' WHERE observation_id = ?`).run(oid);
      }
      // revision mismatch: the stored ref names revision 1, the row now says 2 (simulated by editing the ref)
      const meta = JSON.parse(one(`SELECT metadata FROM chunk_metadata WHERE chunk_id = ?`, CH).metadata);
      db.prepare(`UPDATE chunk_metadata SET metadata = ? WHERE chunk_id = ?`).run(JSON.stringify({ ...meta, evidence_refs: [meta.evidence_refs[0], { ...meta.evidence_refs[1], revision_no: 2 }] }), CH);
      d = await m.getDetailedContext(CH);
      assert.deepEqual(statuses(d), ['available', 'mismatch'], 'revision mismatch');
      // the source list changed
      await regen();
      db.prepare(`INSERT INTO observation_sources (observation_id, source_kind, source_ref, source_hash, recorded_at) VALUES (?, 'conversation', 'chat-1', NULL, '2026-01-02')`).run(oid);
      d = await m.getDetailedContext(CH);
      assert.deepEqual(statuses(d), ['available', 'mismatch'], 'changed source list');
      db.prepare(`DELETE FROM observation_sources WHERE observation_id = ? AND source_ref = 'chat-1'`).run(oid);
      // malformed / empty reference list on an evidence-v1 chunk is never refs_available
      await regen();
      const meta2 = JSON.parse(one(`SELECT metadata FROM chunk_metadata WHERE chunk_id = ?`, CH).metadata);
      db.prepare(`UPDATE chunk_metadata SET metadata = ? WHERE chunk_id = ?`).run(JSON.stringify({ ...meta2, evidence_refs: [] }), CH);
      d = await m.getDetailedContext(CH);
      assert.equal(d.evidence_status, 'refs_unavailable'); assert.deepEqual(d.evidence_refs, []);
      console.log('  PASS C4 refs_unavailable: missing · content mismatch · retracted · superseded · revision · sources · empty list');

      // R4: NON-empty malformed references -> that ref is 'mismatch', the others stay resolved, never a TypeError
      await regen();
      const good = JSON.parse(one(`SELECT metadata FROM chunk_metadata WHERE chunk_id = ?`, CH).metadata);
      const setRefs = (refs) => db.prepare(`UPDATE chunk_metadata SET metadata = ? WHERE chunk_id = ?`).run(JSON.stringify({ ...good, evidence_refs: refs }), CH);
      const [docOk, obsOk] = good.evidence_refs;
      for (const [label, bad] of [
        ['sources [null]', { ...obsOk, sources: [null] }],
        ['source tuple with a numeric kind', { ...obsOk, sources: [{ source_kind: 7, source_ref: 'x', source_hash: null }] }],
        ['source tuple without source_hash', { ...obsOk, sources: [{ source_kind: 'document', source_ref: 'x' }] }],
        ['sources not an array', { ...obsOk, sources: 'none' }],
        ['empty object', {}],
        ['unknown kind', { kind: 'url', href: 'https://example.invalid' }],
        ['null entry', null],
        ['document ref with a string start', { ...docOk, start: String(docOk.start) }],
        ['document ref without chunk_id', { ...docOk, chunk_id: undefined }],
      ]) {
        setRefs([docOk, bad]);
        d = await m.getDetailedContext(CH);
        assert.equal(d.evidence_status, 'refs_unavailable', `R4 ${label}`);
        assert.deepEqual(statuses(d), ['available', 'mismatch'], `R4 ${label}`);
      }
      setRefs([docOk, obsOk]);
      assert.equal((await m.getDetailedContext(CH)).evidence_status, 'refs_available', 'R4 positive: the well-formed refs resolve again');
      console.log('  PASS C4/R4 malformed references -> mismatch ([null] sources, bad tuples, {}, unknown kind, null, bad document fields)');

      // a variant that marks "body readable" as evidence-verified is rejected: the legacy triplet above
      // was full_context_available true AND claim_only (first case of this file) — assert it once more here
      await m.generateKnowledgeGraphChunks();
      const legacy = await m.getDetailedContext(CH);
      assert.equal(legacy.evidence_status, 'claim_only', 'a readable triplet body must not report refs_available');

      // entity row gone: detail fails like an unknown chunk, search false
      // search control: the regenerated KG rows get vectors -> coverage 100% -> 'hybrid'; 'fts-only' = NOT-RUN
      await m.embedKnowledgeGraphChunks();
      db.prepare(`DELETE FROM entities WHERE id = 'entity_zqxdetail_epsilon'`).run();
      const hse = await m.hybridSearch('epsilon', 10, false);
      fixture(hse.search_mode === 'hybrid', `vector side active: search_mode=${hse.search_mode} (expected 'hybrid')`);
      const he = hse.results.find(x => x.chunk_id === 'kg_entity_entity_zqxdetail_epsilon');
      assert.ok(he, 'the orphan entity chunk is still an FTS candidate');
      assert.equal(he.full_context_available, false);
      assert.equal(he.document_title, 'Knowledge Graph Entity', 'search title unchanged');
      await assert.rejects(() => m.getDetailedContext('kg_entity_entity_zqxdetail_epsilon'), /not found/);
      console.log('  PASS C4 entity row gone: detail fails, search false');
    },
  });
  console.log(process.exitCode ? 'kg-detail-context: FAIL' : 'kg-detail-context: ALL PASS');
} finally { cleanup(); }
