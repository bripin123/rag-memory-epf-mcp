#!/usr/bin/env node
// v14 실데이터 리허설 2/2: 대표 content-change sync (별도 프로세스/DB). env 없으면 SKIP.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { installFakeEmbedder } from './helpers/engine-test-db.mjs';

const src = process.env.RAG_MEMORY_REALDATA_V13_DB;
if (!src) { console.log('migration14-realdata-sync: SKIP (env unset)'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v14-realsync-'));
const work = path.join(dir, 'real.db');
fs.copyFileSync(src, work);
process.env.DB_FILE_PATH = work;
process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const mod = await import('../dist/index.js');
const mgr = new mod.RAGKnowledgeGraphManager();
await mgr.initialize({ skipModel: true });
installFakeEmbedder(mgr);
await mgr.startReconciliation();
const db = mgr.db;

// 대표 문서 = 가장 큰 문서 (실제 편집 패턴 = top-insert)
const target = db.prepare(`SELECT id, content FROM documents ORDER BY length(content) DESC LIMIT 1`).get();
// r7-5·r8-2: 비대상 보존 = 전 컬럼 정렬 SHA (양쪽 v14 상태라 chunking_signature 포함)
const nonTargetFp = () => {
  const h = (rows) => { const hh = createHash('sha256'); for (const r of rows) hh.update(JSON.stringify(r)); return hh.digest('hex'); };
  const docs = h(db.prepare(`SELECT id, content, metadata, created_at, chunking_signature FROM documents WHERE id != ? ORDER BY id`).all(target.id));
  const chunks = h(db.prepare(`SELECT rowid, chunk_id, document_id, chunk_index, text, start_pos, end_pos,
    created_at, chunk_type, entity_id, relationship_id, metadata, start_token, end_token,
    input_hash, profile_id, provenance_state
    FROM chunk_metadata WHERE document_id != ? OR document_id IS NULL ORDER BY rowid`).all(target.id));
  const vh = createHash('sha256');
  for (const r of db.prepare(`SELECT c.rowid, c.embedding FROM chunks c JOIN chunk_metadata m ON m.rowid = c.rowid
    WHERE m.document_id != ? OR m.document_id IS NULL ORDER BY c.rowid`).all(target.id)) { vh.update(String(r.rowid)); vh.update(Buffer.from(r.embedding)); }
  const links = h(db.prepare(`SELECT ce.chunk_rowid, ce.entity_id FROM chunk_entities ce JOIN chunk_metadata m ON m.rowid = ce.chunk_rowid
    WHERE m.document_id != ? OR m.document_id IS NULL ORDER BY ce.chunk_rowid, ce.entity_id`).all(target.id));
  return { docs, chunks, vectors: vh.digest('hex'), links };
};
const fpBefore = nonTargetFp();
const chunksBefore = db.prepare(`SELECT count(*) n FROM chunk_metadata WHERE document_id = ?`).get(target.id).n;

const entry = '## [SYNTH] realdata representative edit\n대표 편집 리허설 엔트리.\n\n';
const r = await mgr.syncDocumentFromFile('/dev/null', target.id, { content: entry + target.content });
assert.equal(r.chunkerTransitioned, true, 'legacy-unknown -> c1 전환 보고');
assert.ok(r.chunks > 0 && r.deletedChunks === chunksBefore, '대상 delta: 옛 chunk 전량 교체');
assert.equal(db.prepare(`SELECT chunking_signature FROM documents WHERE id=?`).get(target.id).chunking_signature,
  'c1:enc=cl100k_base:max=800:overlap=0:fence=on:fallback=cp-exact-800', '대상 signature 기록');
assert.deepEqual(nonTargetFp(), fpBefore, '비대상 documents·chunks·vectors·links byte-보존 (r7-5)');
assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'fk clean');
assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok', 'quick_check');
db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')`);
db.exec(`INSERT INTO entities_fts(entities_fts) VALUES('integrity-check')`);
const stats = await mgr.getKnowledgeGraphStats();
assert.equal(stats.chunking.current, 1, 'current = 전환된 1건');
console.log('migration14-realdata-sync: ALL PASS');
mgr.cleanup();
