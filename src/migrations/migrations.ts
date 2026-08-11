import { Migration } from './migration-manager.js';
import { OBSERVATION_SCHEMA_SQL } from '../observations/schema.js';
import { randomUUID } from 'node:crypto';

// v13 변환의 단계 경계에서 의도적으로 실패시키는 지점. 마이그레이션이 정말로
// all-or-nothing 인지는 각 경계에서 끊어 봐야만 알 수 있다(spec §8.2 T11).
//
// 환경변수가 아니라 명시적 setter 인 이유: 환경변수는 프로덕션 경로에 상시
// 존재하는 스위치가 되고, 오설정 한 줄이 마이그레이션을 깨서 .bak 을 남기고
// 그 .bak 이 재시작을 막는다. 이 setter 는 dist 를 import 한 테스트만 부를 수 있다.
export type MigrationFaultPoint = 'preflight' | 'roots' | 'revisions' | 'sources' | 'gate';
let faultPoint: MigrationFaultPoint | null = null;
export function setMigrationFaultPoint(point: MigrationFaultPoint | null): void {
  faultPoint = point;
}

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Complete RAG Knowledge Graph schema - all tables and features',
    up: (db) => {
      // ⚠ 이 줄은 **아무 일도 하지 않는다** (2026-08-11 실측). migration-manager 가 각
      // 마이그레이션을 `db.transaction(...)` 으로 감싸는데, SQLite 에서 `PRAGMA foreign_keys`
      // 는 **트랜잭션 안에서 no-op** 이기 때문이다. 실측 = 신규 DB 에 13개 마이그레이션을
      // 전부 적용한 뒤에도 `foreign_keys = 1`.
      //
      // **고치지 말 것.** 이 줄이 실제로 동작하게 만들면(트랜잭션 밖으로 빼는 등) FK 는
      // 마이그레이션 이후 **그 프로세스 수명 내내 꺼진 채로 남는다** — 부팅 게이트(index.ts)
      // 는 `runMigrations()` **앞**에서 판정하므로 그걸 못 잡는다. 그 상태에서 entity 를
      // 지우면 observation 계열이 CASCADE 되지 않아 고아·FK 위반이 쌓인다.
      // 회귀 잠금 = test/observation-cascade.test.mjs T25(신규 DB 부팅 후 FK==1).
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
  },

  // v3.6 (spec 2026-07-18 lite-install v5 §6c): embedding provenance + narrowed FTS trigger.
  // ADD COLUMN is guarded by PRAGMA table_info so re-runs are idempotent.
  {
    version: 12,
    description: 'Embedding provenance (profiles, input_hash, provenance_state), backfill failures, narrowed chunks_fts_update trigger',
    up: (db) => {
      const hasCol = (table: string, col: string) =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === col);
      for (const table of ['chunk_metadata', 'entity_embedding_metadata']) {
        if (!hasCol(table, 'input_hash')) db.exec(`ALTER TABLE ${table} ADD COLUMN input_hash TEXT`);
        if (!hasCol(table, 'profile_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN profile_id INTEGER`);
        if (!hasCol(table, 'provenance_state')) db.exec(`ALTER TABLE ${table} ADD COLUMN provenance_state TEXT`);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS embedding_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          dtype TEXT NOT NULL,
          dims INTEGER NOT NULL,
          pooling TEXT NOT NULL,
          normalize INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(model_id, revision, dtype, dims, pooling, normalize)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS embedding_backfill_failures (
          kind TEXT NOT NULL,
          target_id TEXT NOT NULL,
          input_hash TEXT,
          profile_id INTEGER,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(kind, target_id)
        )
      `);
      db.exec(`CREATE TABLE IF NOT EXISTS server_meta (key TEXT PRIMARY KEY, value TEXT)`);
      // Narrow the broad AFTER UPDATE trigger (installed by v8) so provenance-only
      // updates do not rewrite the FTS index (advisor 4R must-fix 1).
      db.exec(`DROP TRIGGER IF EXISTS chunks_fts_update`);
      db.exec(`
        CREATE TRIGGER chunks_fts_update AFTER UPDATE OF text, chunk_id ON chunk_metadata BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text, chunk_id)
            VALUES ('delete', old.rowid, old.text, old.chunk_id);
          INSERT INTO chunks_fts(rowid, text, chunk_id)
            VALUES (new.rowid, new.text, new.chunk_id);
        END
      `);
    },
    down: (db) => {
      // Restore the broad v8 trigger; drop v12 tables. Added columns are left in
      // place (SQLite DROP COLUMN restrictions with dependent objects) — pre-v12
      // code ignores unknown columns, so rollback stays safe (spec §8-4).
      db.exec(`DROP TRIGGER IF EXISTS chunks_fts_update`);
      db.exec(`
        CREATE TRIGGER chunks_fts_update AFTER UPDATE ON chunk_metadata BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text, chunk_id)
            VALUES ('delete', old.rowid, old.text, old.chunk_id);
          INSERT INTO chunks_fts(rowid, text, chunk_id)
            VALUES (new.rowid, new.text, new.chunk_id);
        END
      `);
      db.exec(`DROP TABLE IF EXISTS embedding_backfill_failures`);
      db.exec(`DROP TABLE IF EXISTS embedding_profiles`);
      db.exec(`DROP TABLE IF EXISTS server_meta`);
    }
  },

  // v13 (spec 2026-07-30 observation-lifecycle §4): 관찰 생애주기 정규화.
  // 이 항목은 DDL 만 만든다. 데이터 변환은 후속 단계에서 같은 항목에 덧붙인다.
  {
    version: 13,
    description: 'Observation lifecycle: roots/revisions/sources/events + immutability triggers',
    up: (db) => {
      db.exec(OBSERVATION_SCHEMA_SQL);

      // ---- spec §5.3 변환 ----
      // MIGRATION_TS = 이 DB 의 v12->v13 트랜잭션 시작시각 하나 (전 행 공유).
      // entities.created_at 을 복사하지 않는다 — 그것은 entity 생성시각을
      // 관찰 기록시각으로 단정하는 것이고, import event 는 실제로 지금 발생했다.
      // 원래 관찰 시각은 unknown 으로 둔다 (v13 은 기록시간 축만 다룬다).
      const MIGRATION_TS = new Date().toISOString();
      const BATCH_ID = randomUUID();

      // 단계 경계 fault injection. 주입은 setMigrationFaultPoint() 로만 하며
      // 환경변수를 보지 않는다 — 환경변수로 두면 프로덕션에 "마이그레이션을 깨는
      // 스위치"가 상시 존재하고, 오설정 한 줄이 .bak 을 남겨 재시작을 막는다
      // (advisor beta 자기의심 2 = "더 나쁘다").
      const fault = (point: string) => {
        if (faultPoint === point) throw new Error(`injected fault at '${point}' (test-only)`);
      };

      // 1) 읽기 전용 preflight: array<string> 검증.
      //    JSON.parse 만으로는 객체·숫자·null 요소가 통과한다.
      const rows = db.prepare(`SELECT id, observations FROM entities`).all() as
        Array<{ id: string; observations: string }>;
      const parsed = new Map<string, string[]>();
      for (const r of rows) {
        let val: unknown;
        try { val = JSON.parse(r.observations ?? '[]'); }
        catch { throw new Error(`v13 preflight: entity ${r.id} observations is not JSON`); }
        if (!Array.isArray(val))
          throw new Error(`v13 preflight: entity ${r.id} observations is not an array<string>`);
        for (const el of val) {
          if (typeof el !== 'string')
            throw new Error(`v13 preflight: entity ${r.id} observations contains a non-string ` +
                            `element (${el === null ? 'null' : typeof el}) — array<string> required`);
        }
        parsed.set(r.id, val as string[]);
      }
      fault('preflight');

      // 2~4) roots -> revisions -> sources/events.
      //      이 순서가 계약이다: trg_obs_matches_root 가 root 선행을 요구한다.
      //      3패스로 나눈 이유 = 지점별 fault injection 을 검증 가능하게 하려면
      //      단계 경계가 실제로 존재해야 한다(T11).
      const insRoot = db.prepare(`INSERT INTO observation_roots
        (root_id, entity_id, projection_order, created_at) VALUES (?, ?, ?, ?)`);
      const insRev = db.prepare(`INSERT INTO entity_observations
        (observation_id, root_id, entity_id, revision_no, projection_order,
         content, status, supersedes_id, recorded_at, superseded_at)
        VALUES (?, ?, ?, 1, ?, ?, 'active', NULL, ?, NULL)`);
      const insSrc = db.prepare(`INSERT INTO observation_sources
        (observation_id, source_kind, source_ref, source_hash, recorded_at)
        VALUES (?, 'import', 'v12-migration', NULL, ?)`);
      const insEv = db.prepare(`INSERT INTO observation_events
        (event_id, root_id, from_id, to_id, event, change_kind, reason, actor, batch_id, recorded_at)
        VALUES (?, ?, NULL, ?, 'import', NULL, NULL, 'v12-migration', ?, ?)`);

      // pass 1: roots
      type Plan = { entityId: string; rootId: string; obsId: string; order: number; content: string };
      const plan: Plan[] = [];
      for (const [entityId, arr] of parsed) {
        arr.forEach((content, order) => {
          const rootId = randomUUID();
          insRoot.run(rootId, entityId, order, MIGRATION_TS);
          plan.push({ entityId, rootId, obsId: randomUUID(), order, content });
        });
      }
      fault('roots');

      // pass 2: revisions
      for (const p of plan) insRev.run(p.obsId, p.rootId, p.entityId, p.order, p.content, MIGRATION_TS);
      fault('revisions');

      // pass 3: sources + events
      for (const p of plan) {
        insSrc.run(p.obsId, MIGRATION_TS);
        insEv.run(randomUUID(), p.rootId, p.obsId, BATCH_ID, MIGRATION_TS);
      }
      fault('sources');

      // 6) 검증 게이트 (a): FK 무결성.
      //    FK 가 켜져 있어도 방어층으로 확인한다.
      const fkBad = db.prepare(`PRAGMA foreign_key_check`).all();
      if (fkBad.length > 0)
        throw new Error(`v13 gate: foreign_key_check reported ${fkBad.length} violation(s)`);
      fault('gate');

      // 7) 검증 게이트 (b): 합성 배열 == 원본 배열 (중복·순서 포함 byte 동일)
      const synthStmt = db.prepare(`SELECT content FROM entity_observations
        WHERE entity_id = ? AND status = 'active' ORDER BY projection_order`);
      for (const [entityId, arr] of parsed) {
        const rebuilt = JSON.stringify(
          (synthStmt.all(entityId) as Array<{ content: string }>).map(x => x.content));
        const original = JSON.stringify(arr);
        if (rebuilt !== original)
          throw new Error(`v13 gate: projection mismatch for entity ${entityId}\n` +
                          `  original: ${original}\n  rebuilt:  ${rebuilt}`);
      }
    },
    down: (db) => {
      // 역순 삭제 (FK 의존 순서). 트리거는 테이블과 함께 사라진다.
      db.exec(`DROP TABLE IF EXISTS observation_events`);
      db.exec(`DROP TABLE IF EXISTS observation_sources`);
      db.exec(`DROP TABLE IF EXISTS entity_observations`);
      db.exec(`DROP TABLE IF EXISTS observation_roots`);
    }
  }
  ,{
    version: 14,
    description: 'Chunking signature: documents.chunking_signature (schema-only; backfill legacy-unknown)',
    up: (db) => {
      // spec §6.1: schema-only. 전환은 sync 의 content 변경 시에만 (spec §5.1, r4 D3).
      // 백필값은 'legacy-unknown', NOT 'bpe-800-160': custom chunkDocument 파라미터가
      // 기록된 적 없어 단정하면 거짓 표기가 된다 (advisor r1).
      const before = (db.prepare(`SELECT count(*) AS n FROM documents`).get() as { n: number }).n;
      db.exec(`ALTER TABLE documents ADD COLUMN chunking_signature TEXT NOT NULL DEFAULT 'legacy-unknown'`);
      // 리터럴 고정 — 마이그레이션은 동결된 역사다. 런타임 기본값 진화는 boot upsert 소관.
      db.prepare(`INSERT INTO server_meta (key, value) VALUES ('current_default_chunker', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run('c1:enc=cl100k_base:max=800:overlap=0:fence=on:fallback=cp-exact-800');
      const after = (db.prepare(`SELECT count(*) AS n FROM documents`).get() as { n: number }).n;
      if (after !== before) throw new Error(`v14 gate: documents rows changed ${before} -> ${after}`);
      const cols = db.prepare(`PRAGMA table_info(documents)`).all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'chunking_signature')) throw new Error('v14 gate: column missing after ALTER');
      const fk = db.prepare(`PRAGMA foreign_key_check`).all();
      if (fk.length > 0) throw new Error(`v14 gate: foreign_key_check reported ${fk.length} violations`);
    },
    down: (db) => {
      // 호환성 rollback 뿐 (spec §6.3): chunk 경계는 복원하지 않는다. c1 행은 v13 코드가 읽는다.
      db.exec(`ALTER TABLE documents DROP COLUMN chunking_signature`);
      db.prepare(`DELETE FROM server_meta WHERE key = 'current_default_chunker'`).run();
    }
  }
];
