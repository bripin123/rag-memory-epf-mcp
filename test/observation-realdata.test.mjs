// §8.5 실데이터 회귀. 실제 프로젝트 DB 사본으로 마이그레이션이 무손실인지 확인한다.
// DB 가 없는 환경(CI)에서는 skip — 단 skip 을 조용히 하지 않고 명시 출력한다.
import { mkdtempSync, rmSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const REAL = process.env.RAG_MEMORY_REALDATA_DB;
if (!REAL || !existsSync(REAL)) {
  console.log('observation-realdata: SKIPPED (set RAG_MEMORY_REALDATA_DB to a v12 db copy)');
  process.exit(0);
}

process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const dir = mkdtempSync(join(tmpdir(), 'rag-obs-real-'));
const work = join(dir, 'copy.db');
copyFileSync(REAL, work);

// 사전 상태
const pre = new Database(work, { readonly: true });
const preVersion = pre.prepare(`SELECT COALESCE(MAX(version), 0) v FROM schema_migrations`).get().v;
assert.ok(preVersion < 13,
  `fixture is already at schema v${preVersion} — this test needs a pre-v13 copy to prove anything`);
const before = pre.prepare(`SELECT id, observations FROM entities ORDER BY id`).all();
const entityCount = before.length;
const totalChars = before.reduce((n, r) => n + (r.observations?.length ?? 0), 0);
const preEmbeddings = pre.prepare(`SELECT COUNT(*) c FROM entity_embedding_metadata`).get().c;
const preRelations = pre.prepare(`SELECT COUNT(*) c FROM relationships`).get().c;
const preChunks = pre.prepare(`SELECT COUNT(*) c FROM chunk_metadata`).get().c;
pre.close();
console.log(`  fixture: schema v${preVersion}, ${entityCount} entities, ${totalChars} observation chars`);

process.env.DB_FILE_PATH = work;
const { RAGKnowledgeGraphManager } = await import('../dist/index.js');
const mgr = new RAGKnowledgeGraphManager();
await mgr.initialize({ skipModel: true });
const db = mgr.db;

// 0) 마이그레이션이 실제로 v13 까지 갔다
assert.equal(db.prepare(`SELECT MAX(version) v FROM schema_migrations`).get().v, 13, 'not at v13');

// 1) 전 entity 의 projection 이 원본과 byte 동일
for (const r of before) {
  const now = db.prepare(`SELECT observations FROM entities WHERE id=?`).get(r.id).observations;
  assert.equal(now, JSON.stringify(JSON.parse(r.observations ?? '[]')),
    `projection mismatch for ${r.id}`);
}

// 2) 관찰 총수 == root 총수 == revision 총수 == source 총수 == import event 총수
const arrTotal = before.reduce((n, r) => n + JSON.parse(r.observations ?? '[]').length, 0);
assert.equal(db.prepare(`SELECT COUNT(*) c FROM observation_roots`).get().c, arrTotal, 'root count');
assert.equal(db.prepare(`SELECT COUNT(*) c FROM entity_observations`).get().c, arrTotal, 'revision count');
assert.equal(db.prepare(`SELECT COUNT(*) c FROM observation_sources`).get().c, arrTotal, 'source count');
assert.equal(db.prepare(`SELECT COUNT(*) c FROM observation_events WHERE event='import'`).get().c,
  arrTotal, 'event count');
assert.equal(db.prepare(`SELECT COUNT(*) c FROM entity_observations WHERE status<>'active'`).get().c, 0,
  'migration must land every observation as active');

// 3) FK 무결성 + 물리 무결성
assert.equal(db.prepare(`PRAGMA foreign_key_check`).all().length, 0, 'foreign_key_check');
assert.equal(db.pragma('quick_check', { simple: true }), 'ok', 'quick_check');

// 4) 인접 자산 무손실 — 마이그레이션은 관찰만 건드린다.
//    특히 entity 벡터를 죽이면 검색 품질만 조용히 깎이므로 어떤 기능 테스트도 안 운다.
assert.equal(db.prepare(`SELECT COUNT(*) c FROM entity_embedding_metadata`).get().c, preEmbeddings,
  'entity embeddings were destroyed by the migration');
assert.equal(db.prepare(`SELECT COUNT(*) c FROM relationships`).get().c, preRelations, 'relations changed');
assert.equal(db.prepare(`SELECT COUNT(*) c FROM chunk_metadata`).get().c, preChunks, 'chunks changed');

// 5) 검증된 백업이 남아 있다
const baks = readdirSync(dir).filter(f => f.endsWith('.bak'));
assert.equal(baks.length, 1, `expected exactly one backup, got ${JSON.stringify(baks)}`);
const bak = new Database(join(dir, baks[0]), { readonly: true });
assert.equal(bak.prepare(`SELECT COUNT(*) c FROM entities`).get().c, entityCount,
  'backup does not hold the pre-migration entity set');
assert.ok(!bak.prepare(`SELECT 1 FROM sqlite_master WHERE name='entity_observations'`).get(),
  'backup was taken after the schema change, not before');
bak.close();

// 6) reader 가 실데이터에서 실제로 관찰을 낸다 (부재로 통과하지 못하게)
{
  const sample = db.prepare(
    `SELECT name FROM entities WHERE json_array_length(observations) > 0 ORDER BY id LIMIT 1`).get();
  assert.ok(sample, 'no entity with observations in the fixture — assertions above prove little');
  const opened = await mgr.openNodes([sample.name]);
  assert.ok(opened.entities[0].observations.length > 0,
    `reader returned no observations for ${sample.name} after migration`);
}

console.log(`  OK: ${arrTotal} observations migrated losslessly ` +
            `(${entityCount} entities, ${preEmbeddings} vectors intact)`);

mgr.cleanup?.();
rmSync(dir, { recursive: true, force: true });
console.log('observation-realdata: ALL OK');
