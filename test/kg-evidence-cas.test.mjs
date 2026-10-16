#!/usr/bin/env node
// kg-relation-evidence C5: counter-examples placed at the commit / CAS decision point itself, for the
// dedicated KG writer and the shared backfill, on evidence-v1 rows (legacy rows: kg-embed-cas.test.mjs).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';
import { fingerprintFromMetadata, kgComparisonValue } from '../dist/src/kg/relation-evidence.js';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const F = { formatVersion: 'evidence-v1' };
const { manager: m, cleanup } = await makeManager();
const { setKgFaultPoint } = await import('../dist/index.js');
try {
  const db = m.db;
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  installFakeEmbedder(m);
  const baseEmbed = m.gate.embedFn;
  const during = (text, fn) => {
    m.embeddingCache = new Map(); let fired = false;
    m.gate.embedFn = async (t, ...rest) => { if (!fired && t === text) { fired = true; await fn(); } return baseEmbed(t, ...rest); };
    return () => fired;
  };
  const restore = () => { m.gate.embedFn = baseEmbed; m.embeddingCache = new Map(); };
  const vecAt = (r) => one(`SELECT count(*) n FROM chunks WHERE rowid = ${Number(r)}`).n;
  const vecOf = (r) => new Float32Array(Uint8Array.from(one(`SELECT embedding FROM chunks WHERE rowid = ${Number(r)}`).embedding).buffer);
  const p1 = m.currentProfileId;
  const p2 = Number(db.prepare(`INSERT INTO embedding_profiles (model_id, revision, dtype, dims, pooling, normalize) VALUES ('test/profile-c','r1','fp16',1024,'cls',1)`).run().lastInsertRowid);

  await m.createEntities([
    { name: 'Cas Alpha', entityType: 'CONCEPT', observations: ['[2026-01-01] alpha says zqxcas91'] },
    { name: 'Cas Beta', entityType: 'CONCEPT', observations: ['[2026-01-01] beta'] },
  ]);
  await m.createRelations([{ from: 'Cas Alpha', to: 'Cas Beta', relationType: 'SUPPORTS' }]);
  const R = 'rel_entity_cas_alpha_supports_entity_cas_beta';
  const CH = `kg_relationship_${R}`;
  const REP = 'A supports B.\nA supports B.';
  await m.syncDocumentFromFile('/rep.md', 'rep', { content: REP });
  const range = (s, e) => ({ kind: 'document', chunk_id: 'rep_chunk_0', start: s, end: e, quote_sha256: sha([...REP].slice(s, e).join('')) });
  const oid = one(`SELECT observation_id FROM entity_observations WHERE content LIKE '%zqxcas91%'`).observation_id;
  const oref = () => { const o = one(`SELECT revision_no, content FROM entity_observations WHERE observation_id = ?`, oid); return { kind: 'observation', observation_id: oid, revision_no: o.revision_no, content_sha256: sha(o.content) }; };
  const row = () => one(`SELECT rowid, chunk_id, text, metadata, profile_id, provenance_state, input_hash FROM chunk_metadata WHERE chunk_id = ?`, CH);
  // the KgChunkRow shape writeKgVectorIfCurrent reads (index.ts writeKgVectorIfCurrent), plus profile_id
  const rowAt = (r) => one(`SELECT rowid, chunk_id, chunk_type, entity_id, relationship_id, text, metadata, profile_id FROM chunk_metadata WHERE rowid = ?`, r);
  const relChunks = () => JSON.stringify(all(`SELECT rowid, chunk_id, text, metadata FROM chunk_metadata WHERE chunk_type = 'relationship' ORDER BY rowid`));
  const gen = (evidence) => m.generateRelationEvidenceChunks([{ relationship_id: R, evidence }], F);
  const paths = {
    dedicated: async () => { await m.embedKnowledgeGraphChunks(); },
    backfill: async (rowid) => { await m.reembedChunkByRowid(rowid); },
  };

  for (const [name, run] of Object.entries(paths)) {
    // same chunk_id + same text + same profile, different input_fingerprint (quote moved to [14,27))
    { restore(); await gen([range(0, 13)]); const r0 = row();
      const fired = during(r0.text, async () => { await gen([range(14, 27)]); });
      await run(r0.rowid);
      const r1 = row();
      assert.ok(fired(), `${name}: fixture side effect ran`);
      assert.equal(r1.rowid, r0.rowid, `${name}: fixture: regenerated row reused the rowid`);
      assert.equal(r1.text, r0.text, `${name}: fixture: same body`);
      assert.notEqual(JSON.parse(r1.metadata).input_fingerprint, JSON.parse(r0.metadata).input_fingerprint, `${name}: fixture: fingerprint changed`);
      assert.equal(vecAt(r1.rowid), 0, `${name}: vector written although the fingerprint changed during inference`);
      console.log(`  PASS ${name}: same id/text/profile, other fingerprint -> dropped`); }
    // deleted during inference
    { restore(); await gen([range(0, 13)]); const r0 = row();
      during(r0.text, async () => { await m.generateRelationEvidenceChunks([], F); });
      await run(r0.rowid);
      assert.equal(vecAt(r0.rowid), 0, `${name}: orphan vector after delete during inference`);
      console.log(`  PASS ${name}: deleted during inference -> dropped`); }
    // same rowid + same text + same profile + same comparison value; ONLY chunk_id differs (C5 "same text
    // under a different chunk_id"). Relationship id and metadata stay R's, so kgComparisonValue is equal
    // and only the chunk_id guard in writeKgVectorIfCurrent can reject (REVIEW-T8-2_ I1).
    { restore(); await gen([range(0, 13)]); const r0 = row(); const old0 = rowAt(r0.rowid);
      const ALIAS = `${CH}_alias`;
      const fired = during(r0.text, () => {
        db.prepare(`DELETE FROM chunk_metadata WHERE rowid = ?`).run(r0.rowid);
        db.prepare(`INSERT INTO chunk_metadata (rowid, chunk_id, chunk_type, relationship_id, chunk_index, text, start_pos, end_pos, metadata)
          VALUES (?, ?, 'relationship', ?, 0, ?, 0, 1, ?)`).run(r0.rowid, ALIAS, R, r0.text, r0.metadata);
      });
      await run(r0.rowid);
      const n0 = rowAt(r0.rowid);
      assert.ok(fired(), `${name}: fixture side effect ran`);
      assert.equal(n0.chunk_id, ALIAS, `${name}: fixture: the other chunk_id is in place`);
      assert.notEqual(n0.chunk_id, old0.chunk_id, `${name}: fixture: chunk_id differs`);
      assert.equal(n0.rowid, old0.rowid, `${name}: fixture: same rowid`);
      assert.equal(n0.text, old0.text, `${name}: fixture: same text`);
      assert.equal(n0.relationship_id, old0.relationship_id, `${name}: fixture: same relationship_id`);
      assert.equal(m.currentProfileId, p1, `${name}: fixture: same profile`);
      assert.ok(kgComparisonValue(old0) !== null, `${name}: fixture: comparison value of the original row is not null`);
      assert.equal(kgComparisonValue(n0), kgComparisonValue(old0), `${name}: fixture: same comparison value, so only the chunk_id guard can reject`);
      assert.equal(vecAt(r0.rowid), 0, `${name}: vector attached to another chunk_id with the same text and inputs`);
      db.prepare(`DELETE FROM chunk_metadata WHERE chunk_id = ?`).run(ALIAS);
      console.log(`  PASS ${name}: same rowid/text/profile/comparison value, other chunk_id -> dropped`); }
    // variant: same text under a different chunk_id AND a different source identity at the same rowid
    { restore(); await gen([range(0, 13)]); const r0 = row();
      during(r0.text, () => {
        db.prepare(`DELETE FROM chunk_metadata WHERE rowid = ?`).run(r0.rowid);
        db.prepare(`INSERT INTO chunk_metadata (rowid, chunk_id, chunk_type, relationship_id, chunk_index, text, start_pos, end_pos, metadata)
          VALUES (?, 'kg_relationship_rel_other', 'relationship', 'rel_other', 0, ?, 0, 1, ?)`).run(r0.rowid, r0.text, r0.metadata);
      });
      await run(r0.rowid);
      assert.equal(vecAt(r0.rowid), 0, `${name}: vector attached to another chunk with the same text`);
      db.prepare(`DELETE FROM chunk_metadata WHERE chunk_id = 'kg_relationship_rel_other'`).run();
      console.log(`  PASS ${name}: same text, other chunk_id and other relationship_id -> dropped`); }
    // profile switched DURING inference -> dropped
    { restore(); await gen([range(0, 13), oref()]); const r0 = row();
      during(r0.text, () => { m.currentProfileId = p2; });
      try { await run(r0.rowid); } finally { m.currentProfileId = p1; }
      assert.equal(vecAt(r0.rowid), 0, `${name}: vector kept although the profile changed during inference`);
      console.log(`  PASS ${name}: profile switched during inference -> dropped`); }
    // profile switched BEFORE inference -> embedded under the new profile, fingerprint updated
    { restore(); await gen([range(0, 13), oref()]); const r0 = row();
      m.currentProfileId = p2;
      try { await run(r0.rowid); } finally { m.currentProfileId = p1; }
      const r1 = row(); const meta = JSON.parse(r1.metadata);
      assert.equal(vecAt(r1.rowid), 1, `${name}: not embedded after a profile change before inference`);
      assert.equal(r1.profile_id, p2); assert.equal(meta.fingerprint_profile_id, p2);
      assert.equal(meta.input_fingerprint, fingerprintFromMetadata(meta, p2), `${name}: fingerprint not re-recorded for the new profile`);
      assert.notEqual(meta.input_fingerprint, JSON.parse(r0.metadata).input_fingerprint);
      console.log(`  PASS ${name}: profile switched before inference -> embedded, fingerprint recorded for the new profile`); }
    // positive: unchanged inputs are embedded normally
    { restore(); await gen([range(0, 13), oref()]); const r0 = row();
      await run(r0.rowid);
      const r1 = row();
      assert.equal(vecAt(r1.rowid), 1); assert.equal(r1.provenance_state, 'verified'); assert.equal(r1.profile_id, p1); assert.equal(r1.input_hash, sha(r1.text));
      console.log(`  PASS ${name}: positive control (unchanged evidence-v1 row embedded)`); }
    // R5: the P1 result is CACHED (cache key has no profile, index.ts:2644-2654), then profile P2 with a
    // distinguishable model: the stored vector must be the P2 model's output and the fingerprint recorded for P2
    { restore(); await gen([range(0, 13), oref()]); const r0 = row();
      await run(r0.rowid);
      assert.equal(vecAt(r0.rowid), 1, `${name}: fixture: P1 vector written (and cached)`);
      db.exec(`DELETE FROM chunks WHERE rowid = ${Number(r0.rowid)}`);       // cache NOT cleared
      let p2Calls = 0;
      m.gate.embedFn = async (t, ...rest) => { p2Calls++; const v = await baseEmbed(t, ...rest); v[1023] = 0.777; return v; };
      m.currentProfileId = p2;
      try { await run(r0.rowid); } finally { m.currentProfileId = p1; m.gate.embedFn = baseEmbed; }
      const r1 = row(); const meta = JSON.parse(r1.metadata);
      assert.ok(p2Calls > 0, `${name}: the P2 model was never called — the cached P1 vector was reused`);
      assert.ok(Math.abs(vecOf(r1.rowid)[1023] - 0.777) < 1e-6, `${name}: stored vector is not the P2 model's output`);
      assert.equal(r1.profile_id, p2); assert.equal(meta.fingerprint_profile_id, p2);
      assert.equal(meta.input_fingerprint, fingerprintFromMetadata(meta, p2));
      console.log(`  PASS ${name}: P1 cached, then P2 -> P2 output stored, fingerprint recorded for P2`); }
  }

  // ---- commit-time re-check: a cited source changed between validation and commit -> whole call fails, zero writes
  const commitCase = async (label, change, undo, reason) => {
    restore(); await gen([range(0, 13), oref()]);
    const before = relChunks();
    setKgFaultPoint('evidence-pre-commit', change);
    try {
      await assert.rejects(() => gen([range(14, 27), oref()]),
        (e) => e.name === 'EvidenceCommitConflictError' && e.reason === reason, `${label}: expected ${reason}`);
    } finally { setKgFaultPoint(null, null); }
    assert.equal(relChunks(), before, `${label}: a conflicting commit wrote relationship chunks`);
    await undo();
    console.log(`  PASS commit re-check: ${label} -> ${reason}, zero writes`);
  };
  // body/revision/content unchanged, retracted before commit (REVIEW-ALPHA3 §3.1): status is checked before the fingerprint
  await commitCase('observation retracted before commit',
    () => { db.prepare(`UPDATE entity_observations SET status = 'retracted' WHERE observation_id = ?`).run(oid); },
    () => { db.prepare(`UPDATE entity_observations SET status = 'active' WHERE observation_id = ?`).run(oid); },
    'observation-not-active');
  await commitCase('cited chunk text changed outside the quote',
    () => { db.prepare(`UPDATE chunk_metadata SET text = ? WHERE chunk_id = 'rep_chunk_0'`).run(REP + ' tail'); },
    () => { db.prepare(`UPDATE chunk_metadata SET text = ? WHERE chunk_id = 'rep_chunk_0'`).run(REP); },
    'fingerprint-changed');
  await commitCase('cited chunk turned into a non-document chunk',
    () => { db.prepare(`UPDATE chunk_metadata SET chunk_type = 'entity' WHERE chunk_id = 'rep_chunk_0'`).run(); },
    () => { db.prepare(`UPDATE chunk_metadata SET chunk_type = 'document' WHERE chunk_id = 'rep_chunk_0'`).run(); },
    'not-a-document-chunk');
  await commitCase('source added to the cited observation',
    () => { db.prepare(`INSERT INTO observation_sources (observation_id, source_kind, source_ref, source_hash, recorded_at) VALUES (?, 'decision', 'late', NULL, '2026-01-02')`).run(oid); },
    () => { db.prepare(`DELETE FROM observation_sources WHERE observation_id = ? AND source_ref = 'late'`).run(oid); },
    'fingerprint-changed');
  await commitCase('profile switched between preparation and commit',
    () => { m.currentProfileId = p2; },
    () => { m.currentProfileId = p1; },
    'fingerprint-changed');
  // Review Focus 5: the relationship row disappears before commit
  await commitCase('relationship row deleted before commit',
    () => { db.prepare(`DELETE FROM relationships WHERE id = ?`).run(R); },
    async () => { await m.createRelations([{ from: 'Cas Alpha', to: 'Cas Beta', relationType: 'SUPPORTS' }]); },
    'unknown-relationship');
  await commitCase('cited document deleted before commit (FK cascade takes the chunk)',
    () => { db.prepare(`DELETE FROM documents WHERE id = 'rep'`).run(); },
    async () => {
      const meta = new Set(all(`SELECT rowid FROM chunk_metadata`).map(r => r.rowid));
      for (const { rowid } of all(`SELECT rowid FROM chunks`)) if (!meta.has(rowid)) db.exec(`DELETE FROM chunks WHERE rowid = ${Number(rowid)}`);
      await m.syncDocumentFromFile('/rep.md', 'rep', { content: REP });
    },
    'unknown-chunk');

  // ---- R1: a DISPLAY-only change between preparation and commit (confidence is not a fingerprint input)
  // succeeds and publishes the CURRENT copy; fingerprint and body are unchanged. The real writer runs in
  // the hook (updateRelations has no await, so it completes synchronously inside the hook).
  { restore(); await gen([range(0, 13)]);
    const fp0 = JSON.parse(row().metadata).input_fingerprint, body0 = row().text;
    assert.equal(JSON.parse(row().metadata).confidence, 1, 'fixture: prepared copy = 1');
    setKgFaultPoint('evidence-pre-commit', () => {
      void m.updateRelations([{ from: 'Cas Alpha', to: 'Cas Beta', relationType: 'SUPPORTS', confidence: 0.4 }]);
      assert.equal(one(`SELECT confidence c FROM relationships WHERE id = ?`, R).c, 0.4, 'fixture: the update landed before commit');
    });
    try { await gen([range(0, 13)]); } finally { setKgFaultPoint(null, null); }
    const meta = JSON.parse(row().metadata);
    assert.equal(meta.confidence, 0.4, 'the prepared confidence was re-published over the current 0.4');
    assert.equal(meta.input_fingerprint, fp0, 'confidence must not change the fingerprint');
    assert.equal(row().text, body0, 'confidence must not change the body');
    await m.updateRelations([{ from: 'Cas Alpha', to: 'Cas Beta', relationType: 'SUPPORTS', confidence: 1 }]);
    console.log('  PASS R1: confidence changed between prepare and commit -> success, current copy 0.4, same fp/body'); }

  // ---- mid-generation failure -> nothing published
  { restore(); await gen([range(0, 13)]); await m.embedKnowledgeGraphChunks();
    const before = relChunks(); const vecBefore = JSON.stringify(all(`SELECT rowid FROM chunks ORDER BY rowid`));
    await m.createRelations([{ from: 'Cas Beta', to: 'Cas Alpha', relationType: 'ECHOES' }]);
    const R2 = 'rel_entity_cas_beta_echoes_entity_cas_alpha';
    setKgFaultPoint('evidence-mid-commit', () => { throw new Error('injected mid-commit failure'); });
    try {
      await assert.rejects(() => m.generateRelationEvidenceChunks([{ relationship_id: R, evidence: [range(14, 27)] }, { relationship_id: R2, evidence: [range(0, 13)] }], F), /injected mid-commit failure/);
    } finally { setKgFaultPoint(null, null); }
    assert.equal(relChunks(), before, 'a failed generation published relationship chunks');
    assert.equal(JSON.stringify(all(`SELECT rowid FROM chunks ORDER BY rowid`)), vecBefore, 'a failed generation removed vectors');
    console.log('  PASS mid-generation failure publishes nothing'); }
  restore();
  console.log(process.exitCode ? 'kg-evidence-cas: FAIL' : 'kg-evidence-cas: ALL PASS');
} finally { cleanup(); }
