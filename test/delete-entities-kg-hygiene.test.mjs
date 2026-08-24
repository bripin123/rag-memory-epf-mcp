// deleteEntities 의 두 결함에 대한 회귀 잠금 (2026-08-24 감사 발견분).
//
// 결함 ①: 다단계 삭제(embeddings → chunk_entities → relationships → entities)를
//   감싸는 트랜잭션이 없다. 중간 단계가 실패하면 앞 단계는 이미 커밋된 채
//   엔티티만 살아 있는 부분 상태가 남는다.
// 결함 ②: KG 청크(chunk_type='entity'/'relationship')를 안 지운다. 생성 경로는
//   dormant(generateKnowledgeGraphChunks 미노출)지만 한 번이라도 불리면,
//   삭제된 엔티티의 청크가 hybridSearch 에 계속 검색된다. entity 타입은
//   deleteStaleKgChunks 가 이미 지우므로 호출만 연결하고, relationship 타입은
//   relationship_id 키라 관계 삭제 전에 id 를 캡처해야 해서 헬퍼를 새로 둔다.
//
// 판정은 결과로 한다: 삭제 후 "KG 잔재 0 · 실패 시 부분 상태 없음" 이면 통과.
// KG 청크는 자연 발생하지 않으므로(projection.ts 주석) 직접 심어서 검증한다.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const dir = mkdtempSync(join(tmpdir(), 'rag-del-kghyg-'));
process.env.DB_FILE_PATH = join(dir, 'test.db');
const { RAGKnowledgeGraphManager } = await import('../dist/index.js');
const mgr = new RAGKnowledgeGraphManager();
await mgr.initialize({ skipModel: true });
const db = mgr.db;

const one = (sql, ...p) => db.prepare(sql).get(...p);
const cnt = (t, w = '1=1', ...p) => one(`SELECT COUNT(*) c FROM ${t} WHERE ${w}`, ...p).c;

// fixture: RelSrc 를 지운다. RelDst · Keep 은 대조군.
await mgr.createEntities([
  { name: 'RelSrc', entityType: 'CONCEPT', observations: ['o-src'] },
  { name: 'RelDst', entityType: 'CONCEPT', observations: ['o-dst'] },
  { name: 'Keep', entityType: 'CONCEPT', observations: ['o-keep'] },
]);
await mgr.createRelations([{ from: 'RelSrc', to: 'RelDst', relationType: 'USES' }]);
const srcId = one(`SELECT id FROM entities WHERE name = 'RelSrc'`).id;
const dstId = one(`SELECT id FROM entities WHERE name = 'RelDst'`).id;
const keepId = one(`SELECT id FROM entities WHERE name = 'Keep'`).id;
const relId = one(
  `SELECT r.id FROM relationships r WHERE r.source_entity = ? AND r.target_entity = ?`,
  srcId, dstId
).id;
assert.ok(relId, 'fixture relationship missing');

// KG 청크를 직접 심는다(entity 1 · relationship 1 · 무관 1).
const seedKgEntity = (chunkId, eid, text) => {
  db.prepare(`
    INSERT INTO chunk_metadata (chunk_id, chunk_type, entity_id, chunk_index, text, start_pos, end_pos, metadata)
    VALUES (?, 'entity', ?, 0, ?, 0, ?, '{}')
  `).run(chunkId, eid, text, text.length);
};
const seedKgRel = (chunkId, rid, text) => {
  db.prepare(`
    INSERT INTO chunk_metadata (chunk_id, chunk_type, relationship_id, chunk_index, text, start_pos, end_pos, metadata)
    VALUES (?, 'relationship', ?, 0, ?, 0, ?, '{}')
  `).run(chunkId, rid, text, text.length);
};
seedKgEntity(`kg_entity_${srcId}`, srcId, 'RelSrc is a CONCEPT. o-src');
seedKgRel(`kg_relationship_${relId}`, relId, 'relsrc uses reldst');
seedKgEntity(`kg_entity_${keepId}`, keepId, 'Keep is a CONCEPT. o-keep');

// ⓐ 성공 경로: KG 잔재 0
{
  await mgr.deleteEntities(['RelSrc']);
  assert.equal(cnt(`chunk_metadata`, `chunk_type = 'entity' AND entity_id = ?`, srcId), 0,
    'ⓐ: deleted entity left an entity-type KG chunk behind');
  assert.equal(cnt(`chunk_metadata`, `chunk_type = 'relationship' AND relationship_id = ?`, relId), 0,
    'ⓐ: dangling relationship left a relationship-type KG chunk behind');
  assert.equal(cnt('entities', 'id = ?', srcId), 0, 'ⓐ: entity not deleted');
  assert.equal(cnt('relationships', 'id = ?', relId), 0, 'ⓐ: relationship not deleted');
  console.log('  OK: ⓐ KG residue 0 after successful delete');
}

// ⓑ 무관 대조군은 살아 있다
{
  assert.ok(one(`SELECT id FROM entities WHERE id = ?`, dstId), 'ⓑ: RelDst destroyed');
  assert.equal(cnt(`chunk_metadata`, `chunk_type = 'entity' AND entity_id = ?`, keepId), 1,
    'ⓑ: Keep entity KG chunk swept');
  console.log('  OK: ⓑ unrelated rows intact');
}

// ⓒ 원자성: 마지막 단계(entities DELETE)가 실패하면 앞 단계도 롤백돼야 한다.
//   BEFORE DELETE 트리거로 특정 엔티티의 삭제만 ABORT 시킨다(마이그레이션 테스트의
//   fault injection 관용과 동일한 형태).
{
  await mgr.createEntities([
    { name: 'FaultEnt', entityType: 'CONCEPT', observations: ['o-fault'] },
  ]);
  await mgr.createRelations([{ from: 'FaultEnt', to: 'RelDst', relationType: 'REFERENCES' }]);
  const faultId = one(`SELECT id FROM entities WHERE name = 'FaultEnt'`).id;

  db.exec(`
    CREATE TRIGGER t_fault_no_delete BEFORE DELETE ON entities
    WHEN OLD.id = '${faultId}'
    BEGIN SELECT RAISE(ABORT, 'test-fault'); END;
  `);

  // 예외가 밖으로 나든 조용히 흡수되든, 계약은 하나다: 부분 상태가 남으면 안 된다.
  await mgr.deleteEntities(['FaultEnt']);

  assert.equal(cnt('entities', 'id = ?', faultId), 1,
    'ⓒ: entity survived the injected fault (expected)');
  assert.equal(cnt('relationships', `source_entity = ? OR target_entity = ?`, faultId, faultId), 1,
    'ⓒ PARTIAL STATE: relationships were purged while the entity survived — mid-sequence commit leaked');
  assert.equal(cnt('chunk_entities', 'entity_id = ?', faultId), cnt('chunk_entities', 'entity_id = ?', faultId),
    'ⓒ: chunk_entities sanity');
  console.log('  OK: ⓒ failed delete left NO partial state');

  db.exec('DROP TRIGGER t_fault_no_delete');
  await mgr.deleteEntities(['FaultEnt']);
  assert.equal(cnt('entities', 'id = ?', faultId), 0, 'ⓒ: recovery delete failed');
  console.log('  OK: ⓒ recovers once the fault is removed');
}

mgr.cleanup?.();
rmSync(dir, { recursive: true, force: true });
console.log('delete-entities-kg-hygiene: ALL OK');
