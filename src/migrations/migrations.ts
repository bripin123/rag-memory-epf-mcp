import { Migration } from './migration-manager.js';

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Complete RAG Knowledge Graph schema - all tables and features',
    up: (db) => {
      // Disable foreign key enforcement to make deletions easier
      db.pragma('foreign_keys = OFF');

      // Original entities table (enhanced)
      db.exec(`
        CREATE TABLE IF NOT EXISTS entities (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          entityType TEXT DEFAULT 'CONCEPT',
          observations TEXT DEFAULT '[]',
          mentions INTEGER DEFAULT 0,
          metadata TEXT DEFAULT '{}',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Original relationships table (enhanced) - FK constraints kept for reference but not enforced
      db.exec(`
        CREATE TABLE IF NOT EXISTS relationships (
          id TEXT PRIMARY KEY,
          source_entity TEXT NOT NULL,
          target_entity TEXT NOT NULL,
          relationType TEXT NOT NULL,
          confidence REAL DEFAULT 1.0,
          metadata TEXT DEFAULT '{}',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (source_entity) REFERENCES entities(id) ON DELETE CASCADE,
          FOREIGN KEY (target_entity) REFERENCES entities(id) ON DELETE CASCADE
        )
      `);

      // Documents table for RAG
      db.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          metadata TEXT DEFAULT '{}',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Vector embeddings using sqlite-vec for document chunks
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING vec0(
          embedding FLOAT[768]
        )
      `);

      // Vector embeddings for entities using sqlite-vec
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS entity_embeddings USING vec0(
          embedding FLOAT[768]
        )
      `);

      // Basic chunk metadata table (without enhanced hybrid search features)
      db.exec(`
        CREATE TABLE IF NOT EXISTS chunk_metadata (
          rowid INTEGER PRIMARY KEY,
          chunk_id TEXT UNIQUE,
          document_id TEXT,
          chunk_index INTEGER,
          text TEXT,
          start_pos INTEGER,
          end_pos INTEGER,
          metadata TEXT DEFAULT '{}',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        )
      `);

      // Entity embedding metadata
      db.exec(`
        CREATE TABLE IF NOT EXISTS entity_embedding_metadata (
          rowid INTEGER PRIMARY KEY,
          entity_id TEXT UNIQUE,
          embedding_text TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
        )
      `);

      // Chunk-Entity associations
      db.exec(`
        CREATE TABLE IF NOT EXISTS chunk_entities (
          chunk_rowid INTEGER NOT NULL,
          entity_id TEXT NOT NULL,
          PRIMARY KEY (chunk_rowid, entity_id),
          FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
          FOREIGN KEY (chunk_rowid) REFERENCES chunk_metadata(rowid) ON DELETE CASCADE
        )
      `);

      // Create indexes
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
        CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_entity);
        CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_entity);
        CREATE INDEX IF NOT EXISTS idx_chunk_entities_entity ON chunk_entities(entity_id);
        CREATE INDEX IF NOT EXISTS idx_chunk_metadata_document ON chunk_metadata(document_id);
        CREATE INDEX IF NOT EXISTS idx_entity_embedding_metadata_entity ON entity_embedding_metadata(entity_id);
      `);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS chunk_entities`);
      db.exec(`DROP TABLE IF EXISTS entity_embedding_metadata`);
      db.exec(`DROP TABLE IF EXISTS entity_embeddings`);
      db.exec(`DROP TABLE IF EXISTS chunks`);
      db.exec(`DROP TABLE IF EXISTS chunk_metadata`);
      db.exec(`DROP TABLE IF EXISTS documents`);
      db.exec(`DROP TABLE IF EXISTS relationships`);
      db.exec(`DROP TABLE IF EXISTS entities`);
    }
  },

  {
    version: 2,
    description: 'Enhanced hybrid search - add chunk_type support for knowledge graph chunks',
    up: (db) => {
      // Add new columns to chunk_metadata to support knowledge graph chunks
      db.exec(`
        ALTER TABLE chunk_metadata ADD COLUMN chunk_type TEXT DEFAULT 'document'
      `);
      
      db.exec(`
        ALTER TABLE chunk_metadata ADD COLUMN entity_id TEXT
      `);
      
      db.exec(`
        ALTER TABLE chunk_metadata ADD COLUMN relationship_id TEXT
      `);

      // Add indexes for the new columns
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chunk_metadata_type ON chunk_metadata(chunk_type);
        CREATE INDEX IF NOT EXISTS idx_chunk_metadata_entity ON chunk_metadata(entity_id);
        CREATE INDEX IF NOT EXISTS idx_chunk_metadata_relationship ON chunk_metadata(relationship_id);
      `);

      // Update existing rows to have chunk_type = 'document'
      db.exec(`
        UPDATE chunk_metadata SET chunk_type = 'document' WHERE chunk_type IS NULL
      `);
    },
    down: (db) => {
      // SQLite doesn't support dropping columns, so we'd need to recreate the table
      // For now, we'll just mark this as not reversible
      throw new Error('This migration cannot be reversed due to SQLite limitations');
    }
  },

  {
    version: 3,
    description: 'Upgrade embedding dimensions from 384 to 768 (gte-multilingual-base)',
    up: (db) => {
      // Drop old 384-dim vector tables
      db.exec(`DROP TABLE IF EXISTS chunks`);
      db.exec(`DROP TABLE IF EXISTS entity_embeddings`);

      // Recreate with 768 dimensions
      db.exec(`
        CREATE VIRTUAL TABLE chunks USING vec0(
          embedding FLOAT[768]
        )
      `);
      db.exec(`
        CREATE VIRTUAL TABLE entity_embeddings USING vec0(
          embedding FLOAT[768]
        )
      `);

      // Clear stale embedding metadata (embeddings need to be regenerated)
      db.exec(`DELETE FROM entity_embedding_metadata`);
    },
    down: (db) => {
      // Revert to 384 dimensions
      db.exec(`DROP TABLE IF EXISTS chunks`);
      db.exec(`DROP TABLE IF EXISTS entity_embeddings`);

      db.exec(`
        CREATE VIRTUAL TABLE chunks USING vec0(
          embedding FLOAT[384]
        )
      `);
      db.exec(`
        CREATE VIRTUAL TABLE entity_embeddings USING vec0(
          embedding FLOAT[384]
        )
      `);

      db.exec(`DELETE FROM entity_embedding_metadata`);
    }
  },

  {
    version: 4,
    description: 'Ensure metadata column exists in chunk_metadata',
    up: (db) => {
      // Some databases may not have the metadata column if created by older versions
      const columns = db.prepare(`PRAGMA table_info(chunk_metadata)`).all() as Array<{ name: string }>;
      const hasMetadata = columns.some(col => col.name === 'metadata');
      if (!hasMetadata) {
        db.exec(`ALTER TABLE chunk_metadata ADD COLUMN metadata TEXT DEFAULT '{}'`);
      }
    },
    down: (db) => {
      // SQLite doesn't support DROP COLUMN easily, so this is a no-op
      // The column will remain but won't cause issues
    }
  },

  {
    version: 5,
    description: 'Upgrade embedding dimensions from 768 to 1024 (bge-m3)',
    up: (db) => {
      // Drop old 768-dim vector tables
      db.exec(`DROP TABLE IF EXISTS chunks`);
      db.exec(`DROP TABLE IF EXISTS entity_embeddings`);

      // Recreate with 1024 dimensions
      db.exec(`
        CREATE VIRTUAL TABLE chunks USING vec0(
          embedding FLOAT[1024]
        )
      `);
      db.exec(`
        CREATE VIRTUAL TABLE entity_embeddings USING vec0(
          embedding FLOAT[1024]
        )
      `);

      // Clear stale embedding metadata (embeddings need to be regenerated)
      db.exec(`DELETE FROM entity_embedding_metadata`);
    },
    down: (db) => {
      // Revert to 768 dimensions
      db.exec(`DROP TABLE IF EXISTS chunks`);
      db.exec(`DROP TABLE IF EXISTS entity_embeddings`);

      db.exec(`
        CREATE VIRTUAL TABLE chunks USING vec0(
          embedding FLOAT[768]
        )
      `);
      db.exec(`
        CREATE VIRTUAL TABLE entity_embeddings USING vec0(
          embedding FLOAT[768]
        )
      `);

      db.exec(`DELETE FROM entity_embedding_metadata`);
    }
  },

  {
    version: 6,
    description: 'Add missing indexes for entityType, relationType, and chunk lookups',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entityType);
        CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(relationType);
        CREATE INDEX IF NOT EXISTS idx_chunk_entities_chunk ON chunk_entities(chunk_rowid);
        CREATE INDEX IF NOT EXISTS idx_chunk_metadata_chunk_id ON chunk_metadata(chunk_id);
      `);
    },
    down: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_entities_type;
        DROP INDEX IF EXISTS idx_relationships_type;
        DROP INDEX IF EXISTS idx_chunk_entities_chunk;
        DROP INDEX IF EXISTS idx_chunk_metadata_chunk_id;
      `);
    }
  },

  {
    version: 7,
    description: 'Add FTS5 full-text search tables and sync triggers for entities and chunks',
    up: (db) => {
      // Create FTS5 virtual table for entities
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
          name, observations, entityType,
          content='entities', content_rowid='rowid',
          tokenize='unicode61'
        )
      `);

      // Create FTS5 virtual table for chunk_metadata
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          text, chunk_id,
          content='chunk_metadata', content_rowid='rowid',
          tokenize='unicode61'
        )
      `);

      // Populate FTS5 tables from existing data
      db.exec(`
        INSERT INTO entities_fts(rowid, name, observations, entityType)
          SELECT rowid, name, observations, entityType FROM entities
      `);

      db.exec(`
        INSERT INTO chunks_fts(rowid, text, chunk_id)
          SELECT rowid, text, chunk_id FROM chunk_metadata
      `);

      // Triggers for automatic FTS5 sync on entities
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS entities_fts_insert AFTER INSERT ON entities BEGIN
          INSERT INTO entities_fts(rowid, name, observations, entityType)
            VALUES (new.rowid, new.name, new.observations, new.entityType);
        END
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS entities_fts_delete AFTER DELETE ON entities BEGIN
          INSERT INTO entities_fts(entities_fts, rowid, name, observations, entityType)
            VALUES ('delete', old.rowid, old.name, old.observations, old.entityType);
        END
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS entities_fts_update AFTER UPDATE ON entities BEGIN
          INSERT INTO entities_fts(entities_fts, rowid, name, observations, entityType)
            VALUES ('delete', old.rowid, old.name, old.observations, old.entityType);
          INSERT INTO entities_fts(rowid, name, observations, entityType)
            VALUES (new.rowid, new.name, new.observations, new.entityType);
        END
      `);

      // Triggers for automatic FTS5 sync on chunk_metadata
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunk_metadata BEGIN
          INSERT INTO chunks_fts(rowid, text, chunk_id)
            VALUES (new.rowid, new.text, new.chunk_id);
        END
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunk_metadata BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text, chunk_id)
            VALUES ('delete', old.rowid, old.text, old.chunk_id);
        END
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE ON chunk_metadata BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text, chunk_id)
            VALUES ('delete', old.rowid, old.text, old.chunk_id);
          INSERT INTO chunks_fts(rowid, text, chunk_id)
            VALUES (new.rowid, new.text, new.chunk_id);
        END
      `);
    },
    down: (db) => {
      // Drop triggers first
      db.exec(`DROP TRIGGER IF EXISTS entities_fts_insert`);
      db.exec(`DROP TRIGGER IF EXISTS entities_fts_delete`);
      db.exec(`DROP TRIGGER IF EXISTS entities_fts_update`);
      db.exec(`DROP TRIGGER IF EXISTS chunks_fts_insert`);
      db.exec(`DROP TRIGGER IF EXISTS chunks_fts_delete`);
      db.exec(`DROP TRIGGER IF EXISTS chunks_fts_update`);

      // Drop FTS5 virtual tables
      db.exec(`DROP TABLE IF EXISTS entities_fts`);
      db.exec(`DROP TABLE IF EXISTS chunks_fts`);
    }
  },
  // Migration 8: Rebuild FTS5 with remove_diacritics for better multilingual matching
  {
    version: 8,
    description: 'Rebuild FTS5 with unicode61 remove_diacritics for multilingual support',
    up: (db) => {
      // Drop existing triggers
      db.exec(`DROP TRIGGER IF EXISTS entities_fts_insert`);
      db.exec(`DROP TRIGGER IF EXISTS entities_fts_delete`);
      db.exec(`DROP TRIGGER IF EXISTS entities_fts_update`);
      db.exec(`DROP TRIGGER IF EXISTS chunks_fts_insert`);
      db.exec(`DROP TRIGGER IF EXISTS chunks_fts_delete`);
      db.exec(`DROP TRIGGER IF EXISTS chunks_fts_update`);

      // Drop old FTS5 tables
      db.exec(`DROP TABLE IF EXISTS entities_fts`);
      db.exec(`DROP TABLE IF EXISTS chunks_fts`);

      // Recreate with remove_diacritics=2 for better multilingual matching
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
          name, observations, entityType,
          content='entities', content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        )
      `);

      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          text, chunk_id,
          content='chunk_metadata', content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        )
      `);

      // Repopulate
      db.exec(`
        INSERT INTO entities_fts(rowid, name, observations, entityType)
          SELECT rowid, name, observations, entityType FROM entities
      `);
      db.exec(`
        INSERT INTO chunks_fts(rowid, text, chunk_id)
          SELECT rowid, text, chunk_id FROM chunk_metadata
      `);

      // Recreate triggers
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS entities_fts_insert AFTER INSERT ON entities BEGIN
          INSERT INTO entities_fts(rowid, name, observations, entityType)
            VALUES (new.rowid, new.name, new.observations, new.entityType);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS entities_fts_delete AFTER DELETE ON entities BEGIN
          INSERT INTO entities_fts(entities_fts, rowid, name, observations, entityType)
            VALUES ('delete', old.rowid, old.name, old.observations, old.entityType);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS entities_fts_update AFTER UPDATE ON entities BEGIN
          INSERT INTO entities_fts(entities_fts, rowid, name, observations, entityType)
            VALUES ('delete', old.rowid, old.name, old.observations, old.entityType);
          INSERT INTO entities_fts(rowid, name, observations, entityType)
            VALUES (new.rowid, new.name, new.observations, new.entityType);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunk_metadata BEGIN
          INSERT INTO chunks_fts(rowid, text, chunk_id)
            VALUES (new.rowid, new.text, new.chunk_id);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunk_metadata BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text, chunk_id)
            VALUES ('delete', old.rowid, old.text, old.chunk_id);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE ON chunk_metadata BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text, chunk_id)
            VALUES ('delete', old.rowid, old.text, old.chunk_id);
          INSERT INTO chunks_fts(rowid, text, chunk_id)
            VALUES (new.rowid, new.text, new.chunk_id);
        END
      `);
    },
    down: (db) => {
      db.exec(`DROP TRIGGER IF EXISTS entities_fts_insert`);
      db.exec(`DROP TRIGGER IF EXISTS entities_fts_delete`);
      db.exec(`DROP TRIGGER IF EXISTS entities_fts_update`);
      db.exec(`DROP TRIGGER IF EXISTS chunks_fts_insert`);
      db.exec(`DROP TRIGGER IF EXISTS chunks_fts_delete`);
      db.exec(`DROP TRIGGER IF EXISTS chunks_fts_update`);
      db.exec(`DROP TABLE IF EXISTS entities_fts`);
      db.exec(`DROP TABLE IF EXISTS chunks_fts`);
    }
  },

  // Migration 10: Separate token-space vs char-space chunk offsets.
  // (Slot 9 is intentionally skipped — some user databases from early v3.x
  // experiments have an unrelated migration recorded at version 9 (Ollama
  // dimension swap). Reusing that slot would silently no-op against those
  // databases. Version 10 ensures the migration runs everywhere.)
  // Before this migration, chunk_metadata.start_pos/end_pos held *token* indices
  // for document chunks (a leftover from the BPE tokenizer-based chunkText loop)
  // but already held character lengths (0..text.length) for entity/relationship
  // chunks. Same column, two meanings — and a column name (`*_pos`) that implies
  // char offsets in `documents.content`. This migration adds explicit
  // start_token/end_token columns and reinterprets start_pos/end_pos as character
  // offsets going forward. Existing document chunks: token data is moved to the
  // new columns and char offsets are recomputed from documents.content via
  // indexOf with a running cursor (NULL on miss — caller can re-chunk to fill).
  // Existing entity/relationship chunks: leave start_pos/end_pos as-is
  // (already a valid 0..text.length char range against the chunk text itself);
  // token columns stay NULL since these chunks have no token-space concept.
  {
    version: 10,
    description: 'Add start_token/end_token; reinterpret start_pos/end_pos as char offsets',
    up: (db) => {
      // 1) Add columns (idempotent — some databases may have been touched by a
      //    pre-release v9 attempt; tolerate the column already existing).
      const cols = (db.prepare(`PRAGMA table_info(chunk_metadata)`).all() as Array<{ name: string }>)
        .map(c => c.name);
      if (!cols.includes('start_token')) {
        db.exec(`ALTER TABLE chunk_metadata ADD COLUMN start_token INTEGER`);
      }
      if (!cols.includes('end_token')) {
        db.exec(`ALTER TABLE chunk_metadata ADD COLUMN end_token INTEGER`);
      }

      // 2) Move token data into new columns for document chunks (only if not
      //    already moved — guard against re-running in the rare case a prior
      //    partial run already touched some rows).
      db.exec(`
        UPDATE chunk_metadata
          SET start_token = start_pos,
              end_token = end_pos,
              start_pos = NULL,
              end_pos = NULL
          WHERE chunk_type = 'document'
            AND start_token IS NULL
            AND start_pos IS NOT NULL
      `);

      // 3) Recompute char offsets via indexOf with a running cursor per document
      const docRows = db.prepare(`
        SELECT DISTINCT document_id FROM chunk_metadata
          WHERE chunk_type = 'document' AND document_id IS NOT NULL
      `).all() as Array<{ document_id: string }>;

      const docContentStmt = db.prepare(`SELECT content FROM documents WHERE id = ?`);
      const chunksStmt = db.prepare(`
        SELECT rowid, text FROM chunk_metadata
          WHERE document_id = ? AND chunk_type = 'document'
          ORDER BY chunk_index ASC
      `);
      const updateStmt = db.prepare(`
        UPDATE chunk_metadata SET start_pos = ?, end_pos = ? WHERE rowid = ?
      `);

      for (const { document_id } of docRows) {
        const doc = docContentStmt.get(document_id) as { content: string } | undefined;
        if (!doc) continue;
        const content = doc.content;
        const chunks = chunksStmt.all(document_id) as Array<{ rowid: number; text: string }>;
        // Cursor advances by the previous chunk's *start*, not its end, so we can
        // still locate overlapping chunks. Token-space stride guarantees each
        // chunk's start is strictly forward of the previous chunk's start.
        let cursor = 0;
        for (const c of chunks) {
          if (!c.text) continue;
          const idx = content.indexOf(c.text, cursor);
          if (idx >= 0) {
            updateStmt.run(idx, idx + c.text.length, c.rowid);
            cursor = idx;
          }
          // miss: leave NULL — caller can re-chunk to repair
        }
      }
    },
    down: (db) => {
      // SQLite cannot DROP COLUMN cleanly. Best-effort: copy token data back into
      // start_pos/end_pos for document chunks so a downgrade leaves the legacy
      // token-space semantics in place.
      db.exec(`
        UPDATE chunk_metadata
          SET start_pos = start_token, end_pos = end_token
          WHERE chunk_type = 'document' AND start_token IS NOT NULL
      `);
      // start_token/end_token columns remain (no DROP COLUMN); they will be
      // ignored by older code.
    }
  },

  // Migration 11: Convert chunk_metadata.start_pos/end_pos from JS UTF-16 code
  // unit indices to Unicode codepoint indices. v3.3.4 stored offsets in JS's
  // native UTF-16 unit space, which mismatches SQL substr/length and Python
  // string indexing for any document containing supplementary characters
  // (emoji, rare CJK). Codepoints are language-neutral. Walks each document's
  // chunks in chunk_index order, locating each chunk in the source via UTF-16
  // indexOf and counting codepoints between cursor positions to derive the
  // codepoint offsets. Idempotent — chunks where indexOf misses keep their
  // existing values.
  {
    version: 11,
    description: 'Convert chunk_metadata.start_pos/end_pos to Unicode codepoint indices',
    up: (db) => {
      const docRows = db.prepare(`SELECT DISTINCT document_id FROM chunk_metadata
        WHERE chunk_type='document' AND document_id IS NOT NULL
          AND start_pos IS NOT NULL AND end_pos IS NOT NULL`).all() as Array<{ document_id: string }>;
      const getContent = db.prepare(`SELECT content FROM documents WHERE id = ?`);
      const getChunks = db.prepare(`SELECT rowid, text FROM chunk_metadata
        WHERE document_id=? AND chunk_type='document'
          AND start_pos IS NOT NULL AND end_pos IS NOT NULL
        ORDER BY chunk_index ASC`);
      const upd = db.prepare(`UPDATE chunk_metadata SET start_pos=?, end_pos=? WHERE rowid=?`);

      for (const { document_id } of docRows) {
        const doc = getContent.get(document_id) as { content: string } | undefined;
        if (!doc) continue;
        const content = doc.content;
        const chunks = getChunks.all(document_id) as Array<{ rowid: number; text: string }>;
        let utf16Cursor = 0;
        let cpCursor = 0;
        for (const c of chunks) {
          if (!c.text) continue;
          const utfIdx = content.indexOf(c.text, utf16Cursor);
          if (utfIdx < 0) continue; // miss: leave existing
          if (utfIdx > utf16Cursor) {
            cpCursor += [...content.slice(utf16Cursor, utfIdx)].length;
            utf16Cursor = utfIdx;
          }
          const cpLen = [...c.text].length;
          upd.run(cpCursor, cpCursor + cpLen, c.rowid);
        }
      }
    },
    down: (_db) => {
      // No clean reversal: would need the original document content to recompute
      // UTF-16 indices, and we never recorded which chunks were touched. No-op.
    }
  }
];