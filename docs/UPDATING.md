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
  handful; sessions that don't need semantic search can run
  `RAG_MEMORY_EMBEDDINGS=off`. In v3.6 lazy mode, sessions that never call an
  embedding tool never load the model at all — idle footprint drops compared
  to v3.5's eager boot.

## v3.6 breaking response changes

1. `hybridSearch` returns an envelope: `{results, search_mode, model_state,
   coverage, degradation_reason?}` (per-item `search_mode` removed).
2. `deleteObservations` returns `{results: [{entityName, deleted,
   embedding_status}], total_deleted}` instead of a success string.

All other tools are additive (`embedding_status`, `endpoint_embedding_status`,
stats `server` block). Error responses now set `isError: true`; embedding-gate
errors are structured: `{code: "MODEL_NOT_READY" | "EMBEDDINGS_DISABLED",
state, retry_after_ms?, message}`.
