#!/usr/bin/env node
// kg-relation-evidence D1 core: the exact fingerprint serialisation (plan "Fingerprint serialisation"),
// codepoint counting, and the comparison value both KG write-backs use (D2⑤). Golden hashes were
// computed with Node when the plan was written; a change here is a format change, not a refactor.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpLength, cpSlice, sha256Utf8, fingerprintSerialization, computeInputFingerprint, fingerprintFromMetadata,
  buildEvidenceBody, kgComparisonValue, captureKgEmbedInput, compareSourceTuples, EVIDENCE_CAPS,
} from '../dist/src/kg/relation-evidence.js';

// codepoints, never UTF-16 units — incl. astral, CRLF and a lone surrogate (Review Focus 1)
assert.equal('🎉'.length, 2); assert.equal(cpLength('🎉'), 1);
assert.equal(cpLength('🎉a\r\n'), 4);
assert.equal(cpLength('\uD800'), 1, 'a lone surrogate is one codepoint');
assert.equal(cpSlice('x🎉yz-tail', 2, 4), 'yz');
assert.equal(sha256Utf8('\uD800'), createHash('sha256').update(Buffer.from([0xef, 0xbf, 0xbd])).digest('hex'), 'lone surrogate hashes as U+FFFD');
assert.deepEqual(EVIDENCE_CAPS, { maxEntries: 8, maxQuoteCodepoints: 4000, maxBodyCodepoints: 8000 });

const TEXT = 'A supports B.\nA supports B.';
const Q = 'A supports B.';
assert.equal(sha256Utf8(TEXT), '8a09de0973f2b5e3d870bfd85640c1fe48cb8d560d46f9916b6fa7b569bb0375');
assert.equal(sha256Utf8(Q), 'abcb6fc5694d7ac72482dcf0eda55f1f5b60a9fa68424e4034f76ddf11c1038f');
const base = { relationship_id: 'rel_entity_a_supports_entity_b', source_entity_id: 'entity_a', target_entity_id: 'entity_b',
  relation_type: 'SUPPORTS', source_name: 'A', target_name: 'B', kg_format: 'evidence-v1', profile_id: 1 };
const docRef = (start, end) => ({ kind: 'document', document_id: 'doc1', chunk_id: 'doc1_chunk_0', start, end,
  chunk_text_sha256: sha256Utf8(TEXT), quote_sha256: sha256Utf8(Q) });
const fA = { ...base, refs: [docRef(0, 13)] };
assert.equal(fingerprintSerialization(fA),
  '["kg-evidence-fp/1","rel_entity_a_supports_entity_b","entity_a","entity_b","SUPPORTS","A","B","evidence-v1",[["document","doc1","doc1_chunk_0",0,13,"8a09de0973f2b5e3d870bfd85640c1fe48cb8d560d46f9916b6fa7b569bb0375","abcb6fc5694d7ac72482dcf0eda55f1f5b60a9fa68424e4034f76ddf11c1038f"]],1]');
assert.equal(computeInputFingerprint(fA), '145c937ef2d33d85d48ca3bfe33128fb5d631f05fa10a5655b385f03029706f6');
assert.equal(computeInputFingerprint({ ...base, refs: [docRef(14, 27)] }), '4ea0e4a1eaeceaf9e96c328f4d3668b4b1311d69cfdf940680c65f9e7ad2c865',
  'same quote text at another range = another fingerprint');
assert.notEqual(computeInputFingerprint({ ...fA, profile_id: 2 }), computeInputFingerprint(fA), 'profile is an input');
assert.throws(() => fingerprintSerialization({ ...base, refs: [docRef(0.5, 13)] }), /integer/);

// observation entry: sources sorted (kind, ref, hash; null first) whatever the stored order
const obs = { kind: 'observation', observation_id: 'obs-1', entity_id: 'entity_a', revision_no: 2,
  content_sha256: sha256Utf8('[2026-01-01] fact'), status_at_generation: 'active', source_summary: 'recorded',
  sources: [{ source_kind: 'import', source_ref: 'dump.json', source_hash: 'abc' }, { source_kind: 'document', source_ref: 'doc1', source_hash: null }] };
assert.equal(fingerprintSerialization({ ...base, refs: [obs] }),
  '["kg-evidence-fp/1","rel_entity_a_supports_entity_b","entity_a","entity_b","SUPPORTS","A","B","evidence-v1",[["observation","obs-1","entity_a",2,"15d7bb71ae38488182807c78879451c8027ced6e67b7eb8f55f6f718a7ac51dd",[["document","doc1",null],["import","dump.json","abc"]]]],1]');
assert.equal(computeInputFingerprint({ ...base, refs: [obs] }), '00d813cc5c8a6dd6ac15c8dc907c52cb16a705d2b51f2a7f64abd5264f2cb3cd');
assert.ok(compareSourceTuples({ source_kind: 'a', source_ref: 'r', source_hash: null }, { source_kind: 'a', source_ref: 'r', source_hash: 'x' }) < 0, 'null hash sorts first');

assert.equal(buildEvidenceBody('A', 'SUPPORTS', 'B', ['q1', 'q2']), 'A — SUPPORTS — B\n\nq1\n\nq2');

// comparison value (D2⑤)
const legacyRel = { rowid: 7, chunk_id: 'kg_relationship_r1', chunk_type: 'relationship', entity_id: null, relationship_id: 'r1', text: 'a b c', metadata: '{"confidence":1}' };
const cmp = kgComparisonValue(legacyRel);
assert.match(cmp, /^legacy:[0-9a-f]{64}$/);
assert.equal(kgComparisonValue({ ...legacyRel, metadata: '{"confidence":0.2}' }), cmp, 'display metadata is not an input');
assert.notEqual(kgComparisonValue({ ...legacyRel, relationship_id: 'r2' }), cmp, 'same text, other source = other value');
assert.notEqual(kgComparisonValue({ ...legacyRel, text: 'a b d' }), cmp);
assert.notEqual(kgComparisonValue({ ...legacyRel, chunk_type: 'entity', entity_id: 'r1', relationship_id: null }), cmp, 'chunk type is part of the identity');
assert.equal(kgComparisonValue({ ...legacyRel, relationship_id: null }), null, 'missing source id is never equal');
assert.equal(kgComparisonValue({ ...legacyRel, text: null }), null);
assert.equal(kgComparisonValue({ ...legacyRel, metadata: '{not json' }), null);
assert.equal(kgComparisonValue({ ...legacyRel, metadata: '{"kg_format":"evidence-v2"}' }), null, 'unknown format is never equal');
const meta = { kg_format: 'evidence-v1', relationship_id: 'r1', source_entity_id: 'entity_a', target_entity_id: 'entity_b',
  source_entity: 'A', target_entity: 'B', relation_type: 'SUPPORTS', direction: 'source->target', confidence: 1,
  evidence_refs: [docRef(0, 13)], support: { why_status: 'unjudged', valid_time: null, scope_note: null },
  generated_ref_status: 'refs-resolved', input_fingerprint: '', fingerprint_profile_id: 1, body_codepoints: 30,
  embedded_truncation: 'unchecked', evidence_semantics: 'x' };
meta.input_fingerprint = fingerprintFromMetadata(meta, 1);
const evRow = { ...legacyRel, metadata: JSON.stringify(meta) };
assert.equal(kgComparisonValue(evRow), `fp:${meta.input_fingerprint}`);
assert.equal(kgComparisonValue({ ...evRow, metadata: JSON.stringify({ ...meta, evidence_refs: [docRef(14, 27)] }) }), null,
  'refs edited without recomputing the fingerprint = never equal');
assert.equal(kgComparisonValue({ ...evRow, metadata: JSON.stringify({ ...meta, input_fingerprint: undefined }) }), null, 'missing fingerprint is never equal');
assert.equal(kgComparisonValue({ ...evRow, relationship_id: 'r9' }), null, 'metadata of another relationship is never equal');
assert.deepEqual(captureKgEmbedInput(legacyRel, 3), { rowid: 7, chunk_id: 'kg_relationship_r1', text_sha256: sha256Utf8('a b c'), cmp, profile_id: 3 });
// I1: absent / null / string hashes under one kind+ref sort the same whatever the input order
const srcA = { source_kind: 'k', source_ref: 'r' }, srcN = { source_kind: 'k', source_ref: 'r', source_hash: null }, srcS = { source_kind: 'k', source_ref: 'r', source_hash: 'a' };
const obsWith = (sources) => ({ ...obs, sources });
const o1 = { ...base, refs: [obsWith([srcA, srcN, srcS])] }, o2 = { ...base, refs: [obsWith([srcS, srcN, srcA])] }, o3 = { ...base, refs: [obsWith([srcS, srcA, srcN])] };
assert.equal(fingerprintSerialization(o1), fingerprintSerialization(o2));
assert.equal(fingerprintSerialization(o1), fingerprintSerialization(o3));
assert.equal(computeInputFingerprint(o1), computeInputFingerprint(o2));
assert.ok(fingerprintSerialization(o1).includes('[["k","r",null],["k","r",null],["k","r","a"]]'), 'null sorts before the string');
assert.ok(compareSourceTuples(srcA, srcS) < 0 && compareSourceTuples(srcS, srcA) > 0 && compareSourceTuples(srcA, srcN) === 0);

// I2: a null relationship_id row is never equal even when its metadata is self-consistent with null
const badMeta = { ...meta, relationship_id: null };
badMeta.input_fingerprint = fingerprintFromMetadata(badMeta, 1);
assert.equal(kgComparisonValue({ ...legacyRel, relationship_id: null, metadata: JSON.stringify(badMeta) }), null, 'rejected for the missing id, not a fingerprint mismatch');
const goodMeta = { ...meta, relationship_id: 'r1' };
goodMeta.input_fingerprint = fingerprintFromMetadata(goodMeta, 1);
assert.equal(kgComparisonValue({ ...legacyRel, metadata: JSON.stringify(goodMeta) }), `fp:${goodMeta.input_fingerprint}`, 'control: same construction with a valid id');
console.log('kg-evidence-core: ALL PASS');
