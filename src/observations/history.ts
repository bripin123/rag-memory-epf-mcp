import type Database from 'better-sqlite3';

// spec §6.2: history 의 유일한 창구.
// 응답은 항상 roots 배열이다 (entity_name 이면 N개, root_id/observation_id 면 1개).
// 단일 객체로 두면 entity_name 선택자와 cardinality 가 모순된다.
export function getObservationHistory(db: Database.Database, sel: {
  entity_name?: string; observation_id?: string; root_id?: string;
}): { roots: any[] } {
  // 정확히 하나만 받는다. 우선순위를 조용히 적용하면 두 개를 넘긴 호출자가
  // *다른* 선택자의 답을 받고 그 사실을 모른다 — 실측으로 entity_name 이 유효한데
  // 존재하지 않는 root_id 가 이겨서 `{roots: []}` 가 나갔다(advisor beta 발견 4-2).
  const given = (['entity_name', 'observation_id', 'root_id'] as const)
    .filter(k => sel[k] !== undefined && sel[k] !== null && sel[k] !== '');
  if (given.length === 0) {
    throw new Error('getObservationHistory requires one of: entity_name, observation_id, root_id');
  }
  if (given.length > 1) {
    throw new Error(
      `getObservationHistory takes exactly one selector, got ${given.length} (${given.join(', ')}). ` +
      `Applying a precedence order would silently answer a different question than the one asked.`);
  }

  let rootIds: string[];
  if (sel.root_id) {
    rootIds = [sel.root_id];
  } else if (sel.observation_id) {
    const r = db.prepare(`SELECT root_id FROM entity_observations WHERE observation_id = ?`)
      .get(sel.observation_id) as { root_id: string } | undefined;
    rootIds = r ? [r.root_id] : [];
  } else if (sel.entity_name) {
    const entityId = `entity_${sel.entity_name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;
    rootIds = (db.prepare(`SELECT root_id FROM observation_roots
                           WHERE entity_id = ? ORDER BY projection_order`)
      .all(entityId) as Array<{ root_id: string }>).map(r => r.root_id);
  } else {
    throw new Error('getObservationHistory requires one of: entity_name, observation_id, root_id');
  }

  const roots = rootIds.map(rid => {
    const root = db.prepare(`SELECT * FROM observation_roots WHERE root_id = ?`).get(rid) as any;
    if (!root) return null;
    const revs = db.prepare(
      `SELECT * FROM entity_observations WHERE root_id = ? ORDER BY revision_no`
    ).all(rid) as any[];
    // 정렬 = recorded_at, 동시각이면 event_id 사전순 (결정론)
    const events = db.prepare(
      `SELECT * FROM observation_events WHERE root_id = ? ORDER BY recorded_at, event_id`
    ).all(rid) as any[];
    return {
      root_id: root.root_id,
      entity_id: root.entity_id,
      projection_order: root.projection_order,
      revisions: revs.map(v => ({
        observation_id: v.observation_id,
        revision_no: v.revision_no,
        content: v.content,
        status: v.status,
        supersedes_id: v.supersedes_id,
        recorded_at: v.recorded_at,
        superseded_at: v.superseded_at,
        sources: db.prepare(`SELECT source_kind, source_ref, source_hash, recorded_at
                             FROM observation_sources WHERE observation_id = ?
                             ORDER BY recorded_at, source_kind, source_ref`).all(v.observation_id),
        // 이 revision 을 from/to 로 지목한 event 만
        events: events.filter(e => e.from_id === v.observation_id || e.to_id === v.observation_id),
      })),
    };
  }).filter(Boolean) as any[];

  roots.sort((a, b) => a.projection_order - b.projection_order);
  return { roots };
}
