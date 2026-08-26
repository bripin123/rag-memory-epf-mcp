# rag-memory-epf-mcp

[![npm version](https://img.shields.io/npm/v/rag-memory-epf-mcp)](https://www.npmjs.com/package/rag-memory-epf-mcp)
[![npm downloads](https://img.shields.io/npm/dm/rag-memory-epf-mcp)](https://www.npmjs.com/package/rag-memory-epf-mcp)
[![GitHub license](https://img.shields.io/github/license/bripin123/rag-memory-epf-mcp)](https://github.com/bripin123/rag-memory-epf-mcp/blob/main/LICENSE)
[![Platforms](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](https://github.com/bripin123/rag-memory-epf-mcp)

A **project-local RAG memory** MCP server — knowledge graph + multilingual vector search + FTS5 full-text search, all in a single SQLite file per project.

## Key Features

- **Project-local isolation** — each project gets its own `.memory/rag-memory.db`. Multiple projects run simultaneously without interference.
- **Hybrid search** — vector similarity (bge-m3, 1024-dim) + FTS5 BM25 keyword matching (RRF-fused). Knowledge-graph re-ranking is an **opt-in legacy/experimental** signal since v5.3.0 (measured to hurt known-item retrieval)
- **100+ languages** — Korean, Chinese, Japanese, Arabic, and more. Cross-lingual search works out of the box.
- **Graph re-ranker (opt-in)** — per-entity geometric decay (0.5^i) with a hard cap 0.4; the cap bounds the boost but was measured (2026-08-17) to let heavily-linked chunks saturate it and outrank the exact chunk — hence off by default
- **38 MCP tools** — knowledge graph CRUD, observation lifecycle (correct / retract / history), document pipeline, hybrid search, multi-hop traversal, graph analytics (centrality / community detection / structure), export/import, temporal queries
- **Observations that hold their history** — corrections supersede instead of overwrite, search returns only current facts, and every revision keeps its provenance
- **Structure-anchored chunking (c1, v5)** — boundaries anchor to markdown structure (fence-aware, H1–H4 first, block-greedy, exact-token fallback), so editing the top of a file no longer re-embeds the whole document: unchanged text reuses its stored vectors at sync time. Chunk offsets are Unicode codepoints, language-neutral across SQL `substr`, Python slicing, and JS `[...str]` iteration; a publish-time invariant gate locks the gap-free partition. `overlap` is retired (omit or 0).
- **SQLite optimized** — WAL mode, 32MB cache, 256MB mmap, FTS5 triggers, 7 indexes
- **MCP SDK 1.27.1** — Tool Annotations (readOnly/destructive/idempotent), latest protocol 2025-11-25

## Quick Start

```json
{
  "mcpServers": {
    "rag-memory": {
      "command": "npx",
      "args": ["-y", "rag-memory-epf-mcp@latest"],
      "env": {
        "DB_FILE_PATH": "/path/to/your-project/.memory/rag-memory.db"
      }
    }
  }
}
```

Place this `.mcp.json` in each project folder with its own `DB_FILE_PATH`. Each project maintains completely isolated memory.

## Tools (38)

### Knowledge Graph (7)
| Tool | Description | Annotation |
|------|------------|------------|
| `createEntities` | Create entities with observations and types (upsert) | idempotent |
| `createRelations` | Establish relationships between entities | idempotent |
| `addObservations` | Add contextual information to entities (dedup) | idempotent |
| `updateRelations` | Update relationship confidence and metadata | idempotent |
| `deleteEntities` | Remove entities and relationships | destructive |
| `deleteRelations` | Remove specific relationships | destructive |
| `deleteObservations` | **Deprecated** soft-retract shim — see Observation Lifecycle | destructive |

### Observation Lifecycle (7)
| Tool | Description | Annotation |
|------|------------|------------|
| `correctObservation` | Supersede a revision with corrected text, keeping the old one | |
| `retractObservation` | `active` → `retracted` (hidden from search, kept in history) | |
| `restoreObservation` | `retracted` → `active` | |
| `approveObservation` | `provisional` → `active` | |
| `declineObservation` | `provisional` → `retracted` (reason required) | |
| `purgeObservation` | Physically delete a revision and its successors (`confirm='PURGE'`) | destructive |
| `getObservationHistory` | Every revision, status, provenance and event | read-only |

### Document Pipeline (9)
| Tool | Description | Annotation |
|------|------------|------------|
| `storeDocument` | Store documents with metadata. Replacing an existing document reports what it destroyed: `{ replaced, deletedChunks }` | idempotent |
| `chunkDocument` | Create text chunks with configurable parameters | — |
| `embedChunks` | Generate 1024-dim embeddings + auto-link entities | idempotent |
| `embedAllEntities` | Batch embed all entities (32 parallel) | idempotent |
| `extractTerms` | Extract potential entity terms | — |
| `linkEntitiesToDocument` | Link entities to chunks where they actually appear (text-matched) | idempotent |
| `deleteDocuments` | Remove documents and associated data | destructive |
| `listDocuments` | View all stored documents | readOnly |
| `syncDocumentFromFile` | One-call server-side sync: reads file + delete/store/chunk/embed/link, content stays off model context. Atomic (embed-first transaction swap) + `content_hash` dedup (skips unchanged files). `excludePattern` strips regions before indexing, and the hash follows the stripped text so changing the pattern re-indexes | idempotent |

### Search & Retrieval (9)
| Tool | Description | Annotation |
|------|------------|------------|
| `hybridSearch` | Vector + FTS5 BM25, plus an **opt-in** graph re-ranker (`useGraph: true`; default off since v5.3.0). Degrades to FTS5-only (`search_mode`) when the embedding model is down | readOnly |
| `searchNodes` | Semantic entity search with `since`/`until` temporal filtering | readOnly |
| `openNodes` | Retrieve specific entities by name | readOnly |
| `readGraph` | Get complete knowledge graph | readOnly |
| `getNeighbors` | Multi-hop graph traversal (depth 1-5, cycle detection) | readOnly |
| `getDetailedContext` | Get full context for a chunk | readOnly |
| `exportGraph` | Export full graph as JSON (backup) | readOnly |
| `importGraph` | Import graph from JSON (merge or replace) | destructive |
| `getKnowledgeGraphStats` | Knowledge base statistics | readOnly |

### Migration (3)
| Tool | Description | Annotation |
|------|------------|------------|
| `getMigrationStatus` | Check database schema version | readOnly |
| `runMigrations` | Apply pending migrations | idempotent |
| `rollbackMigration` | Revert to a previous schema version | destructive |

### Graph Analytics (3)
| Tool | Description | Annotation |
|------|------------|------------|
| `getGraphMetrics` | Per-entity centrality (degree, betweenness, closeness, pagerank) | readOnly |
| `detectCommunities` | Louvain community detection + modularity score | readOnly |
| `analyzeGraphStructure` | Density, connected components, clustering coefficient | readOnly |

## Document Processing Pipeline

```
storeDocument(id, content, metadata)
  → chunkDocument(documentId, maxTokens)   # overlap retired in v5 (omit or 0)
    → embedChunks(documentId)
       ├── generates vector embeddings for each chunk
       ├── auto-links entities to chunks (word boundary + CJK aware)
       └── returns { embeddedChunks, linkedEntities }
```

## Architecture

```
┌─────────────────────────────────────────────┐
│  MCP Client (Claude Code, Gemini CLI, etc)  │
└──────────────────┬──────────────────────────┘
                   │ stdio (MCP SDK 1.27.1)
┌──────────────────▼──────────────────────────┐
│  rag-memory-epf-mcp                         │
│  ┌────────────┐ ┌─────────────┐ ┌────────┐  │
│  │ Knowledge  │ │ RAG Document│ │ Search │  │
│  │ Graph CRUD │ │ Pipeline    │ │ Engine │  │
│  └─────┬──────┘ └──────┬──────┘ └───┬────┘  │
│        │               │            │        │
│  ┌─────▼───────────────▼────────────▼─────┐  │
│  │  SQLite (WAL mode, per-project file)   │  │
│  │  ├── entities + relationships          │  │
│  │  ├── documents + chunk_metadata        │  │
│  │  ├── chunks (sqlite-vec, 1024-dim)     │  │
│  │  ├── entity_embeddings (sqlite-vec)    │  │
│  │  ├── entities_fts + chunks_fts (FTS5)  │  │
│  │  ├── observation lifecycle (4 tables)  │  │
│  │  └── 13 migrations (auto-applied)      │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  bge-m3 (ONNX, 100+ langs)                   │
└──────────────────────────────────────────────┘
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_FILE_PATH` | `rag-memory.db` (server dir) | Path to project-local SQLite database |
| `EMBEDDING_MODEL` | `Xenova/bge-m3` | HuggingFace model ID for embeddings |
| `RAG_MEMORY_EMBEDDINGS` | `lazy` | Boot mode: `lazy` (connect instantly, model loads in background), `eager` (wait for model + reconciliation, pre-3.6 behavior), `off` (never load the model — FTS5-only, zero download) |
| `RAG_MEMORY_MODEL_CACHE_DIR` | OS user cache | Version-independent model cache location (see `docs/UPDATING.md`) |
| `RAG_MEMORY_TRUST_LEGACY_VECTORS` | unset | Set `1` to grandfather pre-existing vectors under a **custom** `EMBEDDING_MODEL` (default model configs grandfather automatically) |

## Changelog

### v6.1.0

**Versioning note.** This content was tagged `v6.0.2` locally before release, but npm never received
a 6.0.2 — it published as **6.1.0**. Coming from any 6.0.x, upgrading to 6.1.0 brings exactly this
fix.

- **Fixed — a failure mid-deletion could leave partial state.** Deleting an entity ran its cleanup
  steps (embeddings → chunk associations → relationships → the entity row) with no wrapping
  transaction, so a failure in the middle committed the earlier steps: embeddings and links purged
  while the entity itself survived. Each entity's deletion is now one transaction — any step fails,
  that entity's whole sequence rolls back. Batch semantics are unchanged: other entities still
  proceed when one fails.
- **Fixed — deleting an entity left its knowledge-graph chunks behind.** Two gaps compounded: the
  delete path never invoked the entity-chunk sweeper, and KG relationship chunks are keyed by
  `relationship_id`, so once the relationship rows were deleted their ids could no longer be found
  and those chunks dangled forever — still vector-searchable after both of their endpoints were
  gone. Deletion now captures relationship ids *before* removing the rows and sweeps both: stale
  entity chunks via the existing `deleteStaleKgChunks`, captured relationship chunks via the new
  `deleteKgRelationshipChunks` projection helper. Practical exposure today is bounded — the chunk
  generation path is dormant (not tool-exposed) — but once seeded these chunks stay retrievable
  unless swept here.
- Regression: `test/delete-entities-kg-hygiene.test.mjs` (registered in `verify:engine`) covers both,
  verified RED before the fix; a mutation check confirms that removing the transaction reproduces the
  partial state (`entities_alive=1` with `relationships_left=0`). Full suite green (`npm test`,
  46-call chain).

### v6.0.1

**Versioning note.** Both changes below stop links from being created that should never have been
created, and restore links that should have been. No tool signature, return shape or schema
changes, so this is a patch: **derived-link density is not part of the compatibility contract**.
Read the entries as "linking got more precise", not as an API break.

- **An observation alias must now also appear in the entity's own name.** 6.0.0 capped how many
  entities may share a token. That answers "does this token point at one entity?" and says nothing
  about the other direction, so an entity that mentions a common filename *once* still attached to
  every chunk containing it — and, being the sole owner, sailed through the cap. The cap stopped
  the explosion, not the magnet. Measured after the 6.0.0 cleanup on a live corpus: 2,014
  alias-only links remained and **34 entities held 68.1%** of them; the largest had the entity name
  in **zero** of its chunks. Requiring the token (or its stem) to appear in the name brings that to
  6 entities / 42.1%, and what remains are entities that really are about that file. Expect far
  fewer alias links on new ingests; existing rows are not rewritten.
- **A chunk-frequency cap was measured and rejected on the evidence, not on cost.** The full-corpus
  scan is 585ms (731 tokens x 2,913 chunks). It was rejected because the sweep has no knee and every
  cut also removed legitimate links — `log_coverage.py` occurs in 64 chunks and belongs to an entity
  about exactly that file. The name condition is structural: no threshold, same meaning at any
  corpus size.
- **Fixed — entity names whose own edge is punctuation never linked.** The Latin matcher used
  `\b<name>\b`. `\b` asserts a transition between a word character and a non-word character, so when
  the name itself starts or ends with punctuation — `Widget Review (2026-05-27)`, `--build-flag` —
  there is no transition to assert and the pattern cannot match however the text reads. Measured on
  a live 2,913-chunk / 312-name corpus: **23 standalone occurrences across 13 names** were invisible.
  Both the chunk matcher and the document range finder now accept an occurrence whose neighbours on
  both sides are non-word. **Not a widening**: both sides must still be non-word, so `Data` continues
  not to match inside `Database`. The scan runs on the original text rather than a lowercased copy,
  because folding can change length (`İ` becomes two units) and the range finder converts these
  indices to codepoints.
- Regressions: `test/alias-link-gate.test.mjs` (magnet case) and `test/entity-name-boundary.test.mjs`,
  both registered in `verify:engine` and both verified to fail without their fix.

### v6.0.0

- **Breaking — observation-derived alias links are now gated.** `autoLinkEntities` used to take every
  `stem.ext` token appearing anywhere in an entity's observations and link that entity to every chunk
  containing the token as a substring. Measured on a live 2,891-chunk / 604-entity corpus: 65,388 of
  66,841 `chunk_entities` rows (97.8%) existed only because of such a hit, and one token — `agents.md`,
  held by 88 entities — accounted for 39,248 of the 80,096 distinct (chunk, entity) pairs any alias
  could reach (49.0%). The regex also accepted things that are not filenames at all (`v3.3`,
  `gpt-5.6`, `1.7mb`, `github.com`, `os.path`).
  A token now has to (a) look like a filename — extension whitelist, stem ≥ 3 chars, non-numeric
  stem — and (b) be held by at most 3 entities, and it must match on token boundaries so `foo.py` no
  longer matches inside `notfoo.pyc`. Effect on the same corpus: alias links 100% → 4.0%. Filtering by
  extension alone leaves 92.3%, so the owner cap is what does the work. The cap is a judgement, not a
  discovered boundary — the sweep is smooth (`owners<=1` 1.6% … `<=10` 19.9%) — and it is a cap, not a
  ban: a filename named by one to three records still links, which is what the alias path was for.
- **What this means for existing databases.** Nothing is rewritten on upgrade: rows already in
  `chunk_entities` stay, and new ingests simply link far less. Links have always been a function of
  when a document was last processed (nothing re-links older documents when entities are added), and
  `chunk_entities` has no provenance column, so old alias rows cannot be told apart from name matches
  after the fact. If you want the old noise gone you have to clean it offline, before or after
  upgrading. Callers that assumed dense `chunk_entities` coverage will see sparser graphs.
- Regression: `test/alias-link-gate.test.mjs` (registered in `verify:engine`), verified to fail
  without the gate.

### v5.3.0
- (Published first as `5.3.0-rc.1` on the `next` dist-tag; promoted to `latest` after a canary run of the published artifact against a real project database: default call carries no `graph_boost` and equals explicit `useGraph:false`, the known-item probe from the 2026-08-17 measurement returns the correct gotcha at rank 1, opt-in `true` still exposes `graph_boost`, schema/MCP defaults read `false`.)
- **Behavior change — `hybridSearch` graph re-ranking is now opt-in** (`useGraph` default `true` → `false`; tool schema, MCP exposure and the manager signature agree). Omitting the argument now means "no graph re-ranking" — a behavior change for callers that relied on the old default, hence a release-candidate first (`next` dist-tag, fleet canary) before stable. Measured 2026-08-17 on three real corpora (self-retrieval, usable samples 120/117/120, summaries off): with the additive graph boost on, the known-item chunk got worse in 46/49/52 samples and better in 3/2/0 (sign test p < 7e-11 per corpus), 106 targets left the top-10 entirely; reproduced on the summaries-on product path (HAL, 20 paired samples: hit@1 10→7, hit@5 18→13). Mechanism: only query-matched/connected entities score, but the per-entity boost saturates the cap quickly, so heavily-linked chunks can outrank the exact chunk even at `vector_similarity` 0. This is a harm-reduced default, not a validated graph improvement: the boost path is unchanged for `useGraph: true` (legacy/experimental re-ranker for back-compat and evaluation; the graph does not generate candidates — for relationship exploration use `openNodes` → `getNeighbors`). Regression lock: `test/search-graph-default.test.mjs`.
- (v5.0.0–v5.2.0 notes live in the git tags / `docs/UPDATING.md`.)

### v4.0.0

**Observation lifecycle (schema v13).** Observations used to be a JSON array of strings on the
entity row. A correction overwrote a string, so the fact that it *was* a correction disappeared —
and if you deleted the wrong duplicate, nothing recorded that either. Observations now have stable
ids, provenance, and a status, and `entities.observations` becomes a projection synthesised from
the `active` revisions.

- **Corrections keep the previous revision.** `correctObservation(observation_id, content, change_kind, reason)`
  marks the old revision `superseded` and inserts a new one that inherits its position in the array,
  so a correction does not reorder anything.
- **Search returns `active` revisions only.** A retracted or superseded fact stops coming back from
  `openNodes` / `searchNodes` / `readGraph` / `getNeighbors` without being destroyed.
- **`getObservationHistory({entity_name | observation_id | root_id})` is the only history surface.**
  It always returns `{ roots: [...] }`, one root per logical observation, revisions oldest-first.
- **State transitions are a table, not a guess**: `retract` / `restore` / `approve` / `decline`.
  `superseded` is terminal. Anything outside the table is rejected.
- **Provenance**: `addObservations` and `createEntities` accept `sources: [{source_kind, source_ref, source_hash?}]`.
  Repeated content from a *new* source adds evidence to the existing revision instead of a duplicate.
  Unknown provenance is zero source rows — the engine does not invent one.
- **`observation_ids`**: `addObservations` and `createEntities` return ids aligned 1:1 with the input,
  `null` where no revision was created (dedup or source-only).
- **`purgeObservation(observation_id, 'PURGE')`** physically deletes, as a suffix purge from the
  target to the newest revision of that root. It is separate, explicit, and almost never what you want.
- **⚠️ BREAKING**: `deleteObservations` is deprecated. It now performs a soft **retract** instead of
  a delete, and a batch where any item matches two or more active revisions **aborts with zero
  mutations** — v3.6 deleted every duplicate and carried on, but a machine cannot tell which
  revision was meant. Use `retractObservation(observation_id)` to say which one.
- Migration to v13 writes a recovery point first (`<db>.v12.bak`) using the SQLite Online Backup API,
  and verifies it — `quick_check` plus FTS5's own `integrity-check`, because a snapshot can be
  structurally valid and still have a broken full-text index. **An existing one is never
  overwritten**: the next attempt writes `.bak.1`, then `.bak.2`. Every file in that rotation was
  taken before any schema change, so each is a valid pre-migration snapshot on its own and nothing
  has to prove which matches the live database. Slots are bounded and a full set refuses to migrate.
  Conversion runs in one transaction with two gates: `PRAGMA foreign_key_check`, then a byte-exact
  comparison of the rebuilt projection against the original array. `foreign_keys` is checked at boot
  and the server refuses to migrate without it. Restore and slot-exhaustion runbook:
  `docs/UPDATING.md`.

### v3.6.0
- **Lite install / lazy boot**: the MCP server connects immediately — FTS5 search, knowledge graph and CRUD work from the first second, while the bge-m3 model (~1.2GB) loads or downloads in the background. Hybrid search switches on automatically. Requires Node **>= 24**.
- **Version-independent model cache** with a cross-process download lock: engine version bumps no longer re-download the model, and concurrent servers on one machine never corrupt a download. Cleaning the npx cache no longer deletes the model.
- **Embedding provenance + automatic backfill**: every vector records its input hash and model profile; anything missing or stale (including rows written while the model was unavailable) is re-embedded automatically with a per-target retry cap. Fixes a long-standing defect where `deleteObservations` left stale entity vectors behind.
- **Search state transparency**: responses report `search_mode` (`hybrid` / `hybrid-partial` / `fts-only`), model state, provenance coverage and a `degradation_reason`; `searchNodes` gains a lexical FTS fallback so entities never disappear from search while embeddings catch up. `getKnowledgeGraphStats` gains a `server` block (version, node, states, coverage) for update-reliability checks.
- **⚠️ BREAKING**: (1) `hybridSearch` now returns an envelope `{results, search_mode, model_state, coverage, degradation_reason?}` instead of a bare array (per-item `search_mode` removed). (2) `deleteObservations` returns `{results: [{entityName, deleted, embedding_status}], total_deleted}` instead of a success string. Error responses now set `isError: true`. Migration/rollback and fleet-rollout guidance: `docs/UPDATING.md`.

### v3.5.0
- **Atomic `syncDocumentFromFile`**: embeddings are computed before any DB write, then applied in a single synchronous transaction, so a failed embedding (e.g. model still loading) leaves the existing document fully intact instead of a half-deleted or partially-embedded state.
- **`content_hash` dedup**: unchanged files short-circuit the delete/chunk/embed pipeline (`skipped: true`), with a completeness gate that still re-processes a partially-embedded document.
- **FTS5-only graceful degradation**: when the embedding model is unavailable, `hybridSearch` returns BM25 (full-text) results tagged `search_mode: 'fts-only'` instead of failing the whole query.

### v3.4.0
- **`syncDocumentFromFile`: one-call server-side document sync** - reads a file on the server and runs the full pipeline (`deleteDocuments` → `storeDocument` → `chunkDocument` → `embedChunks` → `linkEntitiesToDocument`) in a single call, returning only a terse summary `{ documentId, bytes, chunks, embeddedChunks, linkedEntities, warning? }`. File content is read server-side and never routed through the model context, collapsing the usual 5 tool calls per document into one and keeping conversation context flat (the dominant cost of large sync runs). 30 → 31 tools.

### v3.3.6
- **Publish-time invariant test** — `npm run verify:invariants` (wired as `prepublishOnly`) catches `chunkText` offset regressions before they ship. Tests ASCII / Korean / emoji-heavy / mixed CJK + supplementary plane / pure supplementary inputs against the codepoint-slice contract.
- **`chunkText` extracted to `src/chunkText.ts`** — algorithm now testable in isolation. The class method is a thin wrapper. No user-facing API change.
- **README accuracy** — tool count corrected to 30, migration count to 11, Graph Analytics tools surfaced.

### v3.3.5
- **Fix: chunk offsets stored as JS UTF-16 units instead of Unicode codepoints** — Korean/CJK/emoji documents had `start_pos`/`end_pos` that disagreed with SQL `substr` and Python slicing for any chunk crossing a supplementary character. `chunkText` now maintains parallel UTF-16 + codepoint cursors and reports codepoint offsets.
- **Migration v11** — converts existing `chunk_metadata.start_pos`/`end_pos` from UTF-16 units to codepoints by re-locating each chunk via `indexOf` and counting codepoints.

### v3.3.4
- **Migration version 9 → 10 jump + `ALTER TABLE` idempotency guards** — some databases from early v3.x experiments (Ollama dimension swap) had recorded a migration at version 9, causing the new v9 migration to silently no-op. Bumped to version 10 and added `PRAGMA table_info` guards so the column-add is safe to re-run.

### v3.3.3
- **Separate token-space and char-space offsets in `chunk_metadata`** — added `start_token`/`end_token` columns. Existing `start_pos`/`end_pos` are reinterpreted as character offsets into `documents.content`. Backfill migration recomputes char offsets via `indexOf` with a per-document cursor; misses leave NULL so callers can re-chunk to repair.

### v3.3.0
- **Graph analytics (graphology)** — three new MCP tools: `getGraphMetrics` (degree / betweenness / closeness / pagerank), `detectCommunities` (Louvain + modularity), `analyzeGraphStructure` (density / components / clustering). 27 → 30 tools.

### v3.2.1
- **Fix: `autoLinkEntities` silent failure** — was JOINing a non-existent `observations` table (observations are stored as JSON array column in `entities`). Changed to direct column select + `JSON.parse()`.

### v3.2.0
- **Chunk-level entity linking in `linkEntitiesToDocument`** — entities are now linked only to chunks where they actually appear (using `buildEntityMatcher` word-boundary/CJK matching), instead of blanket-linking to all chunks. Fixes search result domination by heavily-linked documents.
- **Graph boost decay + hard cap** — per-entity scores are sorted descending and decayed geometrically (0.5^i): 1st entity 100%, 2nd 50%, 3rd 25%, etc. Hard cap at 0.4 prevents graph signal from overwhelming vector similarity.

### v3.0.0
- **Back to self-contained embeddings** — reverted from Ollama dependency (v2.x) to built-in `@huggingface/transformers` with bge-m3 (1024-dim). No external services required.
- **Cross-lingual search** — auto-detects non-English queries and performs dual-language search
- **External dictionary** — optional `.memory/dictionary.json` for custom translation pairs
- **Modular tool system** — tools extracted into `src/tools/` with structured registry
- **Migration system** — extracted into `src/migrations/` with versioned schema upgrades
- **Dynamic version reporting** — MCP server version now reads from package.json
- **MIT LICENSE file** — included in published package

### v1.9.0
- **Multi-hop graph traversal** — `getNeighbors` tool with `WITH RECURSIVE` CTE, depth 1-5, cycle detection, bidirectional
- **Embedding LRU cache** — 500-entry in-memory cache, skips redundant re-computation
- **Configurable model** — `EMBEDDING_MODEL` env var to use alternative embedding models
- 27 tools total at this version (30 as of v3.3.0+)

### v1.8.0
- **MCP SDK 1.27.1** — protocol 2025-11-25, security fix GHSA-345p-7cg4-v4c7 (CVSS 7.1)
- **Tool Annotations** — all tools annotated (readOnlyHint, destructiveHint, idempotentHint)
- **SIGTERM graceful shutdown** — clean exit without ONNX mutex crash

### v1.7.0
- **SQLite optimization** — WAL mode, 32MB cache, 256MB mmap, busy_timeout
- **FTS5 full-text search** — BM25 keyword matching + Reciprocal Rank Fusion with vector search
- **updateRelations** — update confidence scores and metadata without delete+recreate
- **exportGraph / importGraph** — JSON backup and restore (merge or replace)
- **Batch embedding** — `embedAllEntities` processes 32 entities in parallel
- **Temporal filtering** — `searchNodes` with `since`/`until` ISO 8601 date filters
- **better-sqlite3 12.x** — SQLite 3.51.3 with query planner improvements
- **sqlite-vec 0.1.7** — DELETE space reclaim, KNN distance constraints
- **DB indexes** — entityType, relationType, chunk lookups
- **SQL safety** — `safeRowid()` validation for vec0 operations

### v1.6.0
- **Entity upsert** — merges new observations into existing entities instead of ignoring duplicates
- **Observation timestamps** — auto `[YYYY-MM-DD]` prefix for staleness tracking
- **Dedup by content** — date-stripped comparison prevents duplicate observations

### v1.5.0
- **Chunk-level entity linking** — precision linking to specific chunks, not all chunks
- **Word boundary + CJK matching** — Latin word boundaries, CJK substring matching
- **Observation-derived aliases** — file paths from observations matched against chunks

### v1.4.x
- Switched to **bge-m3** (1024-dim, 100+ languages)
- fp16 quantization, instruction prefix optimization

## Development

```bash
git clone https://github.com/bripin123/rag-memory-epf-mcp.git
cd rag-memory-epf-mcp
npm install
npm run build
npm test                  # build + invariant verification
npm run verify:invariants # standalone invariant test (assumes dist/ built)
```

`npm publish` automatically runs `prepublishOnly` (`build` + `verify:invariants`); a chunk-offset regression blocks the publish at the source.

## License

MIT License. See [LICENSE](LICENSE).

### Third-Party Model Licenses

| Component | License | Details |
|-----------|---------|---------|
| **bge-m3** | MIT | [Model card](https://huggingface.co/BAAI/bge-m3) |
| **@huggingface/transformers** | Apache 2.0 | JS inference runtime |

Model weights are downloaded at runtime and not bundled in this package.

---

**Built with**: TypeScript, SQLite (WAL + FTS5 + sqlite-vec), bge-m3, MCP SDK 1.27.1
