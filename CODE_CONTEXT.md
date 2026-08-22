# CODE_CONTEXT.md — rag-memory-epf-mcp

> Curated SSOT for coding conventions in this repo. Read before writing or modifying code.
> Not generated: every claim here was measured against the tree, not inferred. Update it when a
> pattern changes, and say what you measured.
>
> This repo has no markdown frontmatter and no commit trailers. Do not introduce either.
>
> **Before reading any code here, check which checkout you are in.** The main folder
> `~/Development/rag-memory-epf-mcp` is **not** always `main`: as of 2026-08-22 it holds
> `probe/ranking-ablation` (forked at v5.2.0, plus uncommitted PROBE-ONLY ablation edits that shift
> line numbers by ~14), while `main` lives in the worktree `.worktrees/fix-graph-default-off`.
> On 2026-08-22 that tree was read for a whole session as if it were the shipped engine; the
> `useGraph` default alone differs between the two, which is the exact thing being evaluated.
>
> **The check that catches this regardless of layout** — compare the tree against the engine that is
> actually running, before trusting anything you read:
>
> ```bash
> node -p "require('./package.json').version"   # the tree you are about to read
> git worktree list                             # every checkout and its branch
> # compare with server.version from the MCP getKnowledgeGraphStats() response
> ```
>
> Line numbers cited in this file are on **origin/main**.

---

## 1. Architecture

Single MCP stdio server. One SQLite file per project is the whole persistence layer — there is no
external service, no daemon, no second store.

```
index.ts                        4,695 lines. The engine class + the MCP server, one file.
  class RAGKnowledgeGraphManager   all engine behaviour (writers, readers, search, documents)
  server.setRequestHandler(ListToolsRequestSchema)   tool listing  (4455)
  server.setRequestHandler(CallToolRequestSchema)    one switch, one case per tool  (4462)

src/observations/               v13 observation lifecycle
  schema.ts       OBSERVATION_SCHEMA_SQL — the DDL string shared by migration and tests
  lifecycle.ts    addRevision · correctRevision · transitionStatus · linkSources · recordEvent
  projection.ts   rebuildProjection (active rows -> entities.observations) · deleteStaleKgChunks
  history.ts      getObservationHistory — the only surface that returns non-active revisions

src/migrations/
  migrations.ts         the migration list. Each entry = { version, description, up, down }
  migration-manager.ts  applies them in order and records schema_migrations

src/tools/              MCP tool *declarations* only (no behaviour)
  knowledge-graph-tools.ts · rag-tools.ts · graph-query-tools.ts
  graph-analytics-tools.ts · migration-tools.ts
  tool-registry.ts      allTools = spread of the five groups; convertToMCPTool; validateToolArgs
  types.ts              ToolDefinition · ToolCapabilityInfo · ToolRegistrationDescription

src/backup/preflight.ts   pre-migration backup (Online Backup API) into the next free recovery slot; verified (quick_check + FTS5 integrity-check), published no-clobber via link(), bounded, fails closed when full
src/embeddingGate.ts      embedding admission control
src/backfillCoordinator.ts  background embedding backfill
src/modelCache.ts         version-independent model cache (v3.6)
src/chunkerC.ts           document chunking — structure-anchored chunker "c1" (there is no src/chunkText.ts)

test/*.test.mjs           plain node scripts. No framework. They import ../dist/index.js.
```

### Tables (13)

`entities` · `relationships` · `documents` · `chunk_metadata` · `chunk_entities` ·
`entity_embedding_metadata` · `embedding_profiles` · `embedding_backfill_failures` ·
`server_meta` · and the v13 lifecycle four: `observation_roots` · `entity_observations` ·
`observation_sources` · `observation_events`.

Vectors live in sqlite-vec `vec0` virtual tables (`entity_embeddings`, chunk embeddings), fixed
at **1024 dimensions** (`index.ts` fails fast on a mismatch). FTS5 provides BM25.

### The retrieval path (measured 2026-08-22 against a live 2,874-chunk / 600-entity corpus)

**Graph edges are built by string matching only. No embedding is involved in link creation.**
`autoLinkEntities` (index.ts:2743, run after every embed/sync) fills `chunk_entities` by three
lexical paths:

1. `buildEntityMatcher(name)` — CJK substring / Latin word-boundary against `chunk.text`
2. **observation aliases** — every `[\w\-]+\.\w{1,4}` token of length >= 4 found anywhere in that
   entity's observations, matched as a lowercase substring of `chunk.text`
3. `buildEntityRangeFinder` — occurrences of the primary name in the *whole document*, linked to any
   chunk whose `[start_pos, end_pos)` overlaps (recovers names split across a chunk boundary)

`linkEntitiesToDocument` (the MCP tool) uses path 1 only.

Measured share of 65,935 links: **name present in the chunk 1,434 (2.2%)** · **alias-only 60,427
(91.6%)** · neither 3,563 (5.4%). Path 2 dominates because entity names in this corpus are
sentence-length records (median 41 chars) that never appear verbatim in prose. One alias carries
most of it: `agents.md` is held by 81 entities and occurs in 440 chunks (~54% of all links). The
alias regex also captures decimals as filenames (`0.619`, `1.2gb`) — real, but only 348 links (0.5%).

`provenanceOf` in the evaluation harness labels path-1 links `name` and everything else
`nonliteral`. That label means *"the name is not in the text"*, **not** *"linked by a non-lexical
method"* — there is no such method.

**Search does not use the graph to generate candidates.** `hybridSearch` (index.ts:3548) builds the
pool from vector search over `chunks` plus FTS5, fuses with RRF (k=60), then applies `graphBoost` as
a re-ranker over that pool. `useGraph` is opt-in, default **false** since v5.3.0; four places must
agree (method signature, dispatch `=== true`, tool JSON, zod default). Relationship traversal is
`openNodes` -> `getNeighbors`, never `useGraph`.

`graphBoost` scores each entity linked to the candidate chunk: query-vector-matched or exact term
match 0.3, substring 0.2, **any whitespace token of the entity name >= 3 chars occurring in the
query 0.15**, plus 0.15 when connected to a vector-matched entity; geometric decay `0.5^i`, hard cap
0.4. Given the alias-heavy link table above, a chunk can be boosted purely for mentioning a common
filename.

Final score is `max(vectorSimilarity, relevanceScore) + graphBoost + ftsBoost`. `relevanceScore`
comes from `generateContentSummary`, whose `enhanceSimilarityWithContext` adds query-independent
bonuses (+0.1 per entity mention, +0.05 for digits, +0.03 for "important"-class words), so it can
displace `vectorSimilarity` inside that `max`.

**graphology analytics read `relationships` only.** `_buildGraphologyGraph` (index.ts:4104) loads
entity nodes and `relationships` edges; `chunk_entities` is not in that graph. `getGraphMetrics`
(pagerank/degree/betweenness/closeness), `detectCommunities` (Louvain) and `analyzeGraphStructure`
therefore describe the ~900-edge authored graph, not the ~66k-link bipartite one.

**FTS5 keeps Korean particles attached.** `unicode61 remove_diacritics` (migration 8) splits on
whitespace, so `그래프가` and `그래프` are different tokens (measured: 6 vs 53 chunk hits; English
control `graph` 227). `compileFtsLiteralQuery` quotes each whitespace term verbatim and ORs them, so
a Korean query only matches chunks carrying the same inflected form.

### Adding a tool — all four edits are required

1. `src/tools/<group>-tools.ts` — capability + description + zod schema + `export const xTool`
2. the group's export map at the bottom of that file
3. `index.ts` `CallToolRequestSchema` switch — a `case "x":` that calls the manager method
4. `README.md` tool count and the group list

Skipping (3) makes the tool listable but uncallable. Skipping (2) makes it invisible. Both fail
silently, which is why `test/tool-contracts.test.mjs` cross-checks the registry against the
dispatch switch in both directions. It does **not** check nested argument schemas — a tool whose
schema omits a field the manager expects still passes, and `validateToolArgs` strips that field on
the way in. That gap cost a full-dump restore its entire revision history once.

---

## 2. Patterns

**Entity id derivation.** Always
`` `entity_${name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}` ``. The `u` flag and `\p{L}`
matter: Korean entity names are normal here. Do not write a new variant of this expression —
there are already several copies, and they must stay identical.

**An observation mutation owes four things in one transaction**: mutate, rebuild the projection,
invalidate the entity vector, drop stale KG chunks. `mutateEntityAndInvalidate(entityId, mutate)`
packages all four and skips the last three when `mutate()` returns `false` (meaning *nothing
changed*). `invalidateDerivedForEntity(entityId)` is the last two on their own, for callers already
inside a transaction.

> This is not optional bookkeeping. Doing fewer than four leaves search answering with facts that
> were already corrected, and nothing fails: invalidating without re-embedding drops the vector
> silently, and skipping invalidation keeps the old vector and old KG chunk searchable.
>
> `importGraph` is the one writer that does not call `mutateEntityAndInvalidate` — it batches its
> own transaction and calls `rebuildProjection` + `invalidateDerivedForEntity` per entity. It got
> there by first shipping *without* the invalidation, which produced exactly the stale-search
> defect above. If you add another writer outside the helper, you owe all four explicitly.

**Re-embedding happens after the transaction, never inside it**, and only when the helper reported
a change: `if (changed) await this.tryEmbedEntity(entityId, 'bulk')`.

**Dedup adds evidence, not revisions.** If the date-stripped content already exists as an `active`
revision, do not insert; link the incoming sources to the existing `observation_id` and push `null`
into the returned `observation_ids`. Build the lookup as `Map<bareContent, observation_id>` — do
not try to strip the `[YYYY-MM-DD]` prefix in SQL.

**Integrity is enforced by SQLite, not by code.** Triggers, partial UNIQUE indexes and
`CHECK (typeof(x) = ...)` carry the invariants. When you add a rule, add it to the DDL in
`schema.ts`, not to a TypeScript guard — a guard only covers the paths that call it.

**Trigger message order is a contract.** BEFORE-INSERT triggers fire top to bottom, and tests
assert on the message text. Reordering `SELECT RAISE(...)` statements changes which error a given
bad row produces.

**Tool declarations carry no logic.** `src/tools/*` is descriptions and zod schemas; behaviour is a
manager method. Keep it that way — `validateToolArgs` is the only bridge.

---

## 3. Conventions

- **ESM only.** `"module": "ESNext"`, `.js` extensions in relative imports (`'./src/x.js'`) even
  though the sources are `.ts`. `require()` throws `ERR_AMBIGUOUS_MODULE_SYNTAX`.
- **`strict: true`.** `this.db` is nullable; the established idiom is a guard
  (`if (!this.db) throw new Error('Database not initialized')`) at the top of a public method and
  `this.db!` inside nested closures.
- Naming: `camelCase` methods, `snake_case` SQL columns and table names, `SCREAMING_SNAKE` for
  exported SQL/DDL constants, `kebab-case.ts` filenames in `src/`, `kebab-case.test.mjs` in `test/`.
- Column names cross the API boundary as-is (`observation_id`, `revision_no`, `projection_order`).
  Do not camelCase them on the way out — export/import round-trips compare rows directly.
- Comments explain **why**, in the imperative, and cite the spec section or the review finding when
  one exists. Existing v13 comments are the reference for tone.
- Commit messages: `type(scope): summary`, then a body of prose paragraphs explaining the reasoning.
  Conventional-commit types, `!` for breaking. **No trailers.**

---

## 4. Constraints

- **`npm test` = `build → verify:invariants → verify:engine`.** Tests import `dist/`, so testing
  without building verifies the previous compile.
- **Never pipe the verification command.** `npm test | tail` and `| tee` both swallow the exit
  code in zsh (`PIPESTATUS` comes back empty). Redirect to a file and check `$?` separately.
- **Every new `test/*.test.mjs` must be appended to `verify:engine` in `package.json`.** Nothing
  discovers test files; an unwired test never runs again.
- **`PRAGMA foreign_keys` cannot be toggled inside a transaction** — it is a silent no-op there
  (measured: `before=1 · during=1 · after=1`). Anything relying on FK CASCADE must assume FK is on
  from boot.
- `INTEGER NOT NULL` is **not** type enforcement in SQLite (`'2x'` inserts fine) — pair it with
  `CHECK (typeof(col) = 'integer')`.
- `TEXT PRIMARY KEY` **permits NULL** in SQLite — write `NOT NULL` explicitly.
- Embedding dimension is **1024, fixed**. Changing the model means a migration, not a config edit.
- **Do not use `VACUUM INTO` to make a recovery point.** VACUUM may renumber the ROWIDs of tables
  without an explicit `INTEGER PRIMARY KEY`, and `entities` is one — `entities_fts` indexes it by
  ROWID, so a renumbered snapshot passes `quick_check` and fails FTS queries after a restore. Use
  `await db.backup(...)` (Online Backup API), which is documented to produce a bitwise-identical
  snapshot. The migration path is async; that was the only reason `VACUUM INTO` looked simpler.
- **`quick_check` does not validate an external-content FTS5 index.** Run
  `INSERT INTO <fts>(<fts>) VALUES('integrity-check')` when you need to know a snapshot is usable.
- **Publish a file no-clobber with `linkSync`, not `renameSync`.** rename overwrites silently.
- Node **>= 24** (`engines`). Published to npm as `rag-memory-epf-mcp`; **31 projects consume it**,
  so a schema or tool-contract change is a fleet event, not a local one.
- A migration must be all-or-nothing: one transaction, and gates (`PRAGMA foreign_key_check`, plus
  a byte-exact projection comparison) inside it before it commits.
- **A fail-closed guard that blocks the normal path is not a guard.** The backup preflight learned
  this by breaking re-initialisation on a fresh database.
- **Do not try to prove two SQLite files hold the same logical state.** Three versions of the backup
  gate tried and all three leaked: schema version is not identity, a UUID stored in the database is
  copied with the file, and a full row digest still misses `sqlite_sequence`, hidden rowids, 64-bit
  integer precision and the INTEGER/REAL storage class — while `VACUUM INTO` may itself renumber
  ROWIDs. If a decision seems to need that proof, change the decision: writing a new snapshot
  alongside the old one needs no comparison at all.

---

## 5. Tech Stack Quick Reference

TypeScript 5.6 (ES2022, ESM) · better-sqlite3 12 · sqlite-vec 0.1 · FTS5 ·
`@modelcontextprotocol/sdk` 1.27 · `@huggingface/transformers` (Xenova/bge-m3, 1024d) ·
graphology (+ communities-louvain, metrics, shortest-path) · tiktoken · zod 3 ·
tests = `node:assert/strict` in `.test.mjs`, no runner.

---

## 6. Common Tasks

| Task | Where |
|---|---|
| Add a migration | `src/migrations/migrations.ts` — new `{ version, description, up, down }`; DDL goes in a shared constant if a test needs it |
| Add an MCP tool | the four edits in §1 |
| Change observation behaviour | `src/observations/lifecycle.ts` + the calling writer in `index.ts`, inside `mutateEntityAndInvalidate` (or, if already in a transaction, `rebuildProjection` + `invalidateDerivedForEntity`) |
| Add a test | new `test/*.test.mjs` + wire into `verify:engine` |
| Verify | `npm test > <logfile> 2>&1; echo "EXIT:$?"` — never pipe, and set `RAG_MEMORY_REALDATA_DB` to a pre-v13 copy to include the real-data regression |

---

## 7. File References

- `src/observations/schema.ts` — the DDL, and the clearest statement of the v13 invariants
- `index.ts` `mutateEntityAndInvalidate` / `invalidateDerivedForEntity` — the four-part transaction contract, and the one exception (`importGraph`) that pays it manually
- `src/tools/knowledge-graph-tools.ts` `addObservationsTool` — the tool-declaration template
- `test/observation-schema.test.mjs` — how to test a trigger, including isolated-schema controls
- `docs/UPDATING.md` — version-update reliability runbook (v3.6)
- Design spec and plan for v13 live in the framework repo, not here:
  `RAGMemory-Claude-memory-management-and-optimised-workflow/docs/superpowers/{specs,plans}/2026-07-30-*`
