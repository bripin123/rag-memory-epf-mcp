# search-fusion-rrf — summaries opt-in, rank fusion instead of an additive FTS crumb

> Status: **r3 — implemented on branch `feat/search-fusion-rrf`; codex design review r2 and code review r3 applied**
> (2026-10-03, framework hub session 134). C7 met under contention (upper bound). Version and publish: owner.
> Evidence (framework hub): `raw/advisor/2026-10-03-ruflo-principles/` — `RESULT-s0.md`, `s0/` (scripts,
> pre-declarations, raw outputs), `r2/RESULT-r2-2_.md` (codex review), `r2/` C5 outputs.

## Problem

Two defects in `hybridSearch`'s scoring step (`finalScore = Math.max(vectorSimilarity, relevanceScore) + graphBoost + ftsBoost`):

1. **The summary path ran by default.** Unless `RAG_MEMORY_SEARCH_SUMMARIES=off`, every candidate (`limit*3` per
   cross-lingual variant, the union can be larger) was split on `.!?` and every fragment embedded one at a time —
   about 400 inferences per search on the measured corpus (an approximation, not a fixed cost). The max fragment
   similarity then received an unbounded context boost (+0.1 per linked entity mentioned, +0.05 for a digit, +0.03
   for an importance word) and could replace the vector similarity inside `max(...)`: chunks with vector
   similarity 0 scored 1.2-1.7 and took rank 1.
2. **With summaries off, an FTS-only chunk scored at most `1/61 ≈ 0.0164`** while the vector candidates of the
   measured corpora scored about 0.4-0.6, so it sat below all of them. (Not impossible in general: it can enter
   when there are fewer vector candidates than `limit` or their similarities are tiny.)

## Measured (frozen 2026-08-22 eval snapshots, macOS, one machine)

| Set | Arm | hit@1 | hit@10 | MRR |
|---|---|---|---|---|
| hub K dev, pre-declared sample 10 | 6.3.2 summaries off / on | 9 / 4 | 10 / 9 | 0.950 / 0.539 |
| hub exact-identifier 20 (string in 1-2 chunks) | 6.3.2 formula, off | 3 | 7 | 0.202 |
| same | **RRF k=60** | **7** | **18** | **0.600** |
| hub paraphrase 20 (same targets) | 6.3.2 / RRF | 2 / 2 | 6 / 7 | 0.174 / 0.217 |
| hub K dev 53 | 6.3.2 / RRF | 47 / 49 | 51 / 51 | 0.920 / 0.943 |
| uap K dev 54 (post-hoc) | 6.3.2 / RRF | 47 / 49 | 51 / 53 | 0.907 / 0.938 |
| hal K dev 56 (post-hoc) | 6.3.2 / RRF | 51 / 51 | 56 / 56 | 0.947 / 0.955 |

Latency (hub sample): 6.3.2 summaries on median 121 s; summaries off median 22.5 ms with the query embedding
cached and 446 ms on the first call (query embedding computed).
RRF was chosen between two pre-declared arms; the 203 queries are development data (C5 below is a conformance
check, not an independent generalisation test). Identifier/paraphrase pairs were written by an AI author without
seeing results; the answer set is the chunks containing the identifier.

## Options considered

1. Env default only — fixes defect 1, leaves defect 2. Not enough alone.
2. Bound the context boost / cap at 1 — keeps ~400 inferences per search and two scales in one `max`. Rejected.
3. Lexical floor (Ruflo-style `max(blend, sem)` with BM25 coverage) — needs per-corpus BM25 normalisation and a
   threshold; not measured here. Not chosen.
4. **Reciprocal rank fusion + summaries opt-in (chosen).** RRF needs no score normalisation; k=60, the variant merge,
   list depth and the tie policy below are still design choices.

## Design (r2)

- **D1 Summaries opt-in.** `summariesRequested = (RAG_MEMORY_SEARCH_SUMMARIES === 'on')`, exact and case-sensitive,
  read once at call entry, before the first await (a change during the call does not affect that call). Unset, empty, `off` and any other value = not requested. Fragment summaries run only when
  requested AND the vector path is healthy AND a primary query embedding exists; otherwise preview slices
  (`text.slice(0,300)` / `slice(0,150)`).
- **D2 Default ranking = RRF.** Applies when summaries are not requested and `useGraph` is false.
  - `vectorRank`: position in the unique vector candidate list taken **before** FTS-only candidates are appended;
    a chunk seen under several variants keeps its smallest distance; equal distances keep first-seen order; dense
    1-based ranks; only real vector candidates count (never inferred from a distance-2.0 placeholder or a
    `vector_similarity` of 0).
  - `ftsRank`: existing first-seen rank over variants in order, BM25 order within a variant; a repeat does not
    consume a rank and is not replaced by a better rank under another variant.
  - `score = (vectorRank ? 1/(60+vectorRank) : 0) + (ftsRank ? 1/(60+ftsRank) : 0)`. Final ties keep candidate order
    (sorted vector list, then FTS-only in first-seen order); scores are not rounded before sorting.
  - Fusion is per `chunk_id` for document, entity and relationship chunks alike.
  - FTS rows without `chunk_metadata` never get a rank (the SQL joins metadata). A chunk that disappears between
    the FTS query and hydration is dropped; remaining ranks are not compacted.
  - Determinism is relative to the ordered input lists; SQL has no secondary key for equal distance/BM25, so
    cross-platform order of exact ties at the depth cutoff is not claimed.
- **D3 Legacy formula on the opt-in paths.** `summariesRequested` or `useGraph: true` keep the 6.3.2 additive formula.
  Compatibility means equal scores and order **under the same summary mode, graph setting and candidates**.
  Because D1 changes the default, `useGraph: true` with the env unset now runs without summaries where 6.3.2 ran
  with them. Scores of the two formulas are never compared or mixed.

  | env | useGraph | formula | compare against |
  |---|---|---|---|
  | unset/off/other | false | RRF | intended change |
  | `on` | false | legacy + fragment summaries | 6.3.2 summaries on |
  | unset/off/other | true | legacy, preview only | **6.3.2 summaries off + graph** |
  | `on` | true | legacy + summaries + graph | 6.3.2 summaries on + graph |
- **D4 Return shape unchanged; meaning of one number changed.** Same keys and types. On the default call
  `relevance_score` is a rank score — at most `2/61`, no lower bound (single list rank r gives `1/(60+r)`; merged
  variant lists can exceed 30), comparable only within one call; not a similarity or probability.
  `vector_similarity` and `fts_boost` keep their meaning; `fts_boost` is still omitted when absent.
- **D5 Degraded paths.** If vector search is ineligible or **fails on any variant**, the call drops every vector
  candidate gathered so far and the primary query embedding (new: 6.3.2 kept earlier variants' candidates while
  the envelope said `fts-only`), runs no summary and no graph, and ranks by the FTS term alone. Envelope fields
  (`search_mode`, `degradation_reason`, `warning`, `coverage`, `model_state`) unchanged.
- **D6 Docs.** Tool description (RRF, identifiers welcome, no "graph traversal" wording, `relevance_score` meaning),
  `docs/UPDATING.md` (also fixes the old "off → relevance_score 0" wording), README changelog, CODE_CONTEXT.

## Contract and evidence

| | Contract | Evidence (2026-10-03) |
|---|---|---|
| C1 | cache cleared: real embedder calls = unique query variants, 0 fragment inputs, for unset / `off` / `ON` / `1` / empty; preview slices exact; env flipped to `on` during the query embedding does not start summaries for that call | `test/search-fusion-rrf.test.mjs` (the mid-call flip kills mutant m5 = env read moved back after vector gathering) |
| C2 | `on`: fragment embeddings happen; legacy score >= vector similarity | same file |
| C3 | target proven FTS-only (vector depth 9 < 13 closer chunks, `vector_similarity` 0) reaches rank 2 with score exactly 1/61; a both-lists competitor stays above; full expected scores (1/61+1/62, 1/74+1/61, 1/62..1/69) | same file |
| C3m | mutants must fail | 6.3.2 code 16 fails · no vector term 5 · no FTS term 9 · vector rank after FTS append 2 · D5 clear removed 2 (8 with the four-mode D5 matrix) · env read after vector gathering 1 · all clean assertion failures |
| D5t | later-variant failure in all four modes (summaries unset/on × useGraph false/true): `fts-only`, FTS hits only, no vector score, no graph boost, FTS order, no fragment embeddings | same file |
| C4 | legacy parity per D3 table | `test/graph-context-explain.test.mjs`: summaries **on** 9/9 cases byte-identical to the 6.3.x golden; summaries **off** 8/8 graph/degraded cases byte-identical to a golden recorded on 6.3.2 dd9493f with off (`fixtures/graph-context-golden-summaries-off.json`); default case c2 same order, scores 1/(60+r) |
| C5 | engine top-10 ids and scores == independent RRF recomputation (independent pool rebuild and FTS compiler; engine scorer not imported); the verdict recomputes every row and is tied to a unique run id, corpus, dist hash, completion flag and row count; node exit must be 0 or the known teardown 134 (reported separately) | **final dist `67249835…`: hub 93/93 · uap 54/54 · hal 56/56 exact, verdict PASS ×3** (node exit 134 at teardown each time, after a complete result). Verdict self-test 10/10 (stale run, missing file, exit 1, wrong dist, wrong corpus, short rows, tampered score, incomplete, good exit 0 / 134). Evidence: hub `r2/c5/final-dist/` |
| C6 | `npm test` exit 0, new test wired | exit 0 (re-run on the final tree before commit) |
| C7 | **default search median < 1 s on the frozen hub copy** (original r1 criterion, kept) — reported with cache condition, p95, max, search mode | **met, with a caveat.** Final dist `67249835…`, cold query (embedding cache cleared before every call), all 93 hub queries, mode `hybrid`: median 585 ms, p95 1,206 ms, max 1,480 ms (uap 54: 407 / 999 / 2,195 ms; hal 56: 219 / 320 / 364 ms). Caveat: measured while another tab ran a CPU-heavy model job, so these are upper bounds; an uncontended run was not taken. Query-cached medians 20 / 10 / 6 ms. Earlier runs under heavier contention (load average 20-90) gave 1.1-1.5 s medians and are not used |

## Known limits / follow-ups

- **searchNodes** has its own lexical-burial pattern (vector top-limit first; FTS merged only when coverage < 100
  and only while results < limit; date filter applied after the vector cut). Out of scope; recorded for a follow-up.
- Paraphrase recall stays low (hit@10 7/20). Separate work (framework hub).
- `relevance_score` scale change: no framework-fleet code thresholds on it (33 registry folders scanned; the two
  hits are unrelated app fields). External npm users may; changelog says so.
- Windows not run. Cold-query latency not cleanly measured yet.
