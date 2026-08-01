#!/usr/bin/env node
// v14 (spec §6): schema-only up/down/재up + DEFAULT 백필 + rollback 응답 한계 (r5-10).
// makeManager 가 sqlite-vec 로드·migration 등록·실행을 전부 소유한다 (r5-6).
import assert from 'node:assert/strict';
import { makeManager } from './helpers/engine-test-db.mjs';

const { manager, cleanup } = await makeManager();
try {
  const db = manager.db;
  const cols = () => db.prepare(`PRAGMA table_info(documents)`).all().map(c => c.name);

  assert.ok(cols().includes('chunking_signature'), 'v14 applied on fresh DB');
  assert.equal(db.prepare(`SELECT value FROM server_meta WHERE key='current_default_chunker'`).get().value,
    'c1:enc=cl100k_base:max=800:overlap=0:fence=on:merge=400:fallback=cp-exact-800');

  // down: 응답이 semantic 한계를 실어야 한다 (spec §6.3 — description 이 아니라 응답, r5-10)
  const rb = await manager.rollbackMigration(13);
  assert.equal(rb.semanticRollback, false, 'response: semanticRollback=false');
  assert.match(rb.warning, /chunk boundaries|chunking/i, 'response: warning about boundaries');
  assert.ok(!cols().includes('chunking_signature'), 'down drops column');
  assert.equal(db.prepare(`SELECT count(*) n FROM server_meta WHERE key='current_default_chunker'`).get().n, 0);

  // pre-v14 상태에서 문서 삽입 -> 재up 하면 DDL DEFAULT 가 legacy-unknown 백필
  db.prepare(`INSERT INTO documents (id, content, metadata) VALUES ('legacy1','x','{}')`).run();
  const before = db.prepare(`SELECT count(*) n FROM documents`).get().n;
  await manager.runMigrations();
  assert.equal(db.prepare(`SELECT chunking_signature FROM documents WHERE id='legacy1'`).get().chunking_signature,
    'legacy-unknown', 're-up backfills legacy-unknown');
  assert.equal(db.prepare(`SELECT count(*) n FROM documents`).get().n, before, 'rows unchanged');
  assert.equal(db.prepare(`PRAGMA foreign_key_check`).all().length, 0, 'fk clean');

  console.log('migration14: ALL PASS');
} finally { cleanup(); }
