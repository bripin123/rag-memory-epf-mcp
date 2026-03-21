# rag-memory-epf-mcp

[![npm version](https://img.shields.io/npm/v/rag-memory-epf-mcp)](https://www.npmjs.com/package/rag-memory-epf-mcp)
[![npm downloads](https://img.shields.io/npm/dm/rag-memory-epf-mcp)](https://www.npmjs.com/package/rag-memory-epf-mcp)
[![GitHub license](https://img.shields.io/github/license/heesongkoh/rag-memory-epf-mcp)](https://github.com/heesongkoh/rag-memory-epf-mcp/blob/main/LICENSE)
[![Platforms](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](https://github.com/heesongkoh/rag-memory-epf-mcp)

An advanced MCP server for **RAG-enabled memory** through a knowledge graph with **multilingual vector search** capabilities.

**Fork of:** [rag-memory-mcp](https://github.com/ttommyth/rag-memory-mcp) — upgraded with **Qwen3-Embedding-0.6B** (1024-dim, 100+ languages) for significantly better multilingual semantic search.

## What's Different

| | rag-memory-mcp (original) | rag-memory-epf-mcp (this fork) |
|---|---|---|
| **Embedding Model** | all-MiniLM-L12-v2 | **Qwen3-Embedding-0.6B** |
| **Dimensions** | 384 | **1024** |
| **Languages** | English only | **100+ (Korean, Chinese, Japanese, Arabic, etc.)** |
| **MTEB Score** | ~49 | **63.0+** |
| **Max Tokens** | 256 | **8192** |
| **Unicode Support** | ASCII only fallback | **Full Unicode (CJK, Arabic, Cyrillic, etc.)** |
| **Auto Entity Linking** | None | **Chunk-level with word boundary + CJK support** |

## Quick Start

```json
{
  "mcpServers": {
    "rag-memory": {
      "command": "npx",
      "args": ["-y", "rag-memory-epf-mcp@latest"]
    }
  }
}
```

**With custom database path:**
```json
{
  "mcpServers": {
    "rag-memory": {
      "command": "npx",
      "args": ["-y", "rag-memory-epf-mcp@latest"],
      "env": {
        "DB_FILE_PATH": "/path/to/your/rag-memory.db"
      }
    }
  }
}
```

## Document Processing Pipeline

`embedChunks` automatically links entities to the specific chunks where they appear:

```
storeDocument(id, content, metadata)
  |
chunkDocument(documentId, maxTokens, overlap)
  |
embedChunks(documentId)
  |-- generates vector embeddings for each chunk
  |-- auto-links entities to chunks where they appear (chunk-level precision)
  +-- returns { embeddedChunks, linkedEntities }

linkEntitiesToDocument(documentId, entityNames)
  +-- [optional] manually link additional entities that auto-linking missed
```

### Auto Entity Linking (v1.5.0+)

When `embedChunks` runs, it automatically:

- **Chunk-level matching** — entities are linked only to chunks where they actually appear, not all chunks
- **Word boundary matching** — for Latin text, prevents partial-word false matches (e.g. "Phase" won't match "multiphase")
- **CJK-aware matching** — Korean/Chinese/Japanese entity names use substring matching (word boundaries don't apply)
- **Observation-derived aliases** — file paths and identifiers from entity observations are also matched
- **Smart length thresholds** — min 2 chars for CJK entities, min 4 chars for Latin entities

## Migration

### From rag-memory-mcp (original)

1. Replace `rag-memory-mcp` with `rag-memory-epf-mcp@latest` in your config
2. Migrations run automatically (384 -> 1024 dimensions)
3. Re-embed your data:
   - `embedAllEntities()` — re-embeds all entities
   - `embedChunks(documentId)` — re-embeds each document's chunks

### From rag-memory-epf-mcp v1.2.x (jina-v5-nano)

1. Update to `rag-memory-epf-mcp@latest`
2. Migration v5 runs automatically (768 -> 1024 dimensions)
3. Re-embed your data (same commands as above)

Your entities, relationships, documents, and chunk text are preserved. Only vector embeddings are regenerated.

## Tools

### Document Management
- `storeDocument`: Store documents with metadata
- `chunkDocument`: Create text chunks with configurable parameters
- `embedChunks`: Generate 1024-dim vector embeddings + auto-link entities (chunk-level)
- `extractTerms`: Extract potential entity terms
- `linkEntitiesToDocument`: Manually create entity-document associations
- `deleteDocuments`: Remove documents and associated data
- `listDocuments`: View all stored documents

### Knowledge Graph
- `createEntities`: Create entities with observations and types
- `createRelations`: Establish relationships between entities
- `addObservations`: Add contextual information to entities
- `deleteEntities`: Remove entities and relationships
- `deleteRelations`: Remove specific relationships
- `deleteObservations`: Remove specific observations
- `embedAllEntities`: Generate embeddings for all entities

### Search & Retrieval
- `hybridSearch`: Vector similarity + graph traversal
- `searchNodes`: Semantic entity search (multilingual)
- `openNodes`: Retrieve specific entities
- `readGraph`: Get complete knowledge graph
- `getDetailedContext`: Get full context for a chunk

### Analytics & Migration
- `getKnowledgeGraphStats`: Knowledge base statistics
- `getMigrationStatus`: Check database schema version
- `runMigrations`: Apply pending migrations
- `rollbackMigration`: Revert to a previous schema version

## Changelog

### v1.5.0

- **Improved auto entity linking** — chunk-level precision instead of linking to all chunks
- **Word boundary matching** — Latin entity names use regex word boundaries to prevent partial matches
- **CJK-aware matching** — Korean/Chinese/Japanese names use substring matching with lower min-length threshold (2 chars vs 4)
- **Observation-derived aliases** — file paths from entity observations are matched against chunk text
- **README overhaul** — added pipeline diagram, auto-linking docs, changelog section

### v1.4.2

- fp16 quantization for embeddings
- Auto-link entities after `embedChunks` (document-level, basic substring match)

### v1.4.1

- Qwen3 instruction prefix optimization
- Entity embedding text format improvements

### v1.4.0

- Switched embedding model to **Qwen3-Embedding-0.6B** (1024-dim, 100+ languages)
- Replaced BGE-M3 for better multilingual performance

### v1.3.x

- Cross-lingual graph boost via entity vector search
- Korean + acronym + partial matching improvements
- Unicode/Korean fallback embedding fixes

### v1.2.x

- jina-v5-nano embedding model (768-dim)
- Initial multilingual support

### v1.0.0

- Initial fork from rag-memory-mcp
- BGE-M3 embedding model (1024-dim)
- sqlite-vec vector search

## Environment Variables

- `DB_FILE_PATH`: Path to the SQLite database file (default: `rag-memory.db` in the server directory)

## Development

```bash
git clone https://github.com/heesongkoh/rag-memory-epf-mcp.git
cd rag-memory-epf-mcp
npm install
npm run build
```

## License

MIT License. See [LICENSE](LICENSE) for details.

---

**Built with**: TypeScript, SQLite, sqlite-vec, Hugging Face Transformers (Qwen3-Embedding-0.6B), Model Context Protocol SDK
