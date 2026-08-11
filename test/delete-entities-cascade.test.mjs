// deleteEntities(도구 경로) 가 observation 계열을 남기지 않는가. advisor 종결 조건 [1r]① (T26)
//
// 왜 별도 파일인가: observation-cascade.test.mjs 는 **의도적으로 raw DELETE** 를 쓴다
// ("수동 child 삭제가 FK 누락을 가리지 못하게", 그 파일 58행). 그래서 스키마 FK 는 검증되지만
// **실제 호출 경로인 deleteEntities 는 한 번도 지나가지 않는다.** 2026-08-11 advisor 가 지목한
// 자리가 여기다 — hub DB 에서 foreign_key_check 위반 72건이 관찰됐고, 그때 낸 처방은
// "hub DB 청소"였을 뿐 제품 경계(엔진)에는 회귀 잠금이 없었다.
//
// 판정은 **결과로** 낸다: 구현이 자식을 명시적으로 지우든 FK CASCADE 에 맡기든 상관없이
// "삭제 후 고아 0 · foreign_key_check 0" 이면 통과다. 형태를 열거하지 않는다.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const dir = mkdtempSync(join(tmpdir(), 'rag-del-casc-'));
process.env.DB_FILE_PATH = join(dir, 'test.db');
const { RAGKnowledgeGraphManager } = await import('../dist/index.js');
const mgr = new RAGKnowledgeGraphManager();
await mgr.initialize({ skipModel: true });
const db = mgr.db;

const one = (sql, ...p) => db.prepare(sql).get(...p);
const cnt = (t, w = '1=1', ...p) => one(`SELECT COUNT(*) c FROM ${t} WHERE ${w}`, ...p).c;
const orphanSources = () => one(`SELECT COUNT(*) c FROM observation_sources s
  LEFT JOIN entity_observations o USING(observation_id) WHERE o.observation_id IS NULL`).c;
const orphanEvents = () => one(`SELECT COUNT(*) c FROM observation_events e
  LEFT JOIN observation_roots r USING(root_id) WHERE r.root_id IS NULL`).c;
const orphanRoots = () => one(`SELECT COUNT(*) c FROM observation_roots r
  LEFT JOIN entities e ON e.id = r.entity_id WHERE e.id IS NULL`).c;
const orphanRevisions = () => one(`SELECT COUNT(*) c FROM entity_observations o
  LEFT JOIN entities e ON e.id = o.entity_id WHERE e.id IS NULL`).c;
const fkViolations = () => db.pragma('foreign_key_check').length;

// ASCII 이름과 **한글·공백이 섞인 이름** 둘 다 돈다. deleteEntities 는 id 를 조회하지 않고
// 이름에서 **다시 계산**하므로(index.ts `entity_${slug}`), 슬러그 경로가 갈리면
// "not found, skipping" 으로 **조용히 아무것도 안 지운다**. 그 자리를 실제로 밟는다.
const CASES = [
  { name: 'DelCasc', label: 'ascii' },
  { name: '한글 엔티티 (세션17)', label: 'korean+space+paren' },
];

for (const { name, label } of CASES) {
  await mgr.createEntities([{
    name, entityType: 'CONCEPT',
    observations: ['o1', 'o2'],
    sources: [{ source_kind: 'document', source_ref: `doc-${label}` }],
  }]);
}
// 무관 fixture — 삭제가 남의 행까지 쓸어가지 않는지 대조군
await mgr.createEntities([{
  name: 'DelKeep', entityType: 'CONCEPT', observations: ['k1'],
  sources: [{ source_kind: 'document', source_ref: 'keep-doc' }],
}]);

for (const { name, label } of CASES) {
  const row = one(`SELECT id FROM entities WHERE name = ?`, name);
  assert.ok(row, `T26[${label}]: fixture entity missing`);
  const eid = row.id;

  // 사전 상태: 자식이 실제로 있어야 한다 (부재로 통과하는 공허한 검사 방지)
  const srcOf = one(`SELECT COUNT(*) c FROM observation_sources s
    JOIN entity_observations o USING(observation_id) WHERE o.entity_id = ?`, eid).c;
  assert.ok(cnt('observation_roots', 'entity_id = ?', eid) > 0, `T26[${label}]: roots empty before`);
  assert.ok(cnt('entity_observations', 'entity_id = ?', eid) > 0, `T26[${label}]: revisions empty before`);
  assert.ok(srcOf > 0, `T26[${label}]: sources empty before`);

  // --- 도구 경로 ---
  await mgr.deleteEntities([name]);

  // ⓐ entity 가 실제로 사라졌는가 (슬러그 불일치로 조용히 skip 되면 여기서 잡힌다)
  assert.equal(cnt('entities', 'id = ?', eid), 0, `T26[${label}]ⓐ: entity survived deleteEntities`);
  // ⓑ observation 계열 잔여 0
  assert.equal(cnt('observation_roots', 'entity_id = ?', eid), 0, `T26[${label}]ⓑ: roots left`);
  assert.equal(cnt('entity_observations', 'entity_id = ?', eid), 0, `T26[${label}]ⓑ: revisions left`);
  // ⓒ 고아 0 (결과 측정 — 구현 형태를 묻지 않는다)
  assert.equal(orphanRoots(), 0, `T26[${label}]ⓒ: orphan roots`);
  assert.equal(orphanRevisions(), 0, `T26[${label}]ⓒ: orphan revisions`);
  assert.equal(orphanSources(), 0, `T26[${label}]ⓒ: orphan sources`);
  assert.equal(orphanEvents(), 0, `T26[${label}]ⓒ: orphan events`);
  // ⓓ 엔진이 스스로 재는 무결성
  assert.equal(fkViolations(), 0, `T26[${label}]ⓓ: foreign_key_check violations`);
  console.log(`  OK: T26 deleteEntities cascade [${label}]`);
}

// ⓔ 무관 엔티티는 살아 있다
{
  const keep = one(`SELECT id FROM entities WHERE name = 'DelKeep'`);
  assert.ok(keep, 'T26ⓔ: unrelated entity destroyed');
  assert.ok(cnt('observation_roots', 'entity_id = ?', keep.id) > 0, 'T26ⓔ: unrelated roots destroyed');
  assert.ok(cnt('entity_observations', 'entity_id = ?', keep.id) > 0, 'T26ⓔ: unrelated revisions destroyed');
  console.log('  OK: T26ⓔ unrelated rows intact');
}

mgr.cleanup?.();
rmSync(dir, { recursive: true, force: true });
console.log('delete-entities-cascade: ALL OK');
