#!/usr/bin/env node
// kg-relation-evidence D2③ / C3, final-review I1: importGraph and its evidence dependency collection use
// ONE id contract. The collectors (src/kg/relation-evidence.ts) compare string ids strictly, while the
// INSERTs bind whatever the dump holds; SQLite stores a JS number bound to a TEXT column as its decimal
// text (7.5 -> '7.5'), so a numeric id can replace or extend the row of an existing string id the
// collector never matched. The contract is: a document id or an observation_sources observation_id that is
// not a string refuses the WHOLE import with no writes. No numeric normalisation.
// Cases (test/helpers/red-case.mjs): (a) a normal string-id import still removes the citing evidence chunk
// (metadata, vector, FTS) and that removal belongs to the import transaction; (b) a numeric document id
// and (c) a numeric observation_sources observation_id are refused with no writes.
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
  installFakeEmbedder(m);
  await m.startReconciliation();
  const D = '[2026-01-01] ';
  const TS = '2026-01-01T00:00:00.000Z';
  await m.createEntities([
    { name: 'Imp Source', entityType: 'ORG', observations: [`${D}source note`] },
    { name: 'Imp Target', entityType: 'ORG', observations: [`${D}target note`] },
  ]);
  await m.createRelations([{ from: 'Imp Source', to: 'Imp Target', relationType: 'BACKS' }]);
  const REL = `rel_${eid('Imp Source')}_BACKS_${eid('Imp Target')}`.toLowerCase();
  const CHUNK = `kg_relationship_${REL}`;
  // Ids that look numeric are the point: the number 7.5 is stored as the TEXT '7.5'.
  const DOC_ID = '7.5';
  const OBS_ID = '7.5';
  const DOC = 'Imp doc: Imp Source backs Imp Target with zqximpquote81.';
  const Q = 'Imp Source backs Imp Target with zqximpquote81.';
  await m.syncDocumentFromFile('/imp.md', DOC_ID, { content: DOC });
  await m.importGraph({
    observation_roots: [{ root_id: 'root_imp_75', entity_id: eid('Imp Target'), projection_order: 50, created_at: TS }],
    entity_observations: [{ observation_id: OBS_ID, root_id: 'root_imp_75', entity_id: eid('Imp Target'), revision_no: 1,
      projection_order: 50, content: `${D}target holds zqximpobs82`, status: 'active', supersedes_id: null, recorded_at: TS, superseded_at: null }],
  });
  assert.equal(one(`SELECT status FROM entity_observations WHERE observation_id = ?`, OBS_ID)?.status, 'active', 'fixture: observation 7.5 imported');

  const vecAt = (r) => one(`SELECT count(*) n FROM chunks WHERE rowid = ${Number(r)}`).n;
  const ftsRowids = (t) => all(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?`, `"${t}"`).map(r => r.rowid);
  const docRef = () => {
    const t = one(`SELECT text FROM chunk_metadata WHERE chunk_id = ?`, `${DOC_ID}_chunk_0`).text;
    const s = [...t.slice(0, t.indexOf(Q))].length;
    return { kind: 'document', chunk_id: `${DOC_ID}_chunk_0`, start: s, end: s + [...Q].length, quote_sha256: sha(Q) };
  };
  const obsRef = () => {
    const o = one(`SELECT observation_id, revision_no, content FROM entity_observations WHERE observation_id = ?`, OBS_ID);
    return { kind: 'observation', observation_id: o.observation_id, revision_no: o.revision_no, content_sha256: sha(o.content) };
  };
  const evidenceRow = () => one(`SELECT rowid, metadata FROM chunk_metadata WHERE chunk_id = ?`, CHUNK);
  // Control: a live evidence chunk citing document '7.5' and observation '7.5' (metadata, vector, FTS, detail).
  const fresh = async () => {
    await m.generateRelationEvidenceChunks([{ relationship_id: REL, evidence: [docRef(), obsRef()] }], F);
    m.embeddingCache = new Map();
    await m.embedKnowledgeGraphChunks();
    const row = evidenceRow();
    assert.ok(row, 'control: evidence chunk generated');
    const refs = JSON.parse(row.metadata).evidence_refs;
    assert.deepEqual(refs.map(r => r.document_id ?? r.observation_id), [DOC_ID, OBS_ID], 'control: cites the string ids');
    assert.equal(vecAt(row.rowid), 1, 'control: the evidence chunk has a vector');
    assert.ok(ftsRowids('zqximpquote81').includes(row.rowid), 'control: FTS finds it');
    assert.equal((await m.getDetailedContext(CHUNK)).evidence_status, 'refs_available', 'control: detail resolves every reference');
    return row.rowid;
  };
  // P42 (out of scope): the document INSERT OR REPLACE leaves the old document chunk vectors; drop vectors
  // without metadata before re-syncing so the next INSERT at that rowid does not hit the vec0 primary key.
  const dropOrphanVectors = () => {
    const meta = new Set(all(`SELECT rowid FROM chunk_metadata`).map(r => r.rowid));
    for (const { rowid } of all(`SELECT rowid FROM chunks`)) if (!meta.has(rowid)) db.exec(`DELETE FROM chunks WHERE rowid = ${Number(rowid)}`);
  };
  const resetDoc = async () => {
    await m.deleteDocuments(DOC_ID);
    dropOrphanVectors();
    await m.syncDocumentFromFile('/imp.md', DOC_ID, { content: DOC });
    assert.equal(one(`SELECT content FROM documents WHERE id = ?`, DOC_ID).content, DOC, 'fixture restore: document back');
  };
  const restore = async (label, fn) => {
    try { await fn(); } catch (e) { process.exitCode = 1; console.log(`  ERROR fixture restore after ${label}: ${e?.message}`); }
  };
  // Everything an import could have written, so "no writes" is a comparison, not a guess.
  const snapshot = () => JSON.stringify({
    documents: all(`SELECT id, typeof(id) t, content, metadata FROM documents ORDER BY id`),
    entities: all(`SELECT id FROM entities ORDER BY id`),
    relationships: all(`SELECT id FROM relationships ORDER BY id`),
    sources: all(`SELECT observation_id, typeof(observation_id) t, source_kind, source_ref FROM observation_sources ORDER BY 1, 3, 4`),
    observations: all(`SELECT observation_id, status FROM entity_observations ORDER BY 1`),
    chunks: all(`SELECT rowid, chunk_id, text FROM chunk_metadata ORDER BY rowid`),
    vectors: all(`SELECT rowid FROM chunks ORDER BY rowid`).map(r => r.rowid),
  });
  const PROBE = { id: 'entity_imp_probe', name: 'Imp Probe', entityType: 'ORG' };

  // (a) positive: a string-id document replace removes the citing evidence chunk in the import.
  { let r;
    await redCase('(a) string document id: import removes the citing evidence chunk (metadata, vector, FTS)', {
      control: async () => { r = await fresh(); },
      defect: async () => {
        await m.importGraph({ documents: [{ id: DOC_ID, content: DOC + ' changed', metadata: {} }] });
        fixture(one(`SELECT content FROM documents WHERE id = ?`, DOC_ID)?.content === DOC + ' changed', 'the import replaced the document');
        defect(!evidenceRow(), 'evidence chunk metadata left');
        const reused = one(`SELECT chunk_id FROM chunk_metadata WHERE rowid = ?`, r);
        if (!reused) defect(vecAt(r) === 0, `orphan evidence vector left at rowid ${r}`);
        for (const x of ftsRowids('zqximpquote81')) defect((one(`SELECT chunk_id FROM chunk_metadata WHERE rowid = ?`, x)?.chunk_id ?? null) !== CHUNK, 'FTS still points at the evidence chunk');
        defect(reused || !ftsRowids('zqximpquote81').includes(r), `stale FTS row at rowid ${r}`);
      },
    });
    await restore('(a)', resetDoc); }
  // (a') the removal is part of the import transaction: a failure after the evidence delete (injected in
  // the per-entity invalidation that runs after it) rolls the delete back with everything else.
  { let r, before;
    const orig = m.invalidateDerivedForEntity;
    await redCase('(a\') string document id: a failure after the evidence delete rolls it back', {
      control: async () => { r = await fresh(); before = snapshot(); },
      defect: async () => {
        // The same connection sees the open transaction, so this records that the evidence delete has
        // already happened when the failure fires (otherwise the rollback would prove nothing).
        let goneAtFailure = null;
        m.invalidateDerivedForEntity = () => { goneAtFailure = !evidenceRow() && vecAt(r) === 0; throw new Error('i1 injected failure after evidence delete'); };
        let surfaced = null;
        try { await m.importGraph({ entities: [{ id: eid('Imp Source'), name: 'Imp Source', entityType: 'ORG' }],
          documents: [{ id: DOC_ID, content: DOC + ' changed', metadata: {} }] }); }
        catch (e) { surfaced = e; } finally { m.invalidateDerivedForEntity = orig; }
        fixture(surfaced && /i1 injected failure/.test(String(surfaced.message)), `the injected failure surfaced (got ${surfaced ? surfaced.message : 'success'})`);
        defect(goneAtFailure === true, 'the evidence chunk was not yet removed inside the import when the later step failed');
        defect(snapshot() === before, 'the failed import left writes behind');
        defect(evidenceRow()?.rowid === r && vecAt(r) === 1 && ftsRowids('zqximpquote81').includes(r), 'the evidence chunk was not restored by the rollback');
      },
    });
    m.invalidateDerivedForEntity = orig; }

  // (b) numeric document id: refused, nothing written.
  { let before;
    await redCase('(b) numeric document id is refused with no writes', {
      control: async () => { await fresh(); before = snapshot(); },
      defect: async () => {
        let refused = null;
        try { await m.importGraph({ entities: [PROBE], documents: [{ id: 7.5, content: DOC + ' changed', metadata: {} }] }); }
        catch (e) { refused = e; }
        if (!refused) {
          // What the accepted import did (recorded for the report, then the RED).
          const d = one(`SELECT content, typeof(id) t FROM documents WHERE id = ?`, DOC_ID);
          const ev = evidenceRow();
          let status = null; if (ev) status = (await m.getDetailedContext(CHUNK)).evidence_status;
          console.log(`    accepted: documents['7.5'] ${JSON.stringify(d)}; evidence chunk ${ev ? `left at rowid ${ev.rowid} (vector ${vecAt(ev.rowid)}, detail ${status})` : 'gone'}`);
        }
        defect(refused !== null, 'a numeric document id was accepted');
        defect(/documents\[0\]\.id must be a string/.test(String(refused.message)), `refused for another reason: ${refused.message}`);
        defect(snapshot() === before, 'the refused import wrote something');
      },
    });
    await restore('(b)', async () => { await m.deleteEntities([PROBE.name]); await resetDoc(); }); }

  // (c) numeric observation_sources observation_id: refused, nothing written.
  { let before;
    await redCase('(c) numeric observation_sources observation_id is refused with no writes', {
      control: async () => { await fresh(); before = snapshot(); },
      defect: async () => {
        let refused = null;
        try { await m.importGraph({ entities: [PROBE], observation_roots: [], observation_sources: [
          { observation_id: 7.5, source_kind: 'decision', source_ref: 'imp-num', source_hash: null, recorded_at: TS }] }); }
        catch (e) { refused = e; }
        if (!refused) {
          const src = all(`SELECT observation_id, typeof(observation_id) t, source_ref FROM observation_sources WHERE source_ref = 'imp-num'`);
          const ev = evidenceRow();
          let status = null; if (ev) status = (await m.getDetailedContext(CHUNK)).evidence_status;
          console.log(`    accepted: new source rows ${JSON.stringify(src)}; evidence chunk ${ev ? `left at rowid ${ev.rowid} (vector ${vecAt(ev.rowid)}, detail ${status})` : 'gone'}`);
        }
        defect(refused !== null, 'a numeric observation_sources observation_id was accepted');
        defect(/observation_sources\[0\]\.observation_id must be a string/.test(String(refused.message)), `refused for another reason: ${refused.message}`);
        defect(snapshot() === before, 'the refused import wrote something');
      },
    });
    await restore('(c)', async () => {
      db.prepare(`DELETE FROM observation_sources WHERE source_ref = 'imp-num'`).run();
      await m.deleteEntities([PROBE.name]);
    }); }

  // Precision: the guard reads only the two id fields; a string-id source import still goes through.
  { await fresh();
    await m.importGraph({ observation_roots: [], observation_sources: [
      { observation_id: OBS_ID, source_kind: 'decision', source_ref: 'imp-str', source_hash: null, recorded_at: TS }] });
    assert.equal(one(`SELECT count(*) n FROM observation_sources WHERE observation_id = ? AND source_ref = 'imp-str'`, OBS_ID).n, 1, 'string-id source imported');
    assert.equal(evidenceRow(), undefined, 'string-id source import removed the evidence citing the observation');
    console.log('  PASS string observation_sources id: imported, citing evidence removed'); }

  console.log(process.exitCode ? 'kg-import-id-contract: FAIL' : 'kg-import-id-contract: ALL PASS');
} finally { cleanup(); }
