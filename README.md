# rag-memory-epf-mcp

[![npm version](https://img.shields.io/npm/v/rag-memory-epf-mcp)](https://www.npmjs.com/package/rag-memory-epf-mcp)
[![npm downloads](https://img.shields.io/npm/dm/rag-memory-epf-mcp)](https://www.npmjs.com/package/rag-memory-epf-mcp)
[![GitHub license](https://img.shields.io/github/license/bripin123/rag-memory-epf-mcp)](https://github.com/bripin123/rag-memory-epf-mcp/blob/main/LICENSE)
[![Platforms](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](https://github.com/bripin123/rag-memory-epf-mcp)

An advanced MCP server for **RAG-enabled memory** through a knowledge graph with **multilingual vector search** capabilities.

**Fork of:** [rag-memory-mcp](https://github.com/ttommyth/rag-memory-mcp) — upgraded with **gte-multilingual-base** (768-dim, 70+ languages) for significantly better multilingual semantic search.

## What's Different

| | rag-memory-mcp (original) | rag-memory-epf-mcp (this fork) |
|---|---|---|
| **Embedding Model** | all-MiniLM-L12-v2 | **gte-multilingual-base** |
| **Dimensions** | 384 | **768** |
| **Languages** | English only | **70+ (Korean, Arabic, Chinese, etc.)** |
| **Quality** | ~49 MTEB | **SOTA on MIRACL/MLDR** |
| **Max Tokens** | 256 | **8192** |

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

## Migration from rag-memory-mcp

If you have an existing database from the original `rag-memory-mcp`:

1. Replace `rag-memory-mcp` with `rag-memory-epf-mcp@latest` in your `.mcp.json`
2. **Migration v3 runs automatically** — recreates vector tables with 768 dimensions
3. Re-embed your data:
   - `embedAllEntities()` — re-embeds all entities
   - `embedChunks(documentId)` — re-embeds each document's chunks

Your entities, relationships, documents, and chunk text are preserved. Only vector embeddings are regenerated.

## Tools

### 📚 Document Management
- `storeDocument`: Store documents with metadata
- `chunkDocument`: Create text chunks with configurable parameters
- `embedChunks`: Generate 768-dim vector embeddings
- `extractTerms`: Extract potential entity terms
- `linkEntitiesToDocument`: Create entity-document associations
- `deleteDocuments`: Remove documents and associated data
- `listDocuments`: View all stored documents

### 🧠 Knowledge Graph
- `createEntities`: Create entities with observations and types
- `createRelations`: Establish relationships between entities
- `addObservations`: Add contextual information to entities
- `deleteEntities`: Remove entities and relationships
- `deleteRelations`: Remove specific relationships
- `deleteObservations`: Remove specific observations
- `embedAllEntities`: Generate embeddings for all entities

### 🔍 Search & Retrieval
- `hybridSearch`: Vector similarity + graph traversal
- `searchNodes`: Semantic entity search (multilingual)
- `openNodes`: Retrieve specific entities
- `readGraph`: Get complete knowledge graph
- `getDetailedContext`: Get full context for a chunk

### 📊 Analytics & Migration
- `getKnowledgeGraphStats`: Knowledge base statistics
- `getMigrationStatus`: Check database schema version
- `runMigrations`: Apply pending migrations
- `rollbackMigration`: Revert to a previous schema version

## Environment Variables

- `DB_FILE_PATH`: Path to the SQLite database file (default: `rag-memory.db` in the server directory)

## Development

```bash
git clone https://github.com/bripin123/rag-memory-epf-mcp.git
cd rag-memory-epf-mcp
npm install
npm run build
```

## License

MIT License. See [LICENSE](LICENSE) for details.

---

**Built with**: TypeScript, SQLite, sqlite-vec, Hugging Face Transformers (gte-multilingual-base), Model Context Protocol SDK
