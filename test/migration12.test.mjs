// Migration 12 verification: provenance schema, narrowed FTS trigger, rollback -> reapply.
// Spec: docs (framework) 2026-07-18-rag-memory-v36-lite-install-design.md §6c, DoD 9/14.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const dir = mkdtempSync(join(tmpdir(), 'rag-m12-'));
process.env.DB_FILE_PATH = join(dir, 'test.db');
const { RAGKnowledgeGraphManager } = await import('../dist/index.js');

const mgr = new RAGKnowledgeGraphManager();
await mgr.initialize({ skipModel: true });
const db = mgr.db;

// 1) schema present
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
for (const t of ['chunk_metadata', 'entity_embedding_metadata']) {
  for (const c of ['input_hash', 'profile_id', 'provenance_state']) {
    assert.ok(cols(t).includes(c), `${t}.${c} missing`);
  }
}
for (const t of ['embedding_profiles', 'embedding_backfill_failures', 'server_meta']) {
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE name=?`).get(t), `${t} missing`);
}
console.log('  OK: provenance schema present');

// 2) provenance-only UPDATE must NOT fire the chunks_fts update trigger (DoD 14).
//    FTS5 virtual tables cannot host audit triggers, so firing is observed
//    behaviorally: manually remove the FTS entry — a broad trigger would
//    RESTORE it on any UPDATE (delete old + insert new), the narrowed trigger
//    must leave it absent for provenance-only updates.
const trigSql = db.prepare(`SELECT sql FROM sqlite_master WHERE name='chunks_fts_update'`).get().sql;
assert.ok(/AFTER UPDATE OF text, chunk_id/i.test(trigSql), `trigger not narrowed: ${trigSql}`);
db.exec(`INSERT INTO documents (id, content, metadata) VALUES ('d1','hello world','{}')`);
db.exec(`INSERT INTO chunk_metadata (chunk_id, document_id, chunk_index, text) VALUES ('c1','d1',0,'hello world')`);
const rowid = db.prepare(`SELECT rowid FROM chunk_metadata WHERE chunk_id='c1'`).get().rowid;
db.prepare(`INSERT INTO chunks_fts(chunks_fts, rowid, text, chunk_id) VALUES('delete', ?, 'hello world', 'c1')`).run(rowid);
assert.equal(db.prepare(`SELECT COUNT(*) c FROM chunks_fts WHERE chunks_fts MATCH '"hello"'`).get().c, 0, 'fixture: FTS entry not removed');
db.prepare(`UPDATE chunk_metadata SET input_hash='abc', profile_id=1, provenance_state='legacy_assumed' WHERE chunk_id='c1'`).run();
assert.equal(db.prepare(`SELECT COUNT(*) c FROM chunks_fts WHERE chunks_fts MATCH '"hello"'`).get().c, 0,
  'provenance-only UPDATE fired FTS trigger (entry restored)');
console.log('  OK: provenance-only UPDATE fires no FTS rewrite');

// Restore the FTS entry so the narrowed trigger's delete-then-insert on a real
// text UPDATE operates on a consistent index.
db.prepare(`INSERT INTO chunks_fts(rowid, text, chunk_id) VALUES(?, 'hello world', 'c1')`).run(rowid);
db.prepare(`UPDATE chunk_metadata SET text='hello mars' WHERE chunk_id='c1'`).run();
assert.equal(db.prepare(`SELECT COUNT(*) c FROM chunks_fts WHERE chunks_fts MATCH '"mars"'`).get().c, 1,
  'text UPDATE did not fire FTS trigger');
console.log('  OK: text UPDATE still maintains FTS');

// 3) FTS content actually reflects the text update (trigger correctness)
const hit = db.prepare(`SELECT cm.chunk_id FROM chunks_fts JOIN chunk_metadata cm ON chunks_fts.rowid = cm.rowid WHERE chunks_fts MATCH '"mars"'`).all();
assert.equal(hit.length, 1, 'FTS index stale after text update');
console.log('  OK: FTS index content correct');

// 4) rollback -> reapply
const rb = await mgr.rollbackMigration(11);
assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE name='embedding_profiles'`).get() === undefined,
  'embedding_profiles not dropped on rollback');
const re = await mgr.runMigrations();
assert.ok(re.currentVersion >= 12, `reapply failed: v${re.currentVersion}`);
assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE name='embedding_profiles'`).get(), 'reapply missing table');
console.log('  OK: rollback -> reapply');

mgr.cleanup();
rmSync(dir, { recursive: true, force: true });
console.log('MIGRATION12 OK');
