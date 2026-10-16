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
    // Identifiers must be non-empty; names and the raw type are stored as-is and may legitimately be
    // empty strings (the engine accepts them), so for those only a non-string is "missing".
    for (const k of [m.source_entity_id, m.target_entity_id]) {
      if (typeof k !== 'string' || k === '') return null;
    }
    for (const k of [m.source_entity, m.target_entity, m.relation_type]) {
      if (typeof k !== 'string') return null;
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

// ---- D1 resolution (generation AND commit re-check run exactly this) ----

export class EvidenceInputError extends Error {
  constructor(readonly code: string, readonly itemIndex: number, detail: string) {
    super(`generateRelationEvidenceChunks: item ${itemIndex}: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'EvidenceInputError';
  }
}
export class EvidenceCommitConflictError extends Error {
  constructor(readonly itemIndex: number, readonly reason: string) {
    super(`generateRelationEvidenceChunks: item ${itemIndex} changed between preparation and commit: ${reason}`);
    this.name = 'EvidenceCommitConflictError';
  }
}

const WHY_STATUSES: readonly WhyStatus[] = ['reason-stated', 'relation-only', 'unjudged'];

// Every stored source of an observation, sorted (D1: the real rows, never a summary label).
export function readSourceTuples(db: Database.Database, observationId: string): SourceTuple[] {
  const rows = db.prepare(`SELECT source_kind, source_ref, source_hash FROM observation_sources WHERE observation_id = ?`)
    .all(observationId) as Array<{ source_kind: string; source_ref: string; source_hash: string | null }>;
  return rows.map(r => ({ source_kind: r.source_kind, source_ref: r.source_ref, source_hash: r.source_hash ?? null }))
    .sort(compareSourceTuples);
}
function sourceSummary(sources: SourceTuple[]): ObservationRefMeta['source_summary'] {
  if (sources.length === 0) return 'unrecorded';
  return sources.every(s => s.source_kind === 'import') ? 'import-only' : 'recorded';
}

// Validate one item against the CURRENT rows and build its body + metadata. Any failure throws
// EvidenceInputError; nothing is written here. Order matters for the commit re-check
// (REVIEW-ALPHA3 §3.1): an observation's ACTIVE status and a document chunk's type/parent are checked
// before any hash or fingerprint, because a retract keeps id, revision and content and changes only
// the status (lifecycle.ts:146-147) — the fingerprint alone cannot see it.
export function resolveEvidenceItem(db: Database.Database, item: EvidenceItemInput, itemIndex: number, profileId: number): PreparedEvidenceChunk {
  const fail: (code: string, detail?: string) => never = (code, detail = '') => { throw new EvidenceInputError(code, itemIndex, detail); };
  if (!item || typeof item !== 'object') fail('invalid-item');
  if (typeof item.relationship_id !== 'string' || item.relationship_id === '') fail('invalid-item', 'relationship_id');
  if (!Array.isArray(item.evidence) || item.evidence.length === 0) fail('empty-evidence');
  if (item.evidence.length > EVIDENCE_CAPS.maxEntries) fail('too-many-entries', `${item.evidence.length} > ${EVIDENCE_CAPS.maxEntries}`);
  const rel = db.prepare(`
    SELECT r.id, r.source_entity, r.target_entity, r.relationType, r.confidence,
           e1.name AS source_name, e2.name AS target_name
    FROM relationships r
    JOIN entities e1 ON e1.id = r.source_entity
    JOIN entities e2 ON e2.id = r.target_entity
    WHERE r.id = ?`).get(item.relationship_id) as {
      id: string; source_entity: string; target_entity: string; relationType: string; confidence: number;
      source_name: string; target_name: string } | undefined;
  if (!rel) return fail('unknown-relationship', item.relationship_id);
  // kgComparisonValue (D2⑤) never accepts an empty endpoint id, so a chunk published with one could never
  // be embedded by either CAS path. The schema has no non-empty CHECK and importGraph copies ids as given,
  // so the shared preparation/commit resolver checks it before any write. Names and the raw type may
  // legitimately be empty; only the ids are identifiers (REVIEW-T5-2_ I2).
  if (typeof rel.source_entity !== 'string' || rel.source_entity === '' || typeof rel.target_entity !== 'string' || rel.target_entity === '') {
    return fail('invalid-relationship-endpoint', item.relationship_id);
  }

  const refs: EvidenceRefMeta[] = [];
  const quotes: string[] = [];
  // Array.from visits every index; forEach alone skips holes, so new Array(1) passed the 1–8 count with zero
  // resolved entries and [ref, <hole>] dropped one silently (D1: at least one entry, none dropped;
  // REVIEW-T5-2_ I1). This is a JS manager API, so no JSON layer turns holes into null first. A hole
  // reads as undefined and fails as an invalid entry.
  Array.from(item.evidence).forEach((e, j) => {
    if (!e || typeof e !== 'object') return fail('unknown-evidence-kind', `entry ${j}${j in item.evidence ? '' : ': hole'}`);
    if (e.kind === 'document') {
      if (typeof e.chunk_id !== 'string') return fail('unknown-chunk', `entry ${j}`);
      const c = db.prepare(`
        SELECT m.chunk_id, m.chunk_type, m.document_id, m.text, d.id AS doc_id
        FROM chunk_metadata m LEFT JOIN documents d ON d.id = m.document_id
        WHERE m.chunk_id = ?`).get(e.chunk_id) as {
          chunk_id: string; chunk_type: string | null; document_id: string | null; text: string | null; doc_id: string | null } | undefined;
      if (!c) return fail('unknown-chunk', `entry ${j}: ${e.chunk_id}`);
      if (c.chunk_type !== 'document' || c.document_id === null || c.doc_id === null || c.text === null) {
        return fail('not-a-document-chunk', `entry ${j}: ${e.chunk_id}`);
      }
      if (typeof e.start !== 'number' || typeof e.end !== 'number' || !Number.isInteger(e.start) || !Number.isInteger(e.end)) {
        return fail('range-not-integer', `entry ${j}`);
      }
      const n = cpLength(c.text);
      if (!(0 <= e.start && e.start < e.end && e.end <= n)) return fail('range-out-of-bounds', `entry ${j}: [${e.start},${e.end}) of ${n} codepoints`);
      if (e.end - e.start > EVIDENCE_CAPS.maxQuoteCodepoints) return fail('quote-over-cap', `entry ${j}: ${e.end - e.start} codepoints`);
      const quote = cpSlice(c.text, e.start, e.end);
      if (sha256Utf8(quote) !== e.quote_sha256) return fail('quote-hash-mismatch', `entry ${j}`);
      refs.push({ kind: 'document', document_id: c.document_id, chunk_id: c.chunk_id, start: e.start, end: e.end,
                  chunk_text_sha256: sha256Utf8(c.text), quote_sha256: e.quote_sha256 });
      quotes.push(quote);
      return;
    }
    if (e.kind === 'observation') {
      if (typeof e.observation_id !== 'string') return fail('unknown-observation', `entry ${j}`);
      const o = db.prepare(`SELECT observation_id, entity_id, revision_no, content, status FROM entity_observations WHERE observation_id = ?`)
        .get(e.observation_id) as { observation_id: string; entity_id: string; revision_no: number; content: string; status: string } | undefined;
      if (!o) return fail('unknown-observation', `entry ${j}: ${e.observation_id}`);
      if (o.status !== 'active') return fail('observation-not-active', `entry ${j}: status ${o.status}`);
      if (o.revision_no !== e.revision_no) return fail('observation-revision-mismatch', `entry ${j}`);
      if (sha256Utf8(o.content) !== e.content_sha256) return fail('observation-content-mismatch', `entry ${j}`);
      const len = cpLength(o.content);   // the quoted unit is the WHOLE current content; never cut
      if (len > EVIDENCE_CAPS.maxQuoteCodepoints) return fail('quote-over-cap', `entry ${j}: ${len} codepoints`);
      const sources = readSourceTuples(db, o.observation_id);
      refs.push({ kind: 'observation', observation_id: o.observation_id, entity_id: o.entity_id, revision_no: o.revision_no,
                  content_sha256: e.content_sha256, status_at_generation: 'active', sources, source_summary: sourceSummary(sources) });
      quotes.push(o.content);
      return;
    }
    return fail('unknown-evidence-kind', `entry ${j}`);
  });

  const sup: EvidenceSupportInput = item.support === undefined ? {} : item.support;
  if (sup === null || typeof sup !== 'object') fail('invalid-support');
  const why = sup.why_status ?? 'unjudged';
  if (!WHY_STATUSES.includes(why)) fail('invalid-support', `why_status ${String(why)}`);
  if (sup.valid_time !== undefined && typeof sup.valid_time !== 'string') fail('invalid-support', 'valid_time');
  if (sup.scope_note !== undefined && typeof sup.scope_note !== 'string') fail('invalid-support', 'scope_note');

  const text = buildEvidenceBody(rel.source_name, rel.relationType, rel.target_name, quotes);
  const bodyCp = cpLength(text);
  if (bodyCp > EVIDENCE_CAPS.maxBodyCodepoints) fail('body-over-cap', `${bodyCp} codepoints`);
  const fp = computeInputFingerprint({
    relationship_id: rel.id, source_entity_id: rel.source_entity, target_entity_id: rel.target_entity,
    relation_type: rel.relationType, source_name: rel.source_name, target_name: rel.target_name,
    kg_format: EVIDENCE_FORMAT, refs, profile_id: profileId,
  });
  const metadata: EvidenceChunkMetadataV1 = {
    kg_format: EVIDENCE_FORMAT,
    relationship_id: rel.id, source_entity_id: rel.source_entity, target_entity_id: rel.target_entity,
    source_entity: rel.source_name, target_entity: rel.target_name, relation_type: rel.relationType, direction: 'source->target',
    confidence: rel.confidence,
    evidence_refs: refs,
    support: { why_status: why, valid_time: sup.valid_time ?? null, scope_note: sup.scope_note ?? null },
    generated_ref_status: 'refs-resolved',
    input_fingerprint: fp, fingerprint_profile_id: profileId,
    body_codepoints: bodyCp,
    embedded_truncation: 'unchecked',
    evidence_semantics: EVIDENCE_SEMANTICS,
  };
  return { chunk_id: evidenceChunkId(rel.id), relationship_id: rel.id, text, body_codepoints: bodyCp, metadata };
}

// ---- D2④ reader: reference resolution (NOT a truth verdict) ----

export type EvidenceStatus = 'claim_only' | 'refs_available' | 'refs_unavailable';
export interface EvidenceRefStatus { index: number; kind: string; status: 'available' | 'missing' | 'mismatch'; ref: unknown; text: string | null }

// legacy triplet -> claim_only, no refs. evidence-v1 -> each reference resolved against the CURRENT
// rows; all available -> refs_available, anything else (missing, mismatch, malformed or empty list) ->
// refs_unavailable. An inactive or historical revision is 'mismatch', never 'available'.
export function resolveEvidenceStatus(db: Database.Database, meta: Record<string, unknown> | null): { status: EvidenceStatus; refs: EvidenceRefStatus[] } {
  if (!meta || meta.kg_format === undefined) return { status: 'claim_only', refs: [] };
  const list = meta.kg_format === EVIDENCE_FORMAT && Array.isArray(meta.evidence_refs) ? (meta.evidence_refs as unknown[]) : null;
  if (!list || list.length === 0) return { status: 'refs_unavailable', refs: [] };
  const refs = list.map((r, i) => resolveOneRef(db, r, i));
  return { status: refs.every(r => r.status === 'available') ? 'refs_available' : 'refs_unavailable', refs };
}

// R4 (REVIEW-PLAN): structure is checked at runtime before any field is used — `as SourceTuple[]` is not
// a check, and `sources: [null]` used to reach `s.source_kind`. A structurally malformed reference is
// 'mismatch' (so the chunk is refs_unavailable), never a TypeError. Real DB errors are NOT caught here.
const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
export function isSourceTuple(v: unknown): v is SourceTuple {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return isStr(s.source_kind) && isStr(s.source_ref) && (s.source_hash === null || isStr(s.source_hash));
}
export function isWellFormedRef(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.kind === 'document') {
    return isStr(r.document_id) && isStr(r.chunk_id) && isInt(r.start) && isInt(r.end) && isStr(r.chunk_text_sha256) && isStr(r.quote_sha256);
  }
  if (r.kind === 'observation') {
    return isStr(r.observation_id) && isStr(r.entity_id) && isInt(r.revision_no) && isStr(r.content_sha256)
      && Array.isArray(r.sources) && r.sources.every(isSourceTuple);
  }
  return false;
}

function resolveOneRef(db: Database.Database, raw: unknown, index: number): EvidenceRefStatus {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = (status: EvidenceRefStatus['status'], text: string | null = null): EvidenceRefStatus =>
    ({ index, kind: typeof r.kind === 'string' ? r.kind : 'unknown', status, ref: raw, text });
  if (!isWellFormedRef(raw)) return out('mismatch');
  if (r.kind === 'document') {
    const c = db.prepare(`
      SELECT m.chunk_type, m.document_id, m.text, d.id AS doc_id
      FROM chunk_metadata m LEFT JOIN documents d ON d.id = m.document_id WHERE m.chunk_id = ?`)
      .get(r.chunk_id as string) as { chunk_type: string | null; document_id: string | null; text: string | null; doc_id: string | null } | undefined;
    if (!c || c.doc_id === null) return out('missing');
    if (c.chunk_type !== 'document' || c.document_id !== r.document_id || c.text === null) return out('mismatch');
    if (sha256Utf8(c.text) !== r.chunk_text_sha256) return out('mismatch');
    if (typeof r.start !== 'number' || typeof r.end !== 'number' || !Number.isInteger(r.start) || !Number.isInteger(r.end)) return out('mismatch');
    if (!(0 <= r.start && r.start < r.end && r.end <= cpLength(c.text))) return out('mismatch');
    const quote = cpSlice(c.text, r.start, r.end);
    if (sha256Utf8(quote) !== r.quote_sha256) return out('mismatch');
    return out('available', quote);
  }
  if (r.kind === 'observation') {
    const o = db.prepare(`SELECT entity_id, revision_no, content, status FROM entity_observations WHERE observation_id = ?`)
      .get(r.observation_id as string) as { entity_id: string; revision_no: number; content: string; status: string } | undefined;
    if (!o) return out('missing');
    if (o.status !== 'active' || o.entity_id !== r.entity_id || o.revision_no !== r.revision_no || sha256Utf8(o.content) !== r.content_sha256) {
      return out('mismatch');
    }
    const now = readSourceTuples(db, r.observation_id as string).map(s => [s.source_kind, s.source_ref, s.source_hash]);
    const stored = [...(r.sources as SourceTuple[])].sort(compareSourceTuples).map(s => [s.source_kind, s.source_ref, s.source_hash]);
    if (JSON.stringify(now) !== JSON.stringify(stored)) return out('mismatch');
    return out('available', o.content);
  }
  return out('mismatch');
}

// ---- D2③ dependency lookups ----
// Dependencies are read from the evidence metadata the generator wrote, never inferred from
// observation_sources.source_ref (a string, not an FK). A row that says evidence-v1 but cannot be
// parsed, whose evidence_refs is not an array, or that holds ANY entry failing isWellFormedRef (the
// same structural rule the reader uses: null, {}, an unknown kind, bad field types, malformed source
// tuples) is returned by every lookup: it cannot be verified, so any writer that calls a lookup removes
// it (fail-closed, REVIEW-PLAN R4).
interface EvidenceRowView { rowid: number; refs: unknown[] | null }
function evidenceRowViews(db: Database.Database): EvidenceRowView[] {
  const rows = db.prepare(
    `SELECT rowid, metadata FROM chunk_metadata WHERE chunk_type = 'relationship' AND metadata LIKE '%evidence-v1%'`
  ).all() as Array<{ rowid: number; metadata: string | null }>;
  const out: EvidenceRowView[] = [];
  for (const r of rows) {
    let m: unknown;
    try { m = JSON.parse(r.metadata ?? 'null'); } catch { out.push({ rowid: r.rowid, refs: null }); continue; }
    if (!m || typeof m !== 'object') { out.push({ rowid: r.rowid, refs: null }); continue; }
    const meta = m as Record<string, unknown>;
    if (meta.kg_format !== EVIDENCE_FORMAT) continue;      // a legacy row that merely mentions the string
    out.push({ rowid: r.rowid, refs: Array.isArray(meta.evidence_refs) ? meta.evidence_refs : null });
  }
  return out;
}
function collectCiting(db: Database.Database, hit: (ref: Record<string, unknown>) => boolean): number[] {
  return evidenceRowViews(db)
    .filter(v => v.refs === null || v.refs.length === 0 || v.refs.some(r => !isWellFormedRef(r) || hit(r as Record<string, unknown>)))
    .map(v => v.rowid);
}
export function collectEvidenceRowidsCitingObservations(db: Database.Database, observationIds: string[]): number[] {
  if (observationIds.length === 0) return [];
  const ids = new Set(observationIds);
  return collectCiting(db, r => r.kind === 'observation' && typeof r.observation_id === 'string' && ids.has(r.observation_id));
}
export function collectEvidenceRowidsCitingDocument(db: Database.Database, documentId: string): number[] {
  return collectCiting(db, r => r.kind === 'document' && r.document_id === documentId);
}
export function collectEvidenceRowidsCitingOwnerEntity(db: Database.Database, entityId: string): number[] {
  return collectCiting(db, r => r.kind === 'observation' && r.entity_id === entityId);
}
