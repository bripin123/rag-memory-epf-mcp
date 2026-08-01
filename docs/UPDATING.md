# Updating rag-memory-epf-mcp

Runbook for version-update reliability (introduced in v3.6).

## Which version is actually running?

`@latest` in your MCP config does **not** guarantee the newest version. Three
independent reasons:

1. **Process lifetime** — MCP servers are spawned when the CLI starts. A new
   version is only picked up after you restart the CLI (or reconnect via
   `/mcp`). Editing config mid-session has no effect on the running server.
2. **npx cache fallback** — if the npm registry is unreachable, npx runs the
   cached copy.
3. **dist-tag re-resolution caching** — npx may reuse a previously resolved
   `@latest` for a while (known npm CLI behavior family).

**Check what is actually running** (v3.6+):

- Startup banner on stderr: `rag-memory-epf-mcp vX.Y.Z | node vN | model ... | cache ... | db ...`
- `getKnowledgeGraphStats` → `server.version`, plus `server.model_state`,
  `server.reconciliation_state`, and provenance `coverage`.

**Deterministic updates**: `npm i -g rag-memory-epf-mcp` and point the config
launcher at the `rag-memory-mcp` bin directly (the framework bootstrap
preserves this customization).

## Runtime requirements

- Node **>= 24** (`engines` + a runtime check at boot). Limitation: on very old
  Node the native imports (better-sqlite3 etc.) may fail before our version
  check prints its message.
- Embedding dims are fixed at 1024 (bge-m3). Other dims fail fast by design.

## The model cache moved in v3.6 (and why that matters)

- **Pre-3.6**: the bge-m3 model (~1.2GB) was cached *inside the package
  directory*, which lives inside the npx version slot → **every engine version
  bump re-downloaded the model**.
- **v3.6+**: the model lives in a version-independent user cache:
  `RAG_MEMORY_MODEL_CACHE_DIR` → `$XDG_CACHE_HOME/rag-memory-epf-mcp` →
  macOS `~/Library/Caches/rag-memory-epf-mcp` / Linux `~/.cache/…` /
  Windows `%LOCALAPPDATA%\rag-memory-epf-mcp`.
- First v3.6 boot downloads once into the new location (in the background —
  the server is usable immediately in FTS mode). Old package-internal caches
  are not migrated; they disappear with their npx slots.
- **Cleaning `~/.npm/_npx` no longer touches the model cache.** Do not delete
  the cache directory above unless you intend to re-download.

## Boot modes (v3.6)

`RAG_MEMORY_EMBEDDINGS` = `lazy` (default) | `eager` | `off`

- `lazy` — MCP connects instantly; FTS5 search, graph and CRUD work from the
  first second. The model loads/downloads in the background; hybrid search
  turns on automatically (search responses carry `search_mode` /
  `degradation_reason` so you can see why vector search is off).
- `eager` — pre-3.6 behavior: boot waits for the model (and provenance
  reconciliation) before connecting.
- `off` — never loads the model. Zero download, FTS5-only, permanently.
  Responses report `embedding_status: "disabled"` (not `"queued"` — nothing
  will backfill in this mode).

`RAG_MEMORY_TRUST_LEGACY_VECTORS=1` — only relevant if you run a custom
`EMBEDDING_MODEL`: v3.6 refuses to grandfather pre-existing vectors under a
custom model config unless you opt in (they are re-embedded instead).

If you EVER ran a custom `EMBEDDING_MODEL` against a DB and later switched
back to the default, the stored vectors cannot be attributed reliably. Run
`embedAllEntities` and re-sync your documents to rebuild them.

## Rollback caveats

- v3.6 applies schema migration 12 (provenance columns/tables) to each project
  DB on first boot. Older engine versions ignore the new columns — but they
  also do not maintain them.
- **Never run a pre-3.6 and a v3.6 server against the same project DB at the
  same time.** Restart per project, one at a time.

## Fleet rollout

- Roll out machine-by-machine, restarting CLIs sequentially (the shared model
  cache uses a cross-process download lock; sequential restarts avoid lock
  contention entirely).
- Concurrent servers: measured 2026-07-18 on the reference machine — 7 idle
  MCP server processes coexist (idle servers swap out to a few MB RSS). Each
  server that actually loads the model needs bge-m3 fp16 resident memory
  (~1.5–2GB while active). Keep concurrently *model-active* servers to a
  handful; sessions that don't need semantic search should run
  `RAG_MEMORY_EMBEDDINGS=off`. Note that **lazy mode still starts the model
  load in the background right after connect** (so hybrid search becomes
  available without any tool call) — `off` is the only zero-load mode. When
  restarting many CLIs at once, the shared cache download happens once (lock),
  but each process that finishes loading holds its own model memory.

## Shutdown semantics

SIGTERM/SIGINT close the MCP transport, settle in-flight work (bounded, 5s),
close the database cleanly, and exit naturally. One documented exception: if a
model download/load is still pending after the settle deadline (the fetch
cannot be aborted through transformers.js), the process performs a bounded
exit **after** the database is closed — data is never at risk, but if the load
happened to be inside native session construction you may see an abrupt
runtime message on termination.

**Stuck download lock recovery**: if a waiter times out it reports the lock
path and holder pid (e.g. `.download-<key>.lock`). Verify the holder process
is genuinely gone or hung (`ps -p <pid>`), then remove the lock file manually;
the next start becomes a clean download owner.

## v5.0.0 (schema v14): chunker c1 + vector reuse

**Breaking**: `chunkParams.overlap` is rejected on BOTH public paths
(`syncDocumentFromFile.chunkParams` and `chunkDocument`) unless omitted or
exactly 0 — chunker c1 has no overlap. `maxTokens` must be a positive integer.
Validation runs before the dedup gate, so invalid params fail even on
unchanged content.

**What changes on upgrade**: nothing, immediately. v14 is schema-only —
`documents.chunking_signature` is added with DEFAULT `legacy-unknown` and no
data row changes, so there is no coverage cliff and no re-embedding storm.
A document transitions to c1 only when its CONTENT changes at sync time
(signature mismatch alone is an observed state, not a trigger). The first
sync of an edited document pays a cold transition (old BPE chunk texts rarely
match c1 boundaries); every later sync reuses vectors for unchanged text.

**Observability**: `getKnowledgeGraphStats().chunking = { current, legacy,
unknown, default_signature }` — mutually exclusive, sums to `documents`. The
framework's /start Step 5a reads this response.

**Rollback caveat (v14)**: `rollbackMigration` drops the column and returns
`semanticRollback: false` plus a warning — chunk boundaries produced by c1
are NOT restored (they read fine on v13 code). Data restore path = the
pre-migration backup snapshot.

**Manual links**: full replacement re-derives `chunk_entities`; a link made
via `linkEntitiesToDocument` that is not reproducible from body literals or
`entityNames` is not preserved (true before v5 too). New in v5: primary
entity names are also linked by document-level occurrence ranges, so a name
cut across a chunk boundary still links to the intersecting chunks
(overlap used to absorb this; c1 has none).

**Fleet prerequisite before releasing/upgrading**: audit every deployment's
`schema_migrations` for occupied slots `>= 14` — pending migrations are
selected by MAX(version) arithmetic, so an experimental slot silently skips
the real v14 (this is exactly how code-v8 never ran in production).

## v3.6 breaking response changes

1. `hybridSearch` returns an envelope: `{results, search_mode, model_state,
   coverage, degradation_reason?}` (per-item `search_mode` removed).
2. `deleteObservations` returns `{results: [{entityName, deleted,
   embedding_status}], total_deleted}` instead of a success string.

All other tools are additive (`embedding_status`, `endpoint_embedding_status`,
stats `server` block). Error responses now set `isError: true`; embedding-gate
errors are structured: `{code: "MODEL_NOT_READY" | "EMBEDDINGS_DISABLED",
state, retry_after_ms?, message}`.

## v4.0: migrating to schema v13 (observation lifecycle)

### One process per database while migrating

The migration runs during `initialize()`, before `server.connect()`, so within a
single server there is no writer to race. **Two servers opened on the same database
file at once are not supported**, and the migration window is where that matters:
a commit landing between the backup and the migration is included in the migration
but not in the recovery point, so restoring would lose it. This is not enforced by
a lock — the deployment model is one server per project (`DB_FILE_PATH` per
project's `.mcp.json`), and the rollout below preserves that. If you have arranged
something else, stop the other process before upgrading.

### Recovery points

Before applying anything, the server writes a snapshot next to the database:
`<db>.v<current>.bak`. It uses the SQLite Online Backup API, not `VACUUM INTO`,
because VACUUM may renumber the ROWIDs of tables without an explicit
`INTEGER PRIMARY KEY` — `entities` is such a table and `entities_fts` indexes it by
ROWID, so a renumbered snapshot would pass `quick_check` and still fail FTS queries
once restored. Every snapshot is verified before it is published: page-level
`quick_check`, plus FTS5's own `integrity-check` on each full-text index.

**An existing snapshot is never overwritten.** A second attempt writes `.bak.1`, a
third `.bak.2`. Every file in that rotation was taken before any schema change, so
each one is a valid pre-migration snapshot on its own — nothing has to prove which
one matches the live database.

To restore: stop the server, move the live database aside, copy the snapshot into
its place, and start again. The engine will re-apply the migration.

### Recovery-point slots are full

If all three slots are taken, the server refuses to migrate and exits before it
connects. **In an MCP client this looks like the server being unavailable**, and the
explanation is only on stderr — check the client's MCP log for a line beginning
`migration refused:`.

The slot count is a circuit breaker for one schema version, not a disk quota (each
version has its own set), and the files in it are not necessarily failed attempts —
an unrelated or stale `.bak` occupies a slot just the same. Look at what is there,
move aside what you do not need, and start the server again. Nothing is deleted for
you: a recovery point is never removed automatically.

### Rollout

Canary one project, then three of different sizes, then the rest. At each step,
confirm after the first boot:

- the MCP log shows `backup <path>` followed by `Migration 13 applied successfully`
- `getMigrationStatus` reports version 13
- a search still returns results (`searchNodes` on a term you know exists)
- `getObservationHistory({entity_name: "<some entity>"})` returns its roots

Then kill the server mid-run and restart it once, to confirm a restart resumes
rather than refusing.
