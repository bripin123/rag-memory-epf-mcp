// kg-relation-evidence (specs/changes/kg-relation-evidence/proposal.md r3, D1·D2).
// Evidence-backed relationship chunks: everything that must be computed identically in four places —
// generation, the commit-time re-check, and both KG embedding write-backs (dedicated + backfill).
// Pure functions first; the resolvers further down take a better-sqlite3 handle and never open a
// transaction themselves: callers own the transaction (CODE_CONTEXT §2).
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export const EVIDENCE_FORMAT = 'evidence-v1' as const;
// Policy limits for this experiment, not a claim of sufficiency (proposal D1). Over-cap input is
// refused, never truncated, and an item is never dropped from S to fit.
export const EVIDENCE_CAPS = Object.freeze({ maxEntries: 8, maxQuoteCodepoints: 4000, maxBodyCodepoints: 8000 });
export const FINGERPRINT_TAG = 'kg-evidence-fp/1';
export const LEGACY_CMP_TAG = 'kg-legacy-cmp/1';
// "Evidence-backed" is a claim about references, not about truth (proposal D1, last bullet).
export const EVIDENCE_SEMANTICS =
  'caller-selected evidence; the engine verified the references exist verbatim; not an independent proof of the relation';

export type WhyStatus = 'reason-stated' | 'relation-only' | 'unjudged';
export interface EvidenceSupportInput { why_status?: WhyStatus; valid_time?: string; scope_note?: string }
export type EvidenceEntryInput =
  | { kind: 'document'; chunk_id: string; start: number; end: number; quote_sha256: string }
  | { kind: 'observation'; observation_id: string; revision_no: number; content_sha256: string };
export interface EvidenceItemInput { relationship_id: string; evidence: EvidenceEntryInput[]; support?: EvidenceSupportInput }
export interface SourceTuple { source_kind: string; source_ref: string; source_hash: string | null }
export interface DocumentRefMeta {
  kind: 'document'; document_id: string; chunk_id: string; start: number; end: number;
  chunk_text_sha256: string; quote_sha256: string;
}
export interface ObservationRefMeta {
  kind: 'observation'; observation_id: string; entity_id: string; revision_no: number; content_sha256: string;
  status_at_generation: 'active'; sources: SourceTuple[]; source_summary: 'recorded' | 'unrecorded' | 'import-only';
}
export type EvidenceRefMeta = DocumentRefMeta | ObservationRefMeta;
export interface EvidenceChunkMetadataV1 {
  kg_format: typeof EVIDENCE_FORMAT;
  relationship_id: string; source_entity_id: string; target_entity_id: string;
  source_entity: string; target_entity: string; relation_type: string; direction: 'source->target';
  confidence: number;                              // display copy, refreshed in place (D2②), not an input
  evidence_refs: EvidenceRefMeta[];
  support: { why_status: WhyStatus; valid_time: string | null; scope_note: string | null };
  generated_ref_status: 'refs-resolved';           // the state AT GENERATION, not the reader's (D1)
  input_fingerprint: string; fingerprint_profile_id: number;
  body_codepoints: number;
  embedded_truncation: 'unchecked';                // model truncation was not checked (D1)
  evidence_semantics: string;
}
export interface FingerprintInput {
  relationship_id: string; source_entity_id: string; target_entity_id: string; relation_type: string;
  source_name: string; target_name: string; kg_format: typeof EVIDENCE_FORMAT; refs: EvidenceRefMeta[]; profile_id: number;
}
export interface PreparedEvidenceChunk { chunk_id: string; relationship_id: string; text: string; body_codepoints: number; metadata: EvidenceChunkMetadataV1 }
export interface KgChunkRow {
  rowid: number; chunk_id: string; chunk_type: string | null; entity_id: string | null;
  relationship_id: string | null; text: string | null; metadata: string | null;
}
export interface KgEmbedCapture { rowid: number; chunk_id: string; text_sha256: string; cmp: string | null; profile_id: number }

// Codepoints, never UTF-16 units: '🎉'.length === 2 but cpLength('🎉') === 1. Caps and [start, end)
// are defined in codepoints (D1), like chunk start_pos/end_pos since migration 11.
export function cpLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
export function cpSlice(s: string, start: number, end: number): string {
  return Array.from(s).slice(start, end).join('');
}
// SHA-256 of the UTF-8 bytes, lowercase hex. No normalisation, no newline rewriting. Node encodes a
// lone surrogate as U+FFFD (EF BF BD), the same bytes TextEncoder produces.
export function sha256Utf8(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// Fixed order: kind, then ref, then hash with null first; strings compared by code unit. The reader
// sorts with the same function, so "same sources" means the same sorted list.
export function compareSourceTuples(a: SourceTuple, b: SourceTuple): number {
  const c = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  if (a.source_kind !== b.source_kind) return c(a.source_kind, b.source_kind);
  if (a.source_ref !== b.source_ref) return c(a.source_ref, b.source_ref);
  // An absent hash is null (global constraints): normalise here so undefined vs 'a' is not a tie.
  const ah = a.source_hash ?? null;
  const bh = b.source_hash ?? null;
  if (ah === bh) return 0;
  if (ah === null) return -1;
  if (bh === null) return 1;
  return c(ah, bh);
}

function int(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`fingerprint: ${what} must be an integer (got ${String(v)})`);
  return v;
}

// The one serialisation (plan "Fingerprint serialisation"). Positional arrays only, so no key order can
// drift; evidence in INPUT order — the range is included because the same quote text can sit at two
// positions of one chunk ([0,13) vs [14,27), REVIEW-ALPHA2 §2.1).
export function fingerprintSerialization(f: FingerprintInput): string {
  const refs = f.refs.map((r) => r.kind === 'document'
    ? ['document', r.document_id, r.chunk_id, int(r.start, 'start'), int(r.end, 'end'), r.chunk_text_sha256, r.quote_sha256]
    : ['observation', r.observation_id, r.entity_id, int(r.revision_no, 'revision_no'), r.content_sha256,
       [...r.sources].sort(compareSourceTuples).map((s) => [s.source_kind, s.source_ref, s.source_hash ?? null])]);
  return JSON.stringify([FINGERPRINT_TAG, f.relationship_id, f.source_entity_id, f.target_entity_id,
    f.relation_type, f.source_name, f.target_name, f.kg_format, refs, int(f.profile_id, 'profile_id')]);
}
export function computeInputFingerprint(f: FingerprintInput): string {
  return sha256Utf8(fingerprintSerialization(f));
}
export function fingerprintFromMetadata(m: EvidenceChunkMetadataV1, profileId: number): string {
  return computeInputFingerprint({
    relationship_id: m.relationship_id, source_entity_id: m.source_entity_id, target_entity_id: m.target_entity_id,
    relation_type: m.relation_type, source_name: m.source_entity, target_name: m.target_entity,
    kg_format: EVIDENCE_FORMAT, refs: m.evidence_refs, profile_id: profileId,
  });
}

// Claim line (raw type, direction kept) + each quote verbatim in input order (D1). No IDs, hashes or
// internal state in the embedded text.
export function buildEvidenceBody(sourceName: string, relationType: string, targetName: string, quotes: string[]): string {
  return [`${sourceName} — ${relationType} — ${targetName}`, ...quotes].join('\n\n');
}
// Same deterministic id as the triplet chunk (index.ts:2311): one relationship chunk per relationship.
export function evidenceChunkId(relationshipId: string): string {
  return `kg_relationship_${relationshipId}`;
}

export function parseEvidenceMetadata(raw: string | null): EvidenceChunkMetadataV1 | null {
  if (raw === null) return null;
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== 'object' || (m as { kg_format?: unknown }).kg_format !== EVIDENCE_FORMAT) return null;
  return m as EvidenceChunkMetadataV1;
}

// D2⑤ comparison value. Evidence-v1: the stored fingerprint, but only if it still recomputes from the
// row's own metadata and belongs to this row (a hand-edited or foreign row is never "equal"). Legacy
// entity/triplet rows have no fingerprint field, so the value is derived at read time from the source
// identity + body hash. Anything missing returns null, and null is never equal (proposal D2⑤).
export function kgComparisonValue(row: KgChunkRow): string | null {
  if (row.text === null) return null;
  let meta: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.metadata ?? '{}');
    if (!parsed || typeof parsed !== 'object') return null;
    meta = parsed as Record<string, unknown>;
  } catch { return null; }
  if (meta.kg_format !== undefined) {
    if (meta.kg_format !== EVIDENCE_FORMAT || row.chunk_type !== 'relationship') return null;
    const m = meta as unknown as EvidenceChunkMetadataV1;
    if (typeof m.input_fingerprint !== 'string' || typeof m.fingerprint_profile_id !== 'number') return null;
    // A row without a source id is never equal (D2⑤), even if its metadata agrees with that null.
    if (typeof row.relationship_id !== 'string' || row.relationship_id === '') return null;
    if (m.relationship_id !== row.relationship_id) return null;
    for (const k of [m.source_entity_id, m.target_entity_id, m.source_entity, m.target_entity, m.relation_type]) {
      if (typeof k !== 'string' || k === '') return null;
    }
    try {
      if (fingerprintFromMetadata(m, m.fingerprint_profile_id) !== m.input_fingerprint) return null;
    } catch { return null; }
    return `fp:${m.input_fingerprint}`;
  }
  const sourceId = row.chunk_type === 'entity' ? row.entity_id : row.chunk_type === 'relationship' ? row.relationship_id : null;
  if (!sourceId) return null;
  return `legacy:${sha256Utf8(JSON.stringify([LEGACY_CMP_TAG, row.chunk_type, sourceId, sha256Utf8(row.text)]))}`;
}

// Taken immediately BEFORE inference; writeKgVectorIfCurrent (index.ts) re-checks all of it at write.
export function captureKgEmbedInput(row: KgChunkRow, profileId: number): KgEmbedCapture {
  return { rowid: row.rowid, chunk_id: row.chunk_id, text_sha256: sha256Utf8(row.text ?? ''), cmp: kgComparisonValue(row), profile_id: profileId };
}

// (resolvers are added by Tasks 5, 6 and 7 below this line)
export type { Database };
