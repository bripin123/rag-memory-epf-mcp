import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type ObsStatus = 'active' | 'superseded' | 'retracted' | 'provisional';
export type ObsEvent = 'add' | 'correct' | 'retract' | 'restore' | 'approve' | 'decline' | 'import';
export type SourceInput = {
  source_kind: 'document' | 'conversation' | 'decision' | 'import';
  source_ref: string;
  source_hash?: string | null;
};

// 순번 정본은 observation_roots 다. entity_observations 로 세면 revision 이
// purge 된 root 의 순번을 재사용해 이후 restore/approve 가 UNIQUE 로 실패한다.
export function nextProjectionOrder(db: Database.Database, entityId: string): number {
  const r = db.prepare(
    `SELECT COALESCE(MAX(projection_order), -1) + 1 AS n FROM observation_roots WHERE entity_id = ?`
  ).get(entityId) as { n: number };
  return r.n;
}

export function recordEvent(db: Database.Database, a: {
  rootId: string; event: ObsEvent;
  fromId?: string | null; toId?: string | null;
  changeKind?: 'correction' | 'world_change' | 'retraction' | null;
  reason?: string | null; actor?: string | null; batchId?: string | null; ts: string;
}): void {
  db.prepare(`INSERT INTO observation_events
    (event_id, root_id, from_id, to_id, event, change_kind, reason, actor, batch_id, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), a.rootId, a.fromId ?? null, a.toId ?? null, a.event,
         a.changeKind ?? null, a.reason ?? null, a.actor ?? null, a.batchId ?? null, a.ts);
}

// 한 관찰에 evidence 를 더한다. 같은 사실이 다른 출처에서 다시 오면
// 새 revision 이 아니라 source link 가 늘어난다(spec §8.3 T13).
export function linkSources(db: Database.Database, observationId: string,
                           sources: SourceInput[], ts: string): number {
  let n = 0;
  for (const s of sources) {
    n += db.prepare(`INSERT OR IGNORE INTO observation_sources
      (observation_id, source_kind, source_ref, source_hash, recorded_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(observationId, s.source_kind, s.source_ref, s.source_hash ?? null, ts).changes;
  }
  return n;
}

// 새 논리 관찰 = root 1 + rev1 1 + sources N + add event 1.
export function addRevision(db: Database.Database, a: {
  entityId: string; content: string;
  status: Extract<ObsStatus, 'active' | 'provisional'>;
  sources?: SourceInput[]; actor?: string | null; ts: string;
}): string {
  const rootId = randomUUID();
  const obsId = randomUUID();
  const order = nextProjectionOrder(db, a.entityId);
  db.prepare(`INSERT INTO observation_roots (root_id, entity_id, projection_order, created_at)
              VALUES (?, ?, ?, ?)`).run(rootId, a.entityId, order, a.ts);
  db.prepare(`INSERT INTO entity_observations
    (observation_id, root_id, entity_id, revision_no, projection_order,
     content, status, supersedes_id, recorded_at, superseded_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, NULL, ?, NULL)`)
    .run(obsId, rootId, a.entityId, order, a.content, a.status, a.ts);

  // 출처를 모르면 source 행을 만들지 않는다.
  // source_ref 가 NOT NULL 인 것은 "행을 반드시 만들라"는 뜻이 아니다.
  // sources 가 생략됐는데 conversation/unspecified 를 넣으면 "대화에서 왔다"는
  // 사실을 발명하는 것이고, provenance 의 목적과 정반대다
  // (advisor 구현리뷰 r1 발견 5). unknown 은 0행으로 표현한다.
  if (a.sources?.length) linkSources(db, obsId, a.sources, a.ts);

  recordEvent(db, { rootId, event: 'add', toId: obsId, actor: a.actor ?? null, ts: a.ts });
  return obsId;
}

// §4.4 복합 전이: ①구 active -> superseded ②신규 revision -> active ③correct event.
// 셋이 한 트랜잭션 안에서 일어나야 한다 — 호출자가 mutateEntityAndInvalidate 로 감싼다.
export function correctRevision(db: Database.Database, a: {
  observationId: string; content: string;
  changeKind: 'correction' | 'world_change';
  reason?: string | null; actor?: string | null; ts: string;
}): string {
  const cur = db.prepare(
    `SELECT observation_id, root_id, entity_id, revision_no, projection_order, status
     FROM entity_observations WHERE observation_id = ?`
  ).get(a.observationId) as {
    observation_id: string; root_id: string; entity_id: string;
    revision_no: number; projection_order: number; status: ObsStatus;
  } | undefined;

  if (!cur) throw new Error(`observation ${a.observationId} not found`);
  if (cur.status !== 'active')
    throw new Error(`cannot correct an observation in status '${cur.status}' — only 'active' (spec §4.4)`);

  const newId = randomUUID();
  // ① 구 행을 먼저 superseded 로. active-per-root 부분 UNIQUE 때문에 순서가 계약이다.
  db.prepare(`UPDATE entity_observations SET status='superseded', superseded_at=? WHERE observation_id=?`)
    .run(a.ts, cur.observation_id);
  // ② 신규 revision. projection_order 는 전임자 상속 = 배열 위치가 움직이지 않는다.
  db.prepare(`INSERT INTO entity_observations
    (observation_id, root_id, entity_id, revision_no, projection_order,
     content, status, supersedes_id, recorded_at, superseded_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`)
    .run(newId, cur.root_id, cur.entity_id, cur.revision_no + 1, cur.projection_order,
         a.content, cur.observation_id, a.ts);
  // ③ event
  recordEvent(db, { rootId: cur.root_id, event: 'correct', fromId: cur.observation_id,
                    toId: newId, changeKind: a.changeKind, reason: a.reason ?? null,
                    actor: a.actor ?? null, ts: a.ts });
  return newId;
}

// §4.4 전이 표를 코드로. 표에 없는 조합은 거부한다 — 'superseded' 는 종착이다.
const ALLOWED: Record<ObsStatus, Array<{ to: ObsStatus; event: 'retract' | 'restore' | 'approve' | 'decline' }>> = {
  active:      [{ to: 'retracted', event: 'retract' }],
  retracted:   [{ to: 'active',    event: 'restore' }],
  provisional: [{ to: 'active',    event: 'approve' },
                { to: 'retracted', event: 'decline' }],
  superseded:  [],
};

export function transitionStatus(db: Database.Database, a: {
  observationId: string; event: 'retract' | 'restore' | 'approve' | 'decline';
  reason?: string | null; actor?: string | null; ts: string;
}): void {
  const cur = db.prepare(
    `SELECT observation_id, root_id, entity_id, status FROM entity_observations WHERE observation_id = ?`
  ).get(a.observationId) as { observation_id: string; root_id: string;
                              entity_id: string; status: ObsStatus } | undefined;
  if (!cur) throw new Error(`observation ${a.observationId} not found`);

  const allowed = (ALLOWED[cur.status] ?? []).find(x => x.event === a.event);
  if (!allowed) {
    throw new Error(
      `illegal transition: '${a.event}' from status '${cur.status}' is not in the §4.4 table` +
      (cur.status === 'superseded'
        ? " — 'superseded' is terminal; create a new revision instead"
        : ''));
  }

  db.prepare(`UPDATE entity_observations SET status = ? WHERE observation_id = ?`)
    .run(allowed.to, cur.observation_id);
  recordEvent(db, { rootId: cur.root_id, event: a.event, fromId: cur.observation_id,
                    toId: cur.observation_id, reason: a.reason ?? null,
                    actor: a.actor ?? null, ts: a.ts });
}
