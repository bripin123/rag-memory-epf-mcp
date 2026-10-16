#!/usr/bin/env node
// kg-relation-evidence C3 (D2③): every writer that changes a cited observation or document removes the
// evidence chunk from search immediately — vector, FTS and getDetailedContext all clean — in the same
// transaction as the change. No regeneration: the caller generates again (Q2).
// Each writer is its own C1 case (test/helpers/red-case.mjs): the control proves the evidence chunk is
// live on the vector AND FTS side (search_mode 'hybrid' — an 'fts-only' control is NOT-RUN, never PASS);
// a writer that leaves it behind is RED. Fixture restores run after every case, whatever the verdict.
// R-B (2_ RESULT-T7-TXN-2_): the document primitives bind collect + chunk/evidence removal + the source
// change in ONE synchronous transaction — the C→G→A interleaving and the post-cleanup failure cases.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';
import { redCase, defect, fixture } from './helpers/red-case.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const F = { formatVersion: 'evidence-v1' };
const eid = (n) => `entity_${n.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;
const { manager: m, cleanup } = await makeManager();
try {
  const db = m.db;
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const counter = installFakeEmbedder(m);
  await m.startReconciliation(); // fresh DB -> 'n/a': opens the eligibility barrier so the vector side runs (R-1)
  const D = '[2026-01-01] ';
  const createAll = async () => {
    await m.createEntities([
      { name: 'Inv Source', entityType: 'ORG', observations: [`${D}source note`] },
      { name: 'Inv Target', entityType: 'ORG', observations: [`${D}target holds zqxcited71`, `${D}target unrelated note`],
        sources: [{ source_kind: 'document', source_ref: 'inv-doc', source_hash: null }] },
      { name: 'Inv Witness', entityType: 'PERSON', observations: [`${D}witness saw zqxwitness72`] },
    ]);
    await m.createRelations([{ from: 'Inv Source', to: 'Inv Target', relationType: 'BACKS' }]);
  };
  await createAll();
  const REL = `rel_${eid('Inv Source')}_BACKS_${eid('Inv Target')}`.toLowerCase();
  const CHUNK = `kg_relationship_${REL}`;
  const DOC = 'Inv doc: Inv Source backs Inv Target with zqxquote73.';
  const Q = 'Inv Source backs Inv Target with zqxquote73.';
  await m.syncDocumentFromFile('/inv.md', 'inv-doc', { content: DOC });
  const vecAt = (r) => one(`SELECT count(*) n FROM chunks WHERE rowid = ${Number(r)}`).n;
  const ftsRowids = (t) => db.prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?`).all(`"${t}"`).map(r => r.rowid);
  const obsLike = (name, token) => one(`SELECT observation_id, revision_no, content FROM entity_observations WHERE entity_id = ? AND status = 'active' AND content LIKE ?`, eid(name), `%${token}%`);
  const obsRef = (o) => ({ kind: 'observation', observation_id: o.observation_id, revision_no: o.revision_no, content_sha256: sha(o.content) });
  const docRef = () => { const t = one(`SELECT text FROM chunk_metadata WHERE chunk_id = 'inv-doc_chunk_0'`).text; const s = [...t.slice(0, t.indexOf(Q))].length;
    return { kind: 'document', chunk_id: 'inv-doc_chunk_0', start: s, end: s + [...Q].length, quote_sha256: sha(Q) }; };
  const items = (targetToken = 'zqxcited71') => [{ relationship_id: REL, evidence: [docRef(), obsRef(obsLike('Inv Target', targetToken)), obsRef(obsLike('Inv Witness', 'zqxwitness72'))] }];
  // Every relationship row whose evidence metadata names inv-doc (the C→G→A check scans all of them).
  const evidenceCitingDoc = () => all(`SELECT chunk_id, metadata FROM chunk_metadata WHERE chunk_type = 'relationship'`)
    .filter(r => { try { return (JSON.parse(r.metadata ?? 'null')?.evidence_refs ?? []).some(x => x?.document_id === 'inv-doc'); } catch { return false; } })
    .map(r => r.chunk_id);
  // R-1: the vector side must be live. 'hybrid-partial' is accepted only where a case deliberately
  // leaves rows unembedded (partialOk), and says so.
  const searchMode = (r, label, partialOk = false) => {
    fixture(r.search_mode !== 'fts-only', `${label}: search_mode is fts-only — the vector side did not run`);
    fixture(r.search_mode === 'hybrid' || (partialOk && r.search_mode === 'hybrid-partial'), `${label}: search_mode ${r.search_mode}`);
  };
  const fresh = async (token) => {
    await m.generateRelationEvidenceChunks(items(token), F);
    m.embeddingCache = new Map();
    await m.embedKnowledgeGraphChunks();
    const row = one(`SELECT rowid FROM chunk_metadata WHERE chunk_id = ?`, CHUNK);
    assert.ok(row, 'control: evidence chunk generated');
    assert.equal(vecAt(row.rowid), 1, 'control: the evidence chunk has a vector');
    assert.ok(ftsRowids('zqxquote73').includes(row.rowid), 'control: FTS finds it');
    const s = await m.hybridSearch('zqxquote73', 10, false);
    assert.equal(s.search_mode, 'hybrid', 'control: search_mode hybrid (fts-only = the vector side did not run)');
    const hit = s.results.find(x => x.chunk_id === CHUNK);
    assert.ok(hit, 'control: hybridSearch returns it');
    // rank fusion (useGraph:false, summaries off): relevance = 1/(60+vector rank) + fts_boost, so a score
    // above fts_boost means the chunk was also a vector candidate. vector_similarity is clipped at 0 for
    // the stub model's unnormalised vectors, so it cannot show this.
    assert.ok(hit.relevance_score > (hit.fts_boost ?? 0) + 1e-12, `control: returned through the vector side too (score ${hit.relevance_score}, fts_boost ${hit.fts_boost})`);
    assert.equal((await m.getDetailedContext(CHUNK)).evidence_status, 'refs_available', 'control: detail resolves every reference');
    return row.rowid;
  };
  // Direct row checks first (metadata, vector, FTS index), then search and detail.
  const assertGone = async (label, oldRowid, { partialOk = false } = {}) => {
    defect(one(`SELECT count(*) n FROM chunk_metadata WHERE chunk_id = ?`, CHUNK).n === 0, `${label}: evidence chunk metadata left`);
    const reused = one(`SELECT chunk_id FROM chunk_metadata WHERE rowid = ?`, oldRowid);
    if (!reused) defect(vecAt(oldRowid) === 0, `${label}: orphan vector left at rowid ${oldRowid}`);
    for (const token of ['zqxquote73', 'zqxwitness72']) {
      for (const r of ftsRowids(token)) defect((one(`SELECT chunk_id FROM chunk_metadata WHERE rowid = ?`, r)?.chunk_id ?? null) !== CHUNK, `${label}: FTS (${token}) still points at it`);
      defect(reused || !ftsRowids(token).includes(oldRowid), `${label}: stale FTS row (${token}) at rowid ${oldRowid}`);
    }
    const s = await m.hybridSearch('zqxquote73', 10, false);
    searchMode(s, label, partialOk);
    defect(!s.results.some(x => x.chunk_id === CHUNK), `${label}: hybridSearch still returns it`);
    // Only "not found" is the expected absence. Detail returning normally = the stale body is still
    // readable (RED); any other error is re-thrown so redCase classifies it ERROR, never RED (review I2).
    let detailResolved = false;
    try { await m.getDetailedContext(CHUNK); detailResolved = true; }
    catch (e) { if (!/not found/.test(String(e?.message))) throw e; }
    defect(!detailResolved, `${label}: detail still resolves`);
  };
  // One writer = one C1 case; `after` restores the fixture whatever the verdict.
  const writerCase = async (name, { token = 'zqxnewfact74', act, after, partialOk = false }) => {
    let r;
    await redCase(`invalidated by ${name}`, {
      control: async () => { r = await fresh(token); },
      defect: async () => { await act(r); await assertGone(name, r, { partialOk }); },
    });
    if (after) {
      try { await after(r); }
      catch (e) { process.exitCode = 1; console.log(`  ERROR fixture restore after ${name}: ${e?.message}`); }
    }
  };
  const setStatus = (oid, st) => db.prepare(`UPDATE entity_observations SET status = ? WHERE observation_id = ?`).run(st, oid);
  // P42: importGraph's INSERT OR REPLACE cascade-deletes the document chunk metadata and leaves its vec0
  // vector (an out-of-scope defect, reported); drop vectors with no metadata row before re-syncing, as
  // kg-evidence-cas does, or the next INSERT at that rowid fails on the vec0 primary key.
  const dropOrphanVectors = () => {
    const meta = new Set(all(`SELECT rowid FROM chunk_metadata`).map(r => r.rowid));
    for (const { rowid } of all(`SELECT rowid FROM chunks`)) if (!meta.has(rowid)) db.exec(`DELETE FROM chunks WHERE rowid = ${Number(rowid)}`);
  };
  // Back to one embedded inv-doc chunk with DOC, whatever state a RED case left.
  const resetDoc = async () => {
    await m.deleteDocuments('inv-doc');
    dropOrphanVectors();
    await m.syncDocumentFromFile('/inv.md', 'inv-doc', { content: DOC });
    assert.equal(vecAt(one(`SELECT rowid FROM chunk_metadata WHERE chunk_id = 'inv-doc_chunk_0'`).rowid), 1, 'fixture restore: inv-doc_chunk_0 embedded');
  };

  // relationship delete
  await writerCase('deleteRelations', { token: 'zqxcited71',
    act: () => m.deleteRelations([{ from: 'Inv Source', to: 'Inv Target', relationType: 'BACKS' }]),
    after: () => m.createRelations([{ from: 'Inv Source', to: 'Inv Target', relationType: 'BACKS' }]) });
  // correct + the caller regenerates with the new revision -> the new fact is retrieved
  await writerCase('correctObservation', { token: 'zqxcited71',
    act: async () => { const o = obsLike('Inv Target', 'zqxcited71'); await m.correctObservation(o.observation_id, `${D}target holds zqxcited71 and zqxnewfact74`); } });
  await redCase('regeneration after correction retrieves the new fact', {
    control: async () => { await fresh('zqxnewfact74'); },
    defect: async () => {
      const s = await m.hybridSearch('zqxnewfact74', 10, false);
      searchMode(s, 'regeneration');
      defect(s.results.some(x => x.chunk_id === CHUNK), 'regenerated evidence does not answer the new fact');
    },
  });
  // retract (then restore so the observation can be cited again)
  await writerCase('retractObservation', {
    act: async () => { await m.retractObservation(obsLike('Inv Target', 'zqxnewfact74').observation_id, 'test'); },
    after: async () => { const o = one(`SELECT observation_id FROM entity_observations WHERE content LIKE '%zqxnewfact74%' AND status = 'retracted'`); if (o) await m.restoreObservation(o.observation_id, 'back'); } });
  // restore / approve / decline: generation only cites ACTIVE revisions, and these events never apply to
  // an active one (lifecycle.ts:119-125), so the cited state is planted with raw SQL to prove each
  // writer is wired; such a state arises when another writer changed the status behind this engine.
  await writerCase('restoreObservation (planted)', {
    act: async () => { const o = obsLike('Inv Target', 'zqxnewfact74'); setStatus(o.observation_id, 'retracted'); await m.restoreObservation(o.observation_id, 'r'); } });
  await writerCase('approveObservation (planted)', {
    act: async () => { const o = obsLike('Inv Target', 'zqxnewfact74'); setStatus(o.observation_id, 'provisional'); await m.approveObservation(o.observation_id, 'a'); } });
  await writerCase('declineObservation (planted)', {
    act: async () => { const o = obsLike('Inv Target', 'zqxnewfact74'); setStatus(o.observation_id, 'provisional'); await m.declineObservation(o.observation_id, 'd'); },
    after: async () => { const o = one(`SELECT observation_id FROM entity_observations WHERE content LIKE '%zqxnewfact74%' AND status = 'retracted'`); if (o) await m.restoreObservation(o.observation_id, 'back'); } });
  // purge; a purged reference is rejected on re-generation
  { let stale;
    await writerCase('purgeObservation', {
      act: async () => { const w = obsLike('Inv Witness', 'zqxwitness72'); stale = obsRef(w); await m.purgeObservation(w.observation_id, 'PURGE'); },
      after: async () => {
        await assert.rejects(() => m.generateRelationEvidenceChunks([{ relationship_id: REL, evidence: [stale] }], F), (e) => e.code === 'unknown-observation');
        console.log('  PASS purged reference rejected on regeneration');
        await m.addObservations([{ entityName: 'Inv Witness', contents: [`${D}witness saw zqxwitness72`] }]);
      } }); }
  // source-only dedup on a cited observation (both writers that reach it)
  await writerCase('addObservations source-only dedup', {
    act: async () => { const o = obsLike('Inv Target', 'zqxnewfact74');
      const res = await m.addObservations([{ entityName: 'Inv Target', contents: [o.content], sources: [{ source_kind: 'decision', source_ref: 'dec-1' }] }]);
      fixture(JSON.stringify(res[0].observation_ids) === '[null]', 'dedup, no new revision'); } });
  await writerCase('createEntities source-only dedup', {
    act: async () => { const o = obsLike('Inv Target', 'zqxnewfact74');
      await m.createEntities([{ name: 'Inv Target', entityType: 'ORG', observations: [o.content], sources: [{ source_kind: 'decision', source_ref: 'dec-2' }] }]); } });
  // precision: writers that do not touch a cited observation leave the chunk alone
  { const r = await fresh('zqxnewfact74');
    await m.addObservations([{ entityName: 'Inv Target', contents: [`${D}a new unrelated fact`] }]);
    const o = obsLike('Inv Target', 'zqxnewfact74');
    await m.addObservations([{ entityName: 'Inv Target', contents: [o.content], sources: [{ source_kind: 'decision', source_ref: 'dec-2' }] }]);  // already linked: adds nothing
    assert.equal(one(`SELECT rowid FROM chunk_metadata WHERE chunk_id = ?`, CHUNK)?.rowid, r, 'an unrelated observation write invalidated the chunk');
    assert.equal(vecAt(r), 1);
    console.log('  PASS unrelated observation writes do not invalidate'); }
  // R4: planted evidence rows holding a malformed entry are removed by ANY writer that runs a lookup (here a
  // correction of an observation they do not cite); the well-formed row next to them is not.
  { const BAD = ['bad_empty_obj', 'bad_unknown_kind', 'bad_sources', 'bad_empty_list'];
    let r;
    await redCase('R4: malformed evidence rows removed by any lookup; well-formed unrelated row kept', {
      control: async () => { r = await fresh('zqxnewfact74'); },
      defect: async () => {
        const other = obsLike('Inv Target', 'target unrelated note');
        const meta = JSON.parse(one(`SELECT metadata FROM chunk_metadata WHERE chunk_id = ?`, CHUNK).metadata);
        const plantBad = (id, refs) => db.prepare(`INSERT INTO chunk_metadata (chunk_id, chunk_type, relationship_id, chunk_index, text, start_pos, end_pos, metadata)
          VALUES (?, 'relationship', ?, 0, 'planted malformed evidence', 0, 26, ?)`).run(id, `rel_${id}`, JSON.stringify({ ...meta, relationship_id: `rel_${id}`, evidence_refs: refs }));
        plantBad('bad_empty_obj', [meta.evidence_refs[0], {}]);
        plantBad('bad_unknown_kind', [{ kind: 'url', href: 'x' }]);
        plantBad('bad_sources', [{ ...meta.evidence_refs[1], sources: [null] }]);
        plantBad('bad_empty_list', []);
        await m.correctObservation(other.observation_id, `${D}target unrelated note, corrected`);
        for (const id of BAD) defect(one(`SELECT count(*) n FROM chunk_metadata WHERE chunk_id = ?`, id).n === 0, `R4: malformed row ${id} survived a lookup`);
        assert.equal(one(`SELECT rowid FROM chunk_metadata WHERE chunk_id = ?`, CHUNK)?.rowid, r, 'R4: a well-formed row that does not cite the corrected observation must survive');
        assert.equal(vecAt(r), 1);
      },
    });
    // planted rows have no vector: left behind they would turn every later search 'hybrid-partial'
    for (const id of BAD) db.prepare(`DELETE FROM chunk_metadata WHERE chunk_id = ?`).run(id);
    m.coordinator?.invalidateCoverage(); }
  // documents: replace, re-chunk reusing ordinal ids, storeDocument, delete, import replace
  await writerCase('syncDocumentFromFile replace', {
    act: () => m.syncDocumentFromFile('/inv.md', 'inv-doc', { content: DOC + ' extra' }),
    after: resetDoc });
  // chunkDocument writes chunks without vectors: the post-change search is deliberately 'hybrid-partial'.
  await writerCase('chunkDocument re-chunk (reused ordinal id)', { partialOk: true,
    act: async () => { await m.chunkDocument('inv-doc'); fixture(one(`SELECT 1 x FROM chunk_metadata WHERE chunk_id = 'inv-doc_chunk_0'`), 'the ordinal id was reused'); },
    after: resetDoc });
  await writerCase('storeDocument replace', {
    act: () => m.storeDocument('inv-doc', DOC, {}),
    after: resetDoc });
  await writerCase('deleteDocuments', {
    act: async () => { const res = await m.deleteDocuments('inv-doc'); fixture(res.summary.deleted === 1, 'the document was deleted'); },
    after: resetDoc });
  await writerCase('importGraph document replace', {
    act: () => m.importGraph({ documents: [{ id: 'inv-doc', content: DOC, metadata: {} }] }),
    after: resetDoc });
  // import adding a source to a cited observation
  await writerCase('importGraph observation source', {
    act: async () => { const o = obsLike('Inv Target', 'zqxnewfact74');
      await m.importGraph({ observation_roots: [], observation_sources: [{ observation_id: o.observation_id, source_kind: 'decision', source_ref: 'imp-1', source_hash: null, recorded_at: '2026-01-02T00:00:00.000Z' }] }); } });
  // deleting an entity that owns a cited observation (not an endpoint)
  await writerCase('deleteEntities (owner of a cited observation)', {
    act: () => m.deleteEntities(['Inv Witness']),
    after: () => m.createEntities([{ name: 'Inv Witness', entityType: 'PERSON', observations: [`${D}witness saw zqxwitness72`] }]) });
  // the deprecated deleteObservations shim (its own transaction, not mutateEntityAndInvalidate)
  { let oid;
    await writerCase('deleteObservations shim', {
      act: async () => { const o = obsLike('Inv Target', 'zqxnewfact74'); oid = o.observation_id; await m.deleteObservations([{ entityName: 'Inv Target', observations: [o.content] }]); },
      after: async () => { if (oid && one(`SELECT status FROM entity_observations WHERE observation_id = ?`, oid)?.status === 'retracted') await m.restoreObservation(oid, 'back'); } }); }

  // ---- R-B (2_ RESULT-T7-TXN-2_): document primitives are ONE synchronous transaction ----
  // (a) C→G→A: chunkDocument, then a queued generate citing the re-chunked D_chunk_0, then deleteDocument.
  // With an await between cleanup and the source change, G publishes fresh evidence after A's collection
  // and A's continuation deletes the document without it: stale evidence survives every call succeeding.
  { let r, outcomes = null;
    await redCase('R-B (a) C→G→A interleaving leaves no evidence citing the deleted document', {
      control: async () => { r = await fresh('zqxnewfact74'); },
      defect: async () => {
        const it = items('zqxnewfact74');
        const c = m.chunkDocument('inv-doc');
        const g = Promise.resolve().then(() => m.generateRelationEvidenceChunks(it, F));
        const a = m.deleteDocument('inv-doc');
        const settled = await Promise.allSettled([c, g, a]);
        outcomes = Object.fromEntries(['chunkDocument', 'generateRelationEvidenceChunks', 'deleteDocument'].map((k, i) =>
          [k, settled[i].status === 'fulfilled' ? 'fulfilled' : `rejected: ${settled[i].reason?.code ?? ''} ${settled[i].reason?.message ?? settled[i].reason}`.trim()]));
        console.log(`    C→G→A outcomes: ${JSON.stringify(outcomes)}`);
        fixture(settled[0].status === 'fulfilled' && settled[2].status === 'fulfilled', 'chunkDocument and deleteDocument both completed');
        fixture(one(`SELECT count(*) n FROM documents WHERE id = 'inv-doc'`).n === 0, 'deleteDocument removed the document');
        const citing = evidenceCitingDoc();
        defect(citing.length === 0, `evidence citing the deleted document survived: ${citing.join(', ')}`);
        await assertGone('C→G→A', r);
      },
    });
    try { await resetDoc(); } catch (e) { process.exitCode = 1; console.log(`  ERROR fixture restore after C→G→A: ${e?.message}`); } }
  // (b) a failure after cleanup rolls back cleanup too: the old chunks AND the old evidence stay, and the
  // failure surfaces to the caller.
  const failureCase = async (name, { inject, removeInjection, call, pattern }) => {
    let r, before;
    await redCase(`R-B (b) ${name}: old chunks and old evidence survive, failure surfaced`, {
      control: async () => {
        r = await fresh('zqxnewfact74');
        before = all(`SELECT rowid, chunk_id, text FROM chunk_metadata WHERE document_id = 'inv-doc' ORDER BY rowid`);
        assert.ok(before.length > 0 && before.every(x => vecAt(x.rowid) === 1), 'control: inv-doc chunks embedded');
      },
      defect: async () => {
        inject();
        let surfaced = null;
        try { await call(); } catch (e) { surfaced = e; } finally { removeInjection(); }
        fixture(surfaced && pattern.test(String(surfaced.message)), `the injected failure surfaced (got ${surfaced ? surfaced.message : 'success'})`);
        const now = all(`SELECT rowid, chunk_id, text FROM chunk_metadata WHERE document_id = 'inv-doc' ORDER BY rowid`);
        defect(JSON.stringify(now) === JSON.stringify(before), `old document chunks changed: ${JSON.stringify(now.map(x => [x.rowid, x.chunk_id]))} vs ${JSON.stringify(before.map(x => [x.rowid, x.chunk_id]))}`);
        defect(now.every(x => vecAt(x.rowid) === 1), 'old document chunk vectors lost');
        defect(one(`SELECT rowid FROM chunk_metadata WHERE chunk_id = ?`, CHUNK)?.rowid === r, 'old evidence chunk lost');
        defect(vecAt(r) === 1, 'old evidence vector lost');
        defect(ftsRowids('zqxquote73').includes(r), 'old evidence FTS row lost');
        defect((await m.getDetailedContext(CHUNK)).evidence_status === 'refs_available', 'old evidence no longer resolves');
      },
    });
    try { await resetDoc(); } catch (e) { process.exitCode = 1; console.log(`  ERROR fixture restore after ${name}: ${e?.message}`); }
  };
  { const orig = m.chunkStructured;
    await failureCase('chunkDocument: chunking throws', {
      inject: () => { m.chunkStructured = () => { throw new Error('t7 injected chunking failure'); }; },
      removeInjection: () => { m.chunkStructured = orig; },
      call: () => m.chunkDocument('inv-doc'), pattern: /t7 injected chunking failure/ }); }
  const trigger = (sql) => ({ inject: () => db.exec(sql), removeInjection: () => db.exec(`DROP TRIGGER IF EXISTS t7_inject`) });
  await failureCase('chunkDocument: the signature UPDATE fails after every chunk INSERT', {
    ...trigger(`CREATE TEMP TRIGGER t7_inject BEFORE UPDATE OF chunking_signature ON main.documents WHEN NEW.id = 'inv-doc' BEGIN SELECT RAISE(ABORT, 't7 injected source failure'); END`),
    call: () => m.chunkDocument('inv-doc'), pattern: /t7 injected source failure/ });
  await failureCase('storeDocument: the documents REPLACE fails', {
    ...trigger(`CREATE TEMP TRIGGER t7_inject BEFORE INSERT ON main.documents WHEN NEW.id = 'inv-doc' BEGIN SELECT RAISE(ABORT, 't7 injected source failure'); END`),
    call: () => m.storeDocument('inv-doc', DOC + ' changed', {}), pattern: /t7 injected source failure/ });
  await failureCase('deleteDocument: the documents DELETE fails', {
    ...trigger(`CREATE TEMP TRIGGER t7_inject BEFORE DELETE ON main.documents WHEN OLD.id = 'inv-doc' BEGIN SELECT RAISE(ABORT, 't7 injected source failure'); END`),
    call: () => m.deleteDocument('inv-doc'), pattern: /t7 injected source failure/ });

  // ---- review I1: coverage after storeDocument / deleteDocument ----
  // The coordinator caches the coverage snapshot. A primitive that removes chunks and evidence must
  // invalidate it after its commit, or coverage and search_mode report the pre-change totals. Setup: one
  // unembedded document chunk (re-chunk) + one embedded evidence chunk citing it, read once so 1/2 is
  // cached; then the writer removes both (real total 0 -> 100%). The test never clears the cache itself.
  const realCoverage = () => {
    const total = one(`SELECT count(*) n FROM chunk_metadata`).n;
    const embedded = one(`SELECT count(*) n FROM chunk_metadata m JOIN chunks v ON v.rowid = m.rowid WHERE m.provenance_state IN ('verified','legacy_assumed')`).n;
    return { total, embedded, pct: total > 0 ? Math.round((embedded / total) * 100) : 100 };
  };
  const coverageCase = async (name, call) => {
    await redCase(`I1 coverage and search_mode match the real totals right after ${name}`, {
      control: async () => {
        await resetDoc();
        await m.chunkDocument('inv-doc');
        // test harness: cancel the debounced backfill kick so it cannot embed the chunk (and refresh the
        // snapshot) behind the writer — the RED must come from the writer, not from timer luck.
        if (m.coordinator?.kickTimer) { clearTimeout(m.coordinator.kickTimer); m.coordinator.kickTimer = null; }
        await m.generateRelationEvidenceChunks(items('zqxnewfact74'), F);
        m.embeddingCache = new Map();
        await m.embedKnowledgeGraphChunks();
        const s = await m.hybridSearch('zqxquote73', 10, false);   // caches the snapshot
        const real = realCoverage();
        assert.deepEqual([real.total, real.embedded], [2, 1], 'control: one unembedded document chunk + one embedded evidence chunk');
        assert.equal(s.search_mode, 'hybrid-partial', 'control: the partial state is visible');
        assert.equal(s.coverage.chunk_pct, 50, 'control: cached chunk_pct 50');
        const c = m.coordinator.coverage();
        assert.deepEqual([c.chunk.total, c.chunk.embedded], [2, 1], 'control: the snapshot holds 1/2');
      },
      defect: async () => {
        await call();
        const real = realCoverage();
        fixture(real.total === 0, `the writer removed the chunk and the evidence (real total ${real.total})`);
        const c = m.coordinator.coverage();
        defect(c.chunk.total === real.total && c.chunk.embedded === real.embedded,
          `coverage() reports ${c.chunk.embedded}/${c.chunk.total}, real ${real.embedded}/${real.total} (stale snapshot)`);
        const s = await m.hybridSearch('zqxquote73', 10, false);
        defect(s.coverage.chunk_pct === real.pct, `search envelope chunk_pct ${s.coverage.chunk_pct}, real ${real.pct}`);
        defect(s.search_mode === 'hybrid', `search_mode ${s.search_mode} with no unembedded chunk left`);
      },
    });
    try { await resetDoc(); } catch (e) { process.exitCode = 1; console.log(`  ERROR fixture restore after I1 ${name}: ${e?.message}`); }
  };
  await coverageCase('storeDocument', () => m.storeDocument('inv-doc', DOC, {}));
  await coverageCase('deleteDocument', async () => { fixture((await m.deleteDocument('inv-doc')).deleted === true, 'the document was deleted'); });

  // confidence-only update: metadata refreshed, zero re-embeds, fingerprint unchanged
  { const r = await fresh('zqxnewfact74');
    const before = one(`SELECT rowid, text, input_hash, metadata FROM chunk_metadata WHERE chunk_id = ?`, CHUNK);
    counter.calls = 0; m.embeddingCache = new Map();
    await m.updateRelations([{ from: 'Inv Source', to: 'Inv Target', relationType: 'BACKS', confidence: 0.4 }]);
    const after = one(`SELECT rowid, text, input_hash, metadata FROM chunk_metadata WHERE chunk_id = ?`, CHUNK);
    assert.equal(after.rowid, r); assert.equal(after.text, before.text); assert.equal(after.input_hash, before.input_hash);
    assert.equal(JSON.parse(after.metadata).confidence, 0.4);
    assert.equal(JSON.parse(after.metadata).input_fingerprint, JSON.parse(before.metadata).input_fingerprint, 'confidence is not a fingerprint input');
    assert.equal(vecAt(r), 1); assert.equal(counter.calls, 0, 'zero re-embeds');
    console.log('  PASS confidence-only update: metadata refreshed, zero re-embeds'); }
  console.log(process.exitCode ? 'kg-evidence-invalidation: FAIL' : 'kg-evidence-invalidation: ALL PASS');
} finally { cleanup(); }
