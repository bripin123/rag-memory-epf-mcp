// §8.5 실데이터 회귀. 실제 프로젝트 DB 사본으로 마이그레이션이 무손실인지 확인한다.
// DB 가 없는 환경(CI)에서는 skip — 단 skip 을 조용히 하지 않고 명시 출력한다.
import { mkdtempSync, rmSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
// entity_embeddings 는 vec0 가상 테이블이라 raw 연결에도 확장을 로드해야 읽힌다.
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'node:crypto';
const openRo = (p) => { const d = new Database(p, { readonly: true }); sqliteVec.load(d); return d; };

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
const pre = openRo(work);
const preVersion = pre.prepare(`SELECT COALESCE(MAX(version), 0) v FROM schema_migrations`).get().v;
assert.ok(preVersion < 13,
  `fixture is already at schema v${preVersion} — this test needs a pre-v13 copy to prove anything`);
const before = pre.prepare(`SELECT id, observations FROM entities ORDER BY id`).all();
const entityCount = before.length;
const totalChars = before.reduce((n, r) => n + (r.observations?.length ?? 0), 0);
const preEmbeddings = pre.prepare(`SELECT COUNT(*) c FROM entity_embedding_metadata`).get().c;
const preRelations = pre.prepare(`SELECT COUNT(*) c FROM relationships`).get().c;
const preChunks = pre.prepare(`SELECT COUNT(*) c FROM chunk_metadata`).get().c;
// 벡터는 metadata 개수만 세면 "행은 남았는데 벡터가 사라진" 상태를 통과시킨다.
// join 실수와 벡터 본문까지 지문으로 잡는다(advisor beta 발견 5).
const preVectorJoin = pre.prepare(
  `SELECT COUNT(*) c FROM entity_embedding_metadata m
   JOIN entity_embeddings v ON v.rowid = m.rowid`).get().c;
// 실제 바이트를 해시한다. COUNT + SUM(LENGTH) + SUM(rowid) 는 **같은 길이의 다른 벡터**를
// 통과시킨다(advisor beta r3 가 01020304 -> 09090909 로 재현). 지문이 값을 안 보면 지문이 아니다.
const vectorDigest = (d) => {
  const h = createHash('sha256');
  for (const r of d.prepare(
    `SELECT m.entity_id, v.embedding FROM entity_embedding_metadata m
     JOIN entity_embeddings v ON v.rowid = m.rowid ORDER BY m.entity_id`).iterate()) {
    h.update(r.entity_id).update(Buffer.from(r.embedding));
  }
  return h.digest('hex');
};
const preVectorDigest = vectorDigest(pre);
const preHashes = pre.prepare(
  `SELECT entity_id, input_hash FROM entity_embedding_metadata ORDER BY entity_id`).all();
pre.close();
console.log(`  fixture: schema v${preVersion}, ${entityCount} entities, ${totalChars} observation chars`);

process.env.DB_FILE_PATH = work;
const { RAGKnowledgeGraphManager } = await import('../dist/index.js');
const mgr = new RAGKnowledgeGraphManager();
await mgr.initialize({ skipModel: true });
const db = mgr.db;

// 0) 마이그레이션이 실제로 v13 까지 갔다
assert.equal(db.prepare(`SELECT MAX(version) v FROM schema_migrations`).get().v, 13, 'not at v13');

// 1) 전 entity 의 projection 이 원본과 동일하다.
//    두 층으로 본다: 배열 요소가 정확히 같은가(의미) + 원본 raw 문자열과 byte 동일한가.
//    후자는 원본이 JSON.stringify 정규형이 아닐 수 있어 별도로 세고 보고한다 —
//    "byte 동일"이라고 주장하려면 정규화한 쪽과 비교해서는 안 된다(advisor beta 발견 5).
let rawIdentical = 0, normalizedOnly = 0;
for (const r of before) {
  const now = db.prepare(`SELECT observations FROM entities WHERE id=?`).get(r.id).observations;
  const orig = r.observations ?? '[]';
  assert.deepEqual(JSON.parse(now), JSON.parse(orig), `projection content mismatch for ${r.id}`);
  if (now === orig) rawIdentical++;
  else {
    normalizedOnly++;
    assert.equal(now, JSON.stringify(JSON.parse(orig)),
      `projection is neither byte-identical nor the JSON normal form for ${r.id}`);
  }
}
console.log(`  projection: ${rawIdentical} byte-identical to the raw column, ` +
            `${normalizedOnly} equal after JSON normalisation (element-wise deepEqual for all)`);

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
  'entity embedding metadata rows were destroyed by the migration');
// metadata 행 수만으로는 "행은 남고 벡터만 사라진" 상태를 못 잡는다 — join·바이트·hash 로 본다
assert.equal(db.prepare(
  `SELECT COUNT(*) c FROM entity_embedding_metadata m
   JOIN entity_embeddings v ON v.rowid = m.rowid`).get().c, preVectorJoin,
  'a metadata row lost its vector (row survived, embedding did not)');
assert.equal(vectorDigest(db), preVectorDigest,
  'stored embedding bytes changed — the vectors are not the same ones');
assert.deepEqual(db.prepare(
  `SELECT entity_id, input_hash FROM entity_embedding_metadata ORDER BY entity_id`).all(), preHashes,
  'embedding provenance hashes changed, so the backfill will consider vectors stale');
assert.equal(db.prepare(`SELECT COUNT(*) c FROM relationships`).get().c, preRelations, 'relations changed');
assert.equal(db.prepare(`SELECT COUNT(*) c FROM chunk_metadata`).get().c, preChunks, 'chunks changed');

// 5) 검증된 백업이 남아 있다
const baks = readdirSync(dir).filter(f => f.endsWith('.bak'));
assert.equal(baks.length, 1, `expected exactly one backup, got ${JSON.stringify(baks)}`);
const bak = openRo(join(dir, baks[0]));
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
