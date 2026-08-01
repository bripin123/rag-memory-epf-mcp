#!/usr/bin/env node
// v14 실데이터 리허설 1/2: schema-only 불변 증명. env RAG_MEMORY_REALDATA_V13_DB 없으면 명시 SKIP
// (배선은 정규 suite — env 지정 실행은 릴리스 게이트 Task 10 이 강제한다).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';

const src = process.env.RAG_MEMORY_REALDATA_V13_DB;
if (!src) { console.log('migration14-realdata: SKIP (RAG_MEMORY_REALDATA_V13_DB unset)'); process.exit(0); }
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

// r8-2: 공통 스키마의 전 컬럼 명시 — 빠진 컬럼만 손상되면 지문이 조용히 통과한다.
// (chunking_signature 는 pre(v13) 에 없으므로 제외 — post 의 legacy-unknown 전수는 별도 assert)
function fingerprint(dbPath) {
  const d = new Database(dbPath, { readonly: true }); sqliteVec.load(d);
  const h = (rows) => { const hh = createHash('sha256'); for (const r of rows) hh.update(JSON.stringify(r)); return hh.digest('hex'); };
  const ver = d.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;
  const docs = h(d.prepare('SELECT id, content, metadata, created_at FROM documents ORDER BY id').all());
  const chunks = h(d.prepare(`SELECT rowid, chunk_id, document_id, chunk_index, text, start_pos, end_pos,
    created_at, chunk_type, entity_id, relationship_id, metadata, start_token, end_token,
    input_hash, profile_id, provenance_state FROM chunk_metadata ORDER BY rowid`).all());
  const vh = createHash('sha256');
  for (const r of d.prepare('SELECT rowid, embedding FROM chunks ORDER BY rowid').all()) { vh.update(String(r.rowid)); vh.update(Buffer.from(r.embedding)); }
  const vectors = vh.digest('hex');
  d.close();
  return { ver, docs, chunks, vectors };
}

const pre = fingerprint(src);
assert.equal(pre.ver, 13, `pre schema version must be 13 (got ${pre.ver}) — v13 live 사본을 지정하라`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v14-real-'));
const work = path.join(dir, 'real.db');
fs.copyFileSync(src, work);                        // 입력은 냉동 사본 (Task 10 전제)
process.env.DB_FILE_PATH = work;
process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const mod = await import('../dist/index.js');
const mgr = new mod.RAGKnowledgeGraphManager();
await mgr.initialize({ skipModel: true });          // migrations run here (index.ts:253 확인)

const db = mgr.db;
assert.ok(db.prepare(`PRAGMA table_info(documents)`).all().some(c => c.name === 'chunking_signature'), 'v14 applied');
assert.equal(db.prepare(`SELECT count(*) n FROM documents WHERE chunking_signature != 'legacy-unknown'`).get().n, 0, 'all legacy-unknown');
assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'fk clean');
assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok', 'quick_check');
db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')`);
db.exec(`INSERT INTO entities_fts(entities_fts) VALUES('integrity-check')`);
const stats = await mgr.getKnowledgeGraphStats();
assert.equal(stats.chunking.legacy, db.prepare('SELECT count(*) n FROM documents').get().n, 'stats: all legacy');
assert.equal(stats.chunking.current + stats.chunking.legacy + stats.chunking.unknown,
  db.prepare('SELECT count(*) n FROM documents').get().n, 'stats partition');
mgr.cleanup();

const post = fingerprint(work);
assert.equal(post.docs, pre.docs, 'documents rows byte-stable');
assert.equal(post.chunks, pre.chunks, 'chunk rows byte-stable');
assert.equal(post.vectors, pre.vectors, 'vector blobs byte-stable');
console.log('migration14-realdata: ALL PASS');
