# rag-memory-epf-mcp

[![npm version](https://img.shields.io/npm/v/rag-memory-epf-mcp)](https://www.npmjs.com/package/rag-memory-epf-mcp)
[![npm downloads](https://img.shields.io/npm/dm/rag-memory-epf-mcp)](https://www.npmjs.com/package/rag-memory-epf-mcp)
[![GitHub license](https://img.shields.io/github/license/bripin123/rag-memory-epf-mcp)](https://github.com/bripin123/rag-memory-epf-mcp/blob/main/LICENSE)
[![Platforms](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](https://github.com/bripin123/rag-memory-epf-mcp)

A **project-local RAG memory** MCP server — knowledge graph + multilingual vector search + FTS5 full-text search, all in a single SQLite file per project.

## Key Features

- **Project-local isolation** — each project gets its own `.memory/rag-memory.db`. Multiple projects run simultaneously without interference.
- **3-signal hybrid search** — vector similarity (bge-m3, 1024-dim) + FTS5 BM25 keyword matching + knowledge graph re-ranking, combined via Reciprocal Rank Fusion
- **100+ languages** — Korean, Chinese, Japanese, Arabic, and more. Cross-lingual search works out of the box.
- **Graph-aware scoring** — per-entity geometric decay (0.5^i) with hard cap prevents any single document from dominating results
- **30 MCP tools** — knowledge graph CRUD, document pipeline, hybrid search, multi-hop traversal, graph analytics (centrality / community detection / structure), export/import, temporal queries
- **Codepoint-safe chunking** — chunk offsets are Unicode codepoints, language-neutral across SQL `substr`, Python slicing, and JS `[...str]` iteration. Korean/CJK/emoji documents stay aligned. Verified by a publish-time invariant test.
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

## Tools (30)

### Knowledge Graph (7)
| Tool | Description | Annotation |
|------|------------|------------|
| `createEntities` | Create entities with observations and types (upsert) | idempotent |
| `createRelations` | Establish relationships between entities | idempotent |
| `addObservations` | Add contextual information to entities (dedup) | idempotent |
| `updateRelations` | Update relationship confidence and metadata | idempotent |
| `deleteEntities` | Remove entities and relationships | destructive |
| `deleteRelations` | Remove specific relationships | destructive |
| `deleteObservations` | Remove specific observations | destructive |

### Document Pipeline (8)
| Tool | Description | Annotation |
|------|------------|------------|
| `storeDocument` | Store documents with metadata | idempotent |
| `chunkDocument` | Create text chunks with configurable parameters | — |
| `embedChunks` | Generate 1024-dim embeddings + auto-link entities | idempotent |
| `embedAllEntities` | Batch embed all entities (32 parallel) | idempotent |
| `extractTerms` | Extract potential entity terms | — |
| `linkEntitiesToDocument` | Link entities to chunks where they actually appear (text-matched) | idempotent |
| `deleteDocuments` | Remove documents and associated data | destructive |
| `listDocuments` | View all stored documents | readOnly |

### Search & Retrieval (9)
| Tool | Description | Annotation |
|------|------------|------------|
| `hybridSearch` | Vector + FTS5 BM25 + graph traversal (3-signal) | readOnly |
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
  → chunkDocument(documentId, maxTokens, overlap)
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
│  │  └── 11 migrations (auto-applied)      │  │
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

## Changelog

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
