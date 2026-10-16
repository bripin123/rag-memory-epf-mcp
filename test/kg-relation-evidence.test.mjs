#!/usr/bin/env node
// kg-relation-evidence C2: evidence-v1 through a real generation commit (proposal D1). Every rejection
// rejects the WHOLE call with zero writes; the exact-cap input succeeds first. Stub embedder (repo
// convention) — the gate, write-back and hybridSearch paths are the real ones.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';
import { cpLength, fingerprintFromMetadata, EVIDENCE_CAPS } from '../dist/src/kg/relation-evidence.js';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const F = { formatVersion: 'evidence-v1' };
const cp = (s) => [...s].length;
const at = (text, needle) => cp(text.slice(0, text.indexOf(needle)));     // codepoint offset of a substring
const eid = (n) => `entity_${n.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;
const rid = (from, type, to) => `rel_${eid(from)}_${type}_${eid(to)}`.toLowerCase();
const { manager: m, cleanup } = await makeManager();
try {
  const db = m.db;
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  installFakeEmbedder(m);
  const D = '[2026-01-01] ';
  await m.createEntities([
    { name: 'Alpha Corp', entityType: 'ORG', observations: [`${D}Alpha Corp is a funder.`] },
    { name: 'Beta Lab', entityType: 'ORG', observations: [`${D}Beta Lab receives grants from Alpha Corp under program zqxgrant77.`],
      sources: [{ source_kind: 'document', source_ref: 'ev-doc', source_hash: 'h-ev-doc' }] },
    { name: 'Gamma Unit', entityType: 'ORG', observations: [`${D}Gamma Unit ships parts.`] },
    { name: 'Delta Team', entityType: 'ORG', observations: [`${D}Delta Team assembles.`] },
    { name: 'Cap Holder', entityType: 'NOTE', observations: [D + 'o'.repeat(4000 - cp(D))] },
    { name: 'Cap Holder Over', entityType: 'NOTE', observations: [D + 'p'.repeat(4001 - cp(D))] },
  ]);
  await m.createRelations([
    { from: 'Alpha Corp', to: 'Beta Lab', relationType: 'FUNDS' },
    { from: 'Gamma Unit', to: 'Delta Team', relationType: 'SUPPLIES' },
    { from: 'Alpha Corp', to: 'Delta Team', relationType: 'PARTNERS_WITH' },
  ]);
  const R1 = rid('Alpha Corp', 'FUNDS', 'Beta Lab'), R2 = rid('Gamma Unit', 'SUPPLIES', 'Delta Team');
  const EV_DOC = 'Funding note. Alpha Corp funds Beta Lab through grant zqxfund41 every spring.\nSecond line about Gamma Unit supplying Delta Team with zqxparts52.';
  const REP = 'A supports B.\nA supports B.';
  const ASTRAL = 'x🎉yz-tail';
  const CRLF = 'line one\r\nline two';
  const Q4000 = '🎉\r\n'.repeat(1333) + 'a';                      // 4,000 codepoints, 5,333 UTF-16 units
  const BIG = Q4000 + 'b' + '|' + '가🎉\r\n'.repeat(1400);
  for (const [id, content, extra] of [['ev-doc', EV_DOC], ['rep', REP], ['astral', ASTRAL], ['crlf', CRLF], ['big', BIG, { chunkParams: { maxTokens: 100000 } }]]) {
    await m.syncDocumentFromFile(`/${id}.md`, id, { content, ...(extra ?? {}) });
    const rows = all(`SELECT text FROM chunk_metadata WHERE document_id = ?`, id);
    assert.ok(rows.length === 1 && rows[0].text === content, `fixture: ${id} is one chunk equal to its content`);
  }
  assert.equal(cp(Q4000), 4000); assert.equal(Q4000.length, 5333);
  const chunkText = (chunkId) => one(`SELECT text FROM chunk_metadata WHERE chunk_id = ?`, chunkId).text;
  const docRef = (chunkId, start, end) => ({ kind: 'document', chunk_id: chunkId, start, end, quote_sha256: sha([...chunkText(chunkId)].slice(start, end).join('')) });
  const obsId = (name) => one(`SELECT observation_id FROM entity_observations WHERE entity_id = ? AND status = 'active' ORDER BY projection_order LIMIT 1`, eid(name)).observation_id;
  const obsRef = (oid) => { const r = one(`SELECT revision_no, content FROM entity_observations WHERE observation_id = ?`, oid); return { kind: 'observation', observation_id: oid, revision_no: r.revision_no, content_sha256: sha(r.content) }; };
  const snapshot = () => JSON.stringify({
    meta: all(`SELECT rowid, chunk_id, chunk_type, entity_id, relationship_id, text, metadata FROM chunk_metadata ORDER BY rowid`),
    vec: all(`SELECT rowid FROM chunks ORDER BY rowid`).map(r => r.rowid),
    rel: all(`SELECT id, relationType, confidence, metadata FROM relationships ORDER BY id`),
    docs: all(`SELECT id, content FROM documents ORDER BY id`),
  });
  const relChunks = () => all(`SELECT chunk_id, relationship_id, text, metadata FROM chunk_metadata WHERE chunk_type = 'relationship' ORDER BY chunk_id`);
  const rejectsZeroWrites = async (label, items, code) => {
    const before = snapshot();
    await assert.rejects(() => m.generateRelationEvidenceChunks(items, F),
      (e) => e.name === 'EvidenceInputError' && e.code === code, `${label}: expected ${code}`);
    assert.equal(snapshot(), before, `${label}: a rejected call wrote something`);
    console.log(`  PASS reject ${label} (${code}, zero writes)`);
  };

  // ---- baseline: 6 entity chunks + 3 triplets (R3 is outside S below)
  await m.generateKnowledgeGraphChunks();
  assert.equal(one(`SELECT count(*) n FROM chunk_metadata WHERE chunk_type = 'entity'`).n, 6);
  assert.equal(relChunks().length, 3);
  const neighborsBefore = JSON.stringify(await m.getNeighbors(['Alpha Corp'], 1));
  const relRowsBefore = JSON.stringify(all(`SELECT * FROM relationships ORDER BY id`));

  // ---- accepted valid batch
  const q1 = 'Alpha Corp funds Beta Lab through grant zqxfund41 every spring.', s1 = at(EV_DOC, q1);
  const q2 = 'Second line about Gamma Unit supplying Delta Team with zqxparts52.', s2 = at(EV_DOC, q2);
  const oBeta = obsId('Beta Lab');
  const items = [
    { relationship_id: R1, evidence: [docRef('ev-doc_chunk_0', s1, s1 + cp(q1)), obsRef(oBeta)], support: { why_status: 'reason-stated', valid_time: 'every spring' } },
    { relationship_id: R2, evidence: [docRef('ev-doc_chunk_0', s2, s2 + cp(q2))] },
  ];
  assert.deepEqual(await m.generateRelationEvidenceChunks(items, F), { relationshipChunks: 2, removedRelationshipChunks: 3, formatVersion: 'evidence-v1' });
  const rc = relChunks();
  assert.deepEqual(rc.map(r => r.relationship_id).sort(), [R1, R2].sort(), 'only S has relationship chunks; the R3 triplet is gone');
  assert.equal(one(`SELECT count(*) n FROM chunk_metadata WHERE chunk_type = 'entity'`).n, 6, 'entity KG chunks untouched');
  const c1 = rc.find(r => r.relationship_id === R1);
  const betaContent = one(`SELECT content FROM entity_observations WHERE observation_id = ?`, oBeta).content;
  assert.equal(c1.chunk_id, `kg_relationship_${R1}`);
  assert.equal(c1.text, `Alpha Corp — FUNDS — Beta Lab\n\n${q1}\n\n${betaContent}`, 'body = claim line + quotes in input order');
  const meta1 = JSON.parse(c1.metadata);
  assert.equal(meta1.kg_format, 'evidence-v1');
  assert.equal(meta1.relationship_id, R1); assert.equal(meta1.source_entity_id, eid('Alpha Corp')); assert.equal(meta1.target_entity_id, eid('Beta Lab'));
  assert.equal(meta1.relation_type, 'FUNDS'); assert.equal(meta1.direction, 'source->target');
  assert.deepEqual(meta1.evidence_refs[0], { kind: 'document', document_id: 'ev-doc', chunk_id: 'ev-doc_chunk_0', start: s1, end: s1 + cp(q1), chunk_text_sha256: sha(EV_DOC), quote_sha256: sha(q1) });
  assert.deepEqual(meta1.evidence_refs[1], { kind: 'observation', observation_id: oBeta, entity_id: eid('Beta Lab'), revision_no: 1, content_sha256: sha(betaContent),
    status_at_generation: 'active', sources: [{ source_kind: 'document', source_ref: 'ev-doc', source_hash: 'h-ev-doc' }], source_summary: 'recorded' });
  assert.deepEqual(meta1.support, { why_status: 'reason-stated', valid_time: 'every spring', scope_note: null });
  assert.equal(meta1.generated_ref_status, 'refs-resolved'); assert.equal(meta1.embedded_truncation, 'unchecked');
  assert.equal(meta1.body_codepoints, cpLength(c1.text));
  assert.equal(meta1.fingerprint_profile_id, m.currentProfileId);
  assert.equal(meta1.input_fingerprint, fingerprintFromMetadata(meta1, m.currentProfileId));
  assert.ok(!c1.text.includes(meta1.input_fingerprint) && !c1.text.includes(R1) && !c1.text.includes('ev-doc_chunk_0'), 'no ids or hashes in the embedded text');
  assert.equal(JSON.parse(rc.find(r => r.relationship_id === R2).metadata).support.why_status, 'unjudged', 'support defaults to unjudged');
  assert.equal(JSON.stringify(all(`SELECT * FROM relationships ORDER BY id`)), relRowsBefore, 'relationship rows unchanged');
  assert.equal(JSON.stringify(await m.getNeighbors(['Alpha Corp'], 1)), neighborsBefore, 'getNeighbors unchanged (R3 outside S still reachable)');
  console.log('  PASS accepted batch: snapshot replace, body, metadata, fingerprint, graph untouched');

  // ---- idempotent
  const rowsA = JSON.stringify(relChunks());
  await m.generateRelationEvidenceChunks(items, F);
  assert.equal(JSON.stringify(relChunks()), rowsA, 'same input twice = same rows');
  console.log('  PASS idempotent');

  // ---- rejections: whole call, zero writes
  await rejectsZeroWrites('non-document chunk', [{ relationship_id: R1, evidence: [docRef(`kg_entity_${eid('Alpha Corp')}`, 0, 5)] }], 'not-a-document-chunk');
  await rejectsZeroWrites('unknown chunk', [{ relationship_id: R1, evidence: [{ kind: 'document', chunk_id: 'nope_chunk_0', start: 0, end: 1, quote_sha256: sha('x') }] }], 'unknown-chunk');
  await rejectsZeroWrites('empty evidence', [{ relationship_id: R1, evidence: [] }], 'empty-evidence');
  await rejectsZeroWrites('non-integer start', [{ relationship_id: R1, evidence: [{ ...docRef('ev-doc_chunk_0', 0, 5), start: 0.5 }] }], 'range-not-integer');
  await rejectsZeroWrites('string start', [{ relationship_id: R1, evidence: [{ ...docRef('ev-doc_chunk_0', 0, 5), start: '0' }] }], 'range-not-integer');
  await rejectsZeroWrites('end past the chunk', [{ relationship_id: R1, evidence: [{ ...docRef('ev-doc_chunk_0', 0, 5), end: cp(EV_DOC) + 1 }] }], 'range-out-of-bounds');
  await rejectsZeroWrites('empty range', [{ relationship_id: R1, evidence: [{ ...docRef('ev-doc_chunk_0', 0, 5), start: 5, end: 5 }] }], 'range-out-of-bounds');
  await rejectsZeroWrites('negative start', [{ relationship_id: R1, evidence: [{ ...docRef('ev-doc_chunk_0', 0, 5), start: -1 }] }], 'range-out-of-bounds');
  assert.equal(ASTRAL.indexOf('yz'), 3, 'fixture: UTF-16 index'); assert.equal(at(ASTRAL, 'yz'), 2, 'fixture: codepoint index');
  await rejectsZeroWrites('UTF-16 offsets on astral text', [{ relationship_id: R1, evidence: [{ kind: 'document', chunk_id: 'astral_chunk_0', start: 3, end: 5, quote_sha256: sha('yz') }] }], 'quote-hash-mismatch');
  await rejectsZeroWrites('CRLF-normalised hash', [{ relationship_id: R1, evidence: [{ kind: 'document', chunk_id: 'crlf_chunk_0', start: 8, end: cp(CRLF), quote_sha256: sha('\nline two') }] }], 'quote-hash-mismatch');
  await rejectsZeroWrites('wrong hash', [{ relationship_id: R1, evidence: [{ ...docRef('ev-doc_chunk_0', 0, 5), quote_sha256: '0'.repeat(64) }] }], 'quote-hash-mismatch');
  await rejectsZeroWrites('unknown relationship', [{ relationship_id: 'rel_nope', evidence: [docRef('ev-doc_chunk_0', 0, 5)] }], 'unknown-relationship');
  await rejectsZeroWrites('relationship id in another case (Review Focus 3)', [{ relationship_id: R1.toUpperCase(), evidence: [docRef('ev-doc_chunk_0', 0, 5)] }], 'unknown-relationship');
  await rejectsZeroWrites('duplicate relationship id', [items[0], { relationship_id: R1, evidence: [docRef('ev-doc_chunk_0', 0, 5)] }], 'duplicate-relationship');
  await rejectsZeroWrites('valid A + invalid B', [items[0], { relationship_id: R2, evidence: [] }], 'empty-evidence');
  await rejectsZeroWrites('unknown why_status', [{ relationship_id: R1, evidence: [docRef('ev-doc_chunk_0', 0, 5)], support: { why_status: 'proven' } }], 'invalid-support');
  await rejectsZeroWrites('valid_time not a string', [{ relationship_id: R1, evidence: [docRef('ev-doc_chunk_0', 0, 5)], support: { valid_time: 20260101 } }], 'invalid-support');
  await rejectsZeroWrites('unknown evidence kind', [{ relationship_id: R1, evidence: [{ kind: 'url', href: 'x' }] }], 'unknown-evidence-kind');
  // the real codepoint range on astral / CRLF text is accepted (positive halves of the two cases above)
  await m.generateRelationEvidenceChunks([{ relationship_id: R1, evidence: [docRef('astral_chunk_0', 2, 4), docRef('crlf_chunk_0', 8, cp(CRLF))] }], F);
  assert.equal(relChunks()[0].text, `Alpha Corp — FUNDS — Beta Lab\n\nyz\n\n\r\nline two`, 'astral and CRLF quotes stored verbatim');

  // ---- observation state: a retracted revision keeps id, revision and content (lifecycle.ts:127-150)
  await m.createEntities([{ name: 'State Holder', entityType: 'NOTE', observations: [`${D}to be retracted`, `${D}to be corrected`] }]);
  const [oRet, oCor] = all(`SELECT observation_id FROM entity_observations WHERE entity_id = ? ORDER BY projection_order`, eid('State Holder')).map(r => r.observation_id);
  const retRef = obsRef(oRet);
  await m.retractObservation(oRet, 'test');
  await rejectsZeroWrites('retracted observation', [{ relationship_id: R1, evidence: [retRef] }], 'observation-not-active');
  const oldRef = obsRef(oCor);
  const oCor2 = await m.correctObservation(oCor, `${D}corrected text`);
  await rejectsZeroWrites('historical (superseded) revision', [{ relationship_id: R1, evidence: [oldRef] }], 'observation-not-active');
  await rejectsZeroWrites('current id, stale revision number', [{ relationship_id: R1, evidence: [{ ...obsRef(oCor2), revision_no: 1 }] }], 'observation-revision-mismatch');
  await rejectsZeroWrites('content hash mismatch', [{ relationship_id: R1, evidence: [{ ...obsRef(oCor2), content_sha256: sha('something else') }] }], 'observation-content-mismatch');
  await rejectsZeroWrites('unknown observation', [{ relationship_id: R1, evidence: [{ kind: 'observation', observation_id: 'no-such-obs', revision_no: 1, content_sha256: sha('x') }] }], 'unknown-observation');

  // ---- caps at both edges; the exact-cap input succeeds first
  const eight = Array.from({ length: 8 }, (_, k) => docRef('ev-doc_chunk_0', k, k + 1));
  await m.generateRelationEvidenceChunks([{ relationship_id: R1, evidence: eight }], F);
  assert.equal(JSON.parse(relChunks()[0].metadata).evidence_refs.length, EVIDENCE_CAPS.maxEntries);
  await rejectsZeroWrites('9 entries', [{ relationship_id: R1, evidence: [...eight, docRef('ev-doc_chunk_0', 8, 9)] }], 'too-many-entries');
  await m.generateRelationEvidenceChunks([{ relationship_id: R1, evidence: [docRef('big_chunk_0', 0, 4000)] }], F);
  await rejectsZeroWrites('4,001-codepoint quote', [{ relationship_id: R1, evidence: [docRef('big_chunk_0', 0, 4001)] }], 'quote-over-cap');
  const capContent = one(`SELECT content FROM entity_observations WHERE observation_id = ?`, obsId('Cap Holder')).content;
  assert.equal(cpLength(capContent), 4000, 'fixture: observation content is exactly 4,000 codepoints');
  await m.generateRelationEvidenceChunks([{ relationship_id: R1, evidence: [obsRef(obsId('Cap Holder'))] }], F);
  await rejectsZeroWrites('4,001-codepoint observation', [{ relationship_id: R1, evidence: [obsRef(obsId('Cap Holder Over'))] }], 'quote-over-cap');
  const claim = 'Alpha Corp — FUNDS — Beta Lab';
  const L = EVIDENCE_CAPS.maxBodyCodepoints - cp(claim) - 2 - 4000 - 2;     // = 3,967
  const fillStart = 4002;                                                   // after Q4000 + 'b' + '|'
  await m.generateRelationEvidenceChunks([{ relationship_id: R1, evidence: [docRef('big_chunk_0', 0, 4000), docRef('big_chunk_0', fillStart, fillStart + L)] }], F);
  assert.equal(JSON.parse(relChunks()[0].metadata).body_codepoints, 8000, 'exactly 8,000-codepoint body accepted');
  await rejectsZeroWrites('8,001-codepoint body', [{ relationship_id: R1, evidence: [docRef('big_chunk_0', 0, 4000), docRef('big_chunk_0', fillStart, fillStart + L + 1)] }], 'body-over-cap');
  console.log('  PASS caps 8/9 · 4,000/4,001 (document and observation) · 8,000/8,001 incl. astral/CRLF');

  // ---- the same quote text at two ranges of one chunk = two fingerprints, one body
  await m.generateRelationEvidenceChunks([{ relationship_id: R1, evidence: [docRef('rep_chunk_0', 0, 13)] }], F);
  const a = relChunks()[0];
  await m.generateRelationEvidenceChunks([{ relationship_id: R1, evidence: [docRef('rep_chunk_0', 14, 27)] }], F);
  const b = relChunks()[0];
  assert.equal(a.text, b.text, 'same body');
  assert.notEqual(JSON.parse(a.metadata).input_fingerprint, JSON.parse(b.metadata).input_fingerprint, 'different ranges must fingerprint differently');

  // ---- Review Focus 2: a repeated entry is kept, not deduplicated
  await m.generateRelationEvidenceChunks([{ relationship_id: R1, evidence: [docRef('rep_chunk_0', 0, 13), docRef('rep_chunk_0', 0, 13)] }], F);
  assert.equal(relChunks()[0].text, `${claim}\n\nA supports B.\n\nA supports B.`);
  assert.equal(JSON.parse(relChunks()[0].metadata).evidence_refs.length, 2);

  // ---- items = [] empties relationship chunks only
  assert.deepEqual(await m.generateRelationEvidenceChunks([], F), { relationshipChunks: 0, removedRelationshipChunks: 1, formatVersion: 'evidence-v1' });
  assert.equal(relChunks().length, 0); assert.equal(one(`SELECT count(*) n FROM chunk_metadata WHERE chunk_type = 'entity'`).n, 6);

  // ---- hybridSearch with the STUB model (gate / write-back / ranking paths are real; the model is not —
  // the real-bge-m3 counterpart is eval/kg-relation-evidence/real-model-e2e.mjs, run in Task 12).
  // Negative oracle (R2): stub vector ranks are uncontrolled, so "no relationship chunk in the top 10" is
  // NOT asserted. What is asserted: the R1 triplet's own body does not contain the quote-only token and
  // FTS does not match it, i.e. the triplet carries no evidence for the query.
  await m.startReconciliation();
  await m.generateKnowledgeGraphChunks(); m.embeddingCache = new Map(); await m.embedKnowledgeGraphChunks();
  const ftsRowids = (t) => all(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?`, `"${t}"`).map(r => r.rowid);
  const triplet = one(`SELECT rowid, text FROM chunk_metadata WHERE chunk_id = ?`, `kg_relationship_${R1}`);
  assert.ok(!triplet.text.includes('zqxfund41'), 'negative: the triplet body carries no quote token');
  assert.ok(!ftsRowids('zqxfund41').includes(triplet.rowid), 'negative: FTS does not match the triplet for the quote-only token');
  await m.generateRelationEvidenceChunks(items, F); await m.embedKnowledgeGraphChunks();
  const ev = one(`SELECT rowid FROM chunk_metadata WHERE chunk_id = ?`, `kg_relationship_${R1}`);
  assert.ok(ftsRowids('zqxfund41').includes(ev.rowid), 'positive: FTS matches the evidence chunk');
  const pos = await m.hybridSearch('zqxfund41', 10, false);
  assert.equal(pos.search_mode, 'hybrid', 'fixture: every chunk has a vector');
  // Only two chunks contain the token (ev-doc and the evidence chunk), so the evidence chunk's FTS rank is
  // <= 2 and its RRF score >= 1/62, above every vector-only candidate except vector rank 1: top 3 at worst.
  const hit = pos.results.find(x => x.chunk_id === `kg_relationship_${R1}`);
  assert.ok(hit && hit.source_id === R1 && hit.fts_boost !== undefined, 'the evidence chunk is retrieved (FTS-matched) for a query only its quote answers');
  assert.equal(typeof hit.document_title, 'string', 'search field types unchanged');
  console.log(process.exitCode ? 'kg-relation-evidence: FAIL' : 'kg-relation-evidence: ALL PASS');
} finally { cleanup(); }
