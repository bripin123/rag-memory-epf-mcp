import type Database from 'better-sqlite3';

// active 행을 projection_order 순으로 모아 entities.observations 를 재작성한다.
// 단계 1 에서는 이 배열이 여전히 FTS/벡터의 입력이다 — 그래서 projection 갱신만으로
// 기존 entity FTS 트리거와 벡터 무효화가 따라온다(spec §4.5).
export function rebuildProjection(db: Database.Database, entityId: string): void {
  const rows = db.prepare(
    `SELECT content FROM entity_observations
     WHERE entity_id = ? AND status = 'active'
     ORDER BY projection_order`
  ).all(entityId) as Array<{ content: string }>;
  db.prepare(`UPDATE entities SET observations = ? WHERE id = ?`)
    .run(JSON.stringify(rows.map(r => r.content)), entityId);
}

// D4: observation 이 바뀌면 그 entity 를 가리키는 KG chunk 는 stale 이다.
// 단계 1 에서는 재생성하지 않고 fail-closed 로 제거한다 — 낡은 텍스트가
// hybridSearch 에 남아 있는 것이 없는 것보다 나쁘다.
//
// KG chunk 의 식별자는 document_id 가 아니라 (chunk_type, entity_id) 다:
// generateKnowledgeGraphChunks() 는 document_id 를 넣지 않는다.
//
// 이 경로는 현재 dormant 다 — generateKnowledgeGraphChunks/embedKnowledgeGraphChunks
// 는 MCP 도구로 노출되지 않고 내부 호출 지점도 없으며, 실사용 DB 의 chunk 는 전부
// chunk_type='document' 였다. 그래서 이것은 미래·타 배포 대비 방어층이고,
// 테스트는 KG chunk 를 직접 심어서 검증한다(자연 발생하지 않는다).
export function deleteStaleKgChunks(db: Database.Database, entityId: string): number {
  const chunks = db.prepare(
    `SELECT rowid FROM chunk_metadata WHERE chunk_type = 'entity' AND entity_id = ?`
  ).all(entityId) as Array<{ rowid: number }>;
  let n = 0;
  for (const c of chunks) {
    db.exec(`DELETE FROM chunks WHERE rowid = ${Number(c.rowid)}`);
    db.prepare(`DELETE FROM chunk_metadata WHERE rowid = ?`).run(c.rowid);
    n++;
  }
  return n;
}
