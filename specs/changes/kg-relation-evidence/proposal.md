# kg-relation-evidence — opt-in evidence-backed relationship chunks, KG chunk lifecycle repairs, faster oversize split

> Status: **r3 — Phase 2 (scope challenge) + Phase 4 (contract), no code written.** r1 → α REVISE
> (hub `raw/advisor/2026-10-15-memory-sota/REVIEW-ALPHA-2_.md`) → r2 → α2 REVISE R1 reference identity · R2 return
> contract (`REVIEW-ALPHA2-2_.md`) → r3 applies both. α re-check pending.
> Owner opened the engine cycle 2026-10-16 (framework session 172: "1번 해라" over the session-171 list, item ②).
> Version, publish and whether KG chunks are ever enabled by default: owner.
> Evidence (framework hub, `raw/advisor/2026-10-15-memory-sota/`): `RESULT-RELEVIDENCE-2_.md` (design, defect
> table §3), `RESULT-NEXT-2_.md` (scope verdict, order, test list §5, Changed list §6), `RESULT-2_.md` §4.1,
> `LMEV2-SCALE.md` (chunker timing). All line numbers below are `7ac45b3` (6.4.0).

## Problem

Three things, kept apart because they have different causes.

1. **There is no way to put a relationship's evidence into its search chunk.** The dormant generator
   (`generateKnowledgeGraphChunks`, index.ts:2255–2329) writes every relationship as the fixed string
   `generateRelationshipChunkText(source, target, type)` (:2387). It does not read relationship metadata, and no public
   method accepts a caller-supplied body for a `chunk_type='relationship'` row (`storeDocument`/`chunkDocument` always
   write `chunk_type='document'` with a document_id, :2800·2856·2906). The "relation evidence" experiment (A4) cannot
   be run on the real KG path.
2. **The KG chunk lifecycle has defects that would surface the moment anyone turns KG chunks on.** Static reading,
   reproduced by RED tests first (C1):
   - ① deleting a relationship alone leaves its KG chunk, vector and FTS row searchable (`deleteRelations`
     :1501–1512 never calls the existing `deleteKgRelationshipChunks` helper, `src/observations/projection.ts:43`).
   - ④ `getDetailedContext` joins `documents` with an INNER JOIN (:4433–4460), so a KG chunk hit has no detail, while
     the search result says `full_context_available: true` (:4387).
   - ⑤ full regeneration deletes and rebuilds without an atomic swap (:2255–2329); `embedKnowledgeGraphChunks`
     (:2333–2377, :2394–2423) and the shared backfill (`src/backfillCoordinator.ts:464–480` → `index.ts:420` →
     `reembedChunkByRowid` :665, which re-reads only the rowid's text, :676–679) write a vector after `await`
     without checking that the input is still the one embedded.
   - A confidence update leaves the copied confidence in the KG chunk metadata stale (body unchanged → refresh
     metadata, no re-embed).
   - ② / ③ are **not** defects of today's triplet format (its body is names + type; confidence and observations are not
     inputs) and the entity-chunk drop on observation change is an intended fail-closed. They become requirements only
     for the new evidence format.
3. **`splitOversize` re-tokenizes every prefix** (`src/chunkerC.ts:113–133`, called :177–180): for a large block
   without blank lines it runs `enc.encode(cps.slice(start, probe).join(''))` once per added codepoint. Measured on
   macOS with no model loaded: 20k chars 4.6 s · 80k 21.3 s · 575k 162.2 s (`LMEV2-SCALE.md`). Correct output, wasted
   work, paid by any project that ingests logs, dumps, accessibility trees or minified code.

Not in scope, decided: doc2query and conditional HyDE (`RESULT-NEXT-2_` §1); the `hybridSearch` `limit` effect
(`limit` sets result cap and candidate depth, `limit×3`, so `limit30[:10] ≠ limit10`) stays as designed and is only
documented and pinned by a fixture (D4).

## Scope challenge (Phase 2c)

| # | Check | Answer |
|---|---|---|
| 1 | Reuse | `deleteKgRelationshipChunks` / `deleteStaleKgChunks` (projection.ts), the CAS *pattern* of the document path (:665–689, strengthened here, not copied), `getObservationHistory` (:1301), `getDetailedContext`'s document branch. No new table. We did not find an installed API that meets this contract as is (not a claim that none exists). |
| 2 | Minimum | Evidence path is **a manager method only** — no MCP tool, no registry/switch/allowlist entry, no default change, no automatic generation, no queue, no relation-type translation, no LLM. The no-argument `generateKnowledgeGraphChunks()` keeps producing today's triplets. |
| 3 | Complexity smell | Yes: at least 10 files (index.ts, projection.ts, backfillCoordinator.ts or the callback, chunkerC.ts, knowledge-graph-tools.ts description, package.json, ≥4 new tests) plus the three tests that assert the chunking signature string. **Two independent commits** on one branch, one release: (A) KG = Problem 1+2, (B) chunker = Problem 3. |
| 4 | Built-in | tiktoken has no incremental encoder that keeps our non-monotonic-prefix contract. |
| 5 | Test target | Every changed writer/reader has a positive and a negative case that goes through real embedding and `hybridSearch`, not metadata counts (§Contract). |

## Design (r2)

**D1 Evidence-backed relationship chunks (opt-in, snapshot contract).**
`generateRelationEvidenceChunks(items, { formatVersion: 'evidence-v1' })` — manager method, not exposed over MCP.

- **Snapshot semantics.** `items` is the **complete set S** of relationships that get a relationship chunk. A
  successful call atomically replaces *all* relationship KG chunks with evidence-v1 chunks for S; no triplet or
  evidence chunk outside S survives. Entity KG chunks, documents and relationship rows are untouched. `items = []`
  is valid and empties relationship KG chunks. Relationships outside S stay reachable through `searchNodes` /
  `getNeighbors` (policy (d)).
- **All or nothing.** Any invalid item rejects the **whole call before any write**; a failure while building
  publishes nothing. Within an item, no evidence entry is ever dropped silently.
- **Item** = `{ relationship_id, evidence: [≥1 entry], support?: { why_status: 'reason-stated' | 'relation-only' |
  'unjudged' (default), valid_time?: string, scope_note?: string } }`. `support` is the caller's judgement, stored as
  a label; the engine does not judge meaning and never writes a reason. `valid_time` only when the source states one;
  `relationships.created_at` is never copied as fact time.
- **Evidence entry**:
  - `{ kind: 'document', chunk_id, start, end, quote_sha256 }` — the chunk must be `chunk_type='document'` with a row
    in `documents` (no KG or derived chunk); `start`/`end` are finite integers, `0 ≤ start < end ≤` codepoint count of
    `chunk.text` (codepoints, not UTF-16); `quote_sha256` = SHA-256 of the UTF-8 bytes of exactly that substring, no
    normalisation, no newline rewriting.
  - `{ kind: 'observation', observation_id, revision_no, content_sha256 }` — that revision must be the **current
    active** one with that content; a readable historical revision is not current evidence. There is no observation
    range input: the quoted unit is the **whole current content** (it counts against the quote cap; a long observation
    is never cut).
- **Rejected**: unknown relationship_id · duplicate relationship_id in one call · empty `evidence` · range/hash/type
  failures above · input over the fixed caps — **1–8 evidence entries per item**, **≤ 4,000 codepoints per quote**
  (document range, or whole observation content), **≤ 8,000 codepoints of final body** (claim line incl. both names, raw
  type, separators and newlines, plus all quotes; both the per-quote and the body cap are checked — 8 × 4,000 does not
  fit 8,000). Lengths are counted in codepoints, never JS UTF-16 `.length`. Caps are policy limits for this experiment,
  not a claim of sufficiency; over-cap is refused, never truncated, and the engine never drops an item from S to fit.
- **Engine-derived metadata** (not caller input) in `chunk_metadata.metadata`: `kg_format:'evidence-v1'`,
  relationship id, source/target entity ids, raw `relationType`, direction; per document entry the `document_id`, the
  **whole chunk text hash**, the quote range and hash; per observation the owner `entity_id`, revision, content hash,
  status at generation and **every stored source as `(source_kind, source_ref, source_hash | null)`** sorted by those
  three fields (summary label `unrecorded` when there is no source row, `import-only` when every source is an import —
  the label never replaces the real rows; no hash is invented and no external file is opened to fill one; a stored
  `source_hash` is not a claim that the external original still matches); `support` labels;
  `generated_ref_status:'refs-resolved'` (the state **at generation**, not the reader's current state);
  `input_fingerprint` (below); body codepoint count. The engine does not claim the body
  was embedded in full when it did not check the model's truncation — it records `embedded_truncation: 'unchecked'`.
- **Body** = claim line (`source — relationType — target`, raw type, direction kept) + each quote verbatim, in
  input order. No IDs, hashes or internal state in the embedded text.
- **`input_fingerprint`** = SHA-256 over a fixed serialisation (field order, array order, numbers/null and UTF-8 encoding
  fixed in Phase 3; quote text never normalised) of: relationship id, source/target ids, raw type, the two names used in
  the body, `kg_format`, then the evidence entries **in input order**, each as
  document `(kind, document_id, chunk_id, start, end, chunk_text_sha256, quote_sha256)` or
  observation `(kind, observation_id, owner entity_id, revision_no, content_sha256, sorted source tuples)`, and the
  embedding profile id. Range is included because the same quote text can sit at two positions of one chunk
  (`A supports B.\nA supports B.` = `[0,13)` vs `[14,27)`, same hashes). **Not** confidence, not arbitrary relationship
  metadata.
- **Commit re-check.** Bodies are prepared first; inside the commit transaction every item's fingerprint is
  recomputed from the current rows and must match the prepared one; a change between preparation and commit fails
  the call.
- One relationship chunk per relationship, by deterministic chunk ID plus clean-up of the existing row (no new unique
  migration in this cycle).
- "Evidence-backed" means **caller-selected evidence whose references the engine verified exist verbatim**. It is not
  an independent proof of the relation; wording in docs and metadata says so.

**D2 Lifecycle (Problem 2).**
- ① `deleteRelations` deletes the relationship's KG chunk, vector and FTS row in the same transaction as the row.
- ② confidence/metadata updates refresh the copied display metadata in place, never touching `kg_format`,
  evidence refs or `input_fingerprint`; body unchanged → no re-embed. A change to any `input_fingerprint` input
  invalidates the evidence chunk (delete, fail-closed).
- ③ observation writers (create/add incl. source-only dedup that reaches the shared change path at :1168–1189,
  correct, retract, restore, approve, decline, purge, import) invalidate evidence-v1 relationship chunks that cite the
  changed observation, collected **before** the mutation and deleted in the same transaction. Document writers
  (`syncDocumentFromFile` replace :2788–2807, `cleanupDocument` :3398–3421, `deleteDocument(s)` :3449·3521,
  re-chunking that reuses an ordinal chunk ID) invalidate evidence chunks that cite their chunks — **also collect →
  change source → invalidate in one transaction**, no separate deletion moment. Dependencies are read from evidence
  metadata, not inferred from `observation_sources.source_ref` (a string, not an FK).
- **No regeneration queue (Q2 decided).** After invalidation the stale chunk is gone from search and **may stay
  absent until the next explicit `generateRelationEvidenceChunks` call**. The engine does not rebuild S from deleted
  metadata; the caller keeps its item list and re-judges whether a new revision still supports the relation. The
  existing missing-vector backfill keeps running; recreating deleted evidence metadata is not its job.
- ④ `getDetailedContext` branches on `chunk_type`, keeping the document branch's shape unchanged:
  - document → as today;
  - entity → entity + its **active** observations (history stays with `getObservationHistory`);
  - relationship → relationship row + aggregate `evidence_status` + per-reference array `evidence_refs[]`:

    | case | `evidence_status` | `evidence_refs[]` |
    |---|---|---|
    | legacy triplet | `claim_only` | empty (no source reference exists) |
    | evidence-v1, every reference matches now (id, hash, current active) | `refs_available` | each `available` |
    | evidence-v1, any reference missing / inactive / historical / hash-mismatched, or a malformed/empty reference list | `refs_unavailable` | resolved ones `available`, others `missing` or `mismatch` (an inactive or historical revision is `mismatch`, never `available`) |

    The status is reference resolution, not a truth verdict; the caller's `why_status` is returned as stored.
  - **Return shape, scoped to `getDetailedContext`'s new KG branch only**: `document_id: null`, `document_title: null`,
    `source_kind: 'entity' | 'relationship'`, `source_id` = the KG source id. The document branch keeps today's string
    fields and shape (the `DetailedContext` type is split into document / KG variants). **`hybridSearch` results are
    unchanged** — KG hits keep today's `document_title` ("Knowledge Graph Entity/Relationship"), `chunk_type` and
    `source_id` types and meaning.
  - `full_context_available` (search) and the detail call mean **"the stored body can be resolved"**: true for a legacy
    triplet whose relationship row exists (with `claim_only`), true for an evidence-v1 chunk with a missing reference
    (with `refs_unavailable`); when the relationship/entity row itself is gone the detail call fails as an unknown
    chunk does today and search reports `false`. It is documented as **not** a verified-evidence signal.
- ⑤ regeneration builds new rows first and swaps them in one transaction. Both KG embedding writers — the dedicated
  `embedKnowledgeGraphChunks` and the shared backfill callback when the row is a KG row — capture
  `chunk_id + text hash + comparison value + profile id` immediately before inference and re-check all four at write;
  any mismatch drops the vector (the current metadata, if still present, is picked up by the normal backfill).
  - comparison value = `input_fingerprint` for evidence-v1; for **legacy entity/triplet rows** (no fingerprint field) a
    value derived at read time from the source identity (`entity_id` or `relationship_id`) + body text hash — a missing
    field is never treated as "equal".
  - profile: the profile captured is the one current **when inference starts**. A profile change before inference
    starts = normal: embed with the new profile and record the fingerprint for that profile. A change during inference
    = drop the result. The stored fingerprint never stays pinned to an outdated profile.
  - The document path's existing contract is kept and regression-tested separately.

**D3 Oversize split (Problem 3).** Find a candidate boundary without re-encoding every prefix (e.g. estimate from
encoded length, then verify), with the contract the tests assert: lossless concatenation, contiguous codepoint
offsets, every chunk's **actual** `encode` length ≤ max, determinism, always advance. Any boundary difference on
fallback input is surfaced through `effectiveSignature` (chunkerC.ts:23–33); an unchanged-content sync still never
re-chunks (:2709–2727). Inputs that never reach the fallback split keep byte-identical boundaries.

**D4 `limit` documentation.** Tool description + CODE_CONTEXT: `limit` is both the result cap and the candidate depth;
for comparisons fix the call `limit` and cut `k` from the returned list. A fixture pins that even top-1 can differ
(target `(vec 4, fts 1)` vs competitor `(vec 3, fts 2)`: limit 1 → competitor first; limit 2 → target first,
`0.03201844 > 0.03200205`). No algorithm change, no new argument.

## Contract — Definition of Done

- **C1** RED first on 6.4.0, recorded, after a positive control is shown to retrieve: ① delete leftover, ④ detail
  failure + wrong availability flag, ⑤ stale write (dedicated and backfill path), stale confidence copy, oversize
  re-encode cost. The new method's absence and the intended fail-closed ③ are **not** counted as 6.4.0 defects. A
  test that could not run (model unavailable, environment) is "not run", never "did not reproduce → drop".
- **C2** Evidence-v1 through a real generation commit: accepted valid batch; each rejection (non-document chunk,
  empty evidence, non-integer / out-of-range / UTF-16-vs-codepoint range incl. astral and CRLF text, wrong hash,
  non-active or historical revision, duplicate relationship id, over-cap at both edges — 8 vs 9 entries, 4,000 vs 4,001
  and 8,000 vs 8,001 codepoints incl. astral/CRLF, the exact-cap input succeeding first) rejects the whole call with
  **zero** writes; the same quote text at two ranges of one chunk yields two different fingerprints;
  valid A + invalid B writes nothing; previously generated non-S triplets and evidence chunks are gone after a
  successful call; `items=[]` empties relationship chunks; same input twice = same rows (idempotent); a real
  `hybridSearch(q,10,false)` returns the evidence chunk for a query only its quote answers; relationship rows and
  `getNeighbors` unchanged for relations outside S.
- **C3** Invalidation through search (vector, FTS and `getDetailedContext` all clean): relationship delete; cited
  observation correct · retract · restore · approve · decline · purge; source-only dedup on a cited observation;
  cited document replace · delete · re-chunk with a reused ordinal ID; confidence-only update = metadata refreshed and
  **zero** re-embeds. After a caller re-generates with new valid input, the new fact is retrieved (positive). A purged
  reference is rejected on re-generation.
- **C4** `getDetailedContext` for document (string fields and shape unchanged), entity (active only; a superseded
  revision does not appear), legacy relationship (`claim_only`, body readable), evidence-v1 all-resolved
  (`refs_available`), one reference missing, content/revision mismatch, inactive history (`refs_unavailable` with the
  right per-reference values), relationship row gone (detail fails, search `false`) — status fields **and** returned
  content checked; a variant that marks "body readable" as evidence-verified is rejected.
- **C5** Counter-examples at the commit/CAS decision point itself, for the dedicated KG writer **and** the shared
  backfill: delete during await; same rowid reused; same text under a different chunk_id; **same chunk_id + same text
  + same profile but a different `input_fingerprint`**; cited source changed between validation and commit; profile
  switched during inference (dropped) vs switched before inference (embedded under the new profile, fingerprint
  updated); mid-generation failure → nothing published; **positive** controls: a legacy entity/triplet row and an
  evidence-v1 row with unchanged inputs are embedded normally by both the dedicated path and backfill.
- **C6** Chunker: invariant and golden tests for inputs that never reach the fallback stay unchanged (text and
  offsets); the three tests asserting the signature string (`test/chunker-c.test.mjs:162`,
  `chunk-params-validation.test.mjs:37`, `stats-chunking.test.mjs:25`) are updated only for an intended signature
  change, never by re-stamping body/offset goldens; existing edge cases (`/sdkX,max=1 → ['/sdk','X']`, `🎉,max=1`,
  UTF-8 cut negative control) kept; new CJK/astral/CRLF, blank-line-free accessibility tree / JSON / minified, small
  max and 800; the 20k / 80k / ~575k inputs record encode-call count, time and memory before/after — a passing
  function test with unchanged time is not done.
- **C7** Default behaviour unchanged where nothing opted in:
  1. frozen hub copy, KG chunks not generated: `hybridSearch(q,10,false)` for K53/P20/B20/ID20 (113 queries) returns
     identical ordered IDs **and raw scores** for the 6.4.0 dist vs the new dist (both recorded by hash, same
     model/profile/health/dictionary/limit, corpus and qrel hashes recorded);
  2. ordinary entity/observation/relation CRUD and document ingest create no KG metadata, and no new MCP tool is
     listed (`test/tool-contracts.test.mjs` counts unchanged); `hybridSearch` KG results keep their field types
     (`document_title` string, `chunk_type`, `source_id`) — ID/score equality alone would not catch a type change;
  3. the no-argument `generateKnowledgeGraphChunks()` produces the same entity/triplet bodies, IDs and counts as
     6.4.0 (the deliberate ① ④ ⑤ fixes excepted);
  4. on a separate fixture, `chunkDocument` and `syncDocumentFromFile` produce identical text/codepoint boundaries
     for structure-split input, and an unchanged-content sync does not re-chunk because the signature changed.
- **C8** `npm test > log 2>&1` run so that **npm's own exit code** is what the harness sees (not an `echo` after it),
  exit 0, every new test wired into `verify:engine`, and a deliberately failing test shown to make the aggregate
  command non-zero.

## Changed (behaviour, not a version number)

1. New opt-in manager method replaces relationship KG chunks with evidence-backed chunks for a caller-supplied set,
   built from verified quotes/observations; relationships outside the set get no chunk. Not exposed over MCP. Default
   behaviour and the no-argument triplet generator unchanged.
2. Deleting a relationship, or changing/removing a cited observation or document, removes the stale KG chunk from
   search immediately. **It is not regenerated automatically** — the chunk stays absent until the caller generates
   again. Confidence-only updates refresh metadata without re-embedding.
3. `getDetailedContext` returns type-appropriate detail for KG chunks with an explicit evidence status (`claim_only` /
   `refs_available` / `refs_unavailable` + per-reference `available`/`missing`/`mismatch`) and `document_id: null`,
   `document_title: null` **in its KG branch only**. Document detail and all `hybridSearch` result fields are unchanged.
4. A failed full regeneration publishes nothing; an embedding computed for an input that changed meanwhile (text,
   evidence fingerprint or profile) is dropped, on the dedicated KG path and in background backfill.
5. Oversize blocks split faster; if boundaries differ, the chunking signature says so and only new/changed/explicitly
   re-chunked input is affected.
6. Documentation: `limit` sets result count and candidate depth (no algorithm change).

## Decisions (were open in r1)

- **Q1** Raw `relationType` in the body; no translation registry, no restatement.
- **Q2** Caller-driven regeneration, no engine queue (this cycle's need is a generate-once frozen experiment).
- **Q3** The new method is not reachable over MCP; repairing the existing detail tool's KG branch is separate from that.

## Stop points

1. After α re-check: REVISE → revise this file, do not start the plan.
2. After C1: a listed defect whose RED test **runs and passes on 6.4.0** is dropped from the change; a test that could
   not run is reported as not run, not as absent.
3. Before publish: owner.
