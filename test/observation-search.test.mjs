// reader active-only + dedup 이 evidence 를 더한다. spec §8.3 (T7 · T13)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const dir = mkdtempSync(join(tmpdir(), 'rag-obs-search-'));
process.env.DB_FILE_PATH = join(dir, 'test.db');
const { RAGKnowledgeGraphManager } = await import('../dist/index.js');
const mgr = new RAGKnowledgeGraphManager();
await mgr.initialize({ skipModel: true });
const db = mgr.db;

// --- T7: retract 후 모든 reader 모드에서 stale sentinel 이 사라진다 ---
{
  const SENTINEL = 'zzsentinelzz-unique-token-7';
  await mgr.createEntities([{ name: 'T7', entityType: 'CONCEPT',
                             observations: [`fact with ${SENTINEL}`] }]);
  const eid = 'entity_t7';
  const oid = db.prepare(`SELECT observation_id FROM entity_observations WHERE entity_id=?`)
    .get(eid).observation_id;

  const has = (payload) => JSON.stringify(payload).includes(SENTINEL);

  const modes = {
    openNodes:    () => mgr.openNodes(['T7']),
    searchNodes:  () => mgr.searchNodes(SENTINEL, 5),
    readGraph:    () => mgr.readGraph(),
    getNeighbors: () => mgr.getNeighbors(['T7'], 1),
  };

  // positive control — retract 전에는 각 모드가 실제로 sentinel 을 낸다.
  // 이게 없으면 "부재로 통과"하는 오라클이 된다.
  for (const [name, fn] of Object.entries(modes)) {
    assert.ok(has(await fn()), `T7 positive control failed for ${name} — the oracle proves nothing`);
  }

  await mgr.retractObservation(oid, 'stale');

  for (const [name, fn] of Object.entries(modes)) {
    assert.ok(!has(await fn()), `T7: ${name} still returns the retracted observation`);
  }
  // entity 자체는 남아 있어야 한다 (부재로 통과하면 안 된다)
  assert.ok(JSON.stringify(await mgr.openNodes(['T7'])).includes('T7'),
    'T7: entity vanished — oracle invalid');
  // 그리고 history 에서는 여전히 보인다 = 지운 것이 아니라 상태가 바뀐 것
  const h = await mgr.getObservationHistory({ observation_id: oid });
  assert.equal(h.roots[0].revisions[0].status, 'retracted', 'T7: revision must survive as retracted');
  assert.ok(h.roots[0].revisions[0].content.includes(SENTINEL),
    'T7: retract must not destroy the content — history is the only surface for it');
  // hybridSearch 는 단계 1 에서 관찰 reader 가 아니다 — 조용히 빼지 않고 경계를 고정한다.
  // 관찰이 chunk 검색에 닿는 유일한 경로는 generateKnowledgeGraphChunks 이고, 그것은
  // MCP 도구로도 내부 호출로도 노출돼 있지 않다(dormant). 그래서 sentinel 은 retract
  // 전에도 안 나온다 = 누출 가능성 자체가 없다. 단계 2 에서 관찰 단위 색인을 붙이면
  // 이 블록이 실패해야 하고, 그때 T7 의 모드 목록에 hybridSearch 를 넣어야 한다.
  {
    const entityChunks = db.prepare(
      `SELECT COUNT(*) c FROM chunk_metadata WHERE chunk_type='entity'`).get().c;
    assert.equal(entityChunks, 0,
      'stage-1 boundary broken: entity chunks exist, so hybridSearch must join the T7 sweep');
    const hs = await mgr.hybridSearch(SENTINEL, 5, false);
    assert.ok(!JSON.stringify(hs).includes(SENTINEL),
      'hybridSearch surfaced an observation without an entity chunk — the boundary is wrong');
  }
  console.log('  OK: T7 active-only across reader modes (+hybridSearch stage-1 boundary)');
}

// --- T13: 같은 content 가 다른 source 로 재등장하면 source link 만 늘어난다 ---
{
  await mgr.createEntities([{ name: 'T13', entityType: 'CONCEPT', observations: [] }]);
  const a = await mgr.addObservations([{ entityName: 'T13', contents: ['same fact'],
    sources: [{ source_kind: 'document', source_ref: 'doc-A' }] }]);
  const revs1 = db.prepare(`SELECT COUNT(*) c FROM entity_observations WHERE entity_id='entity_t13'`).get().c;
  assert.equal(revs1, 1, 'T13: first add must create exactly one revision');

  const b = await mgr.addObservations([{ entityName: 'T13', contents: ['same fact'],
    sources: [{ source_kind: 'document', source_ref: 'doc-B' }] }]);
  const revs2 = db.prepare(`SELECT COUNT(*) c FROM entity_observations WHERE entity_id='entity_t13'`).get().c;
  assert.equal(revs2, revs1, 'T13: dedup must not create a new revision');
  assert.equal(b[0].observation_ids[0], null, 'T13: dedup must report null, not the existing id');

  const oid = a[0].observation_ids[0];
  const srcs = db.prepare(`SELECT COUNT(*) c FROM observation_sources WHERE observation_id=?`).get(oid).c;
  assert.equal(srcs, 2, 'T13: second source not linked to the existing revision');

  // 같은 출처를 또 보내면 늘지 않는다 (INSERT OR IGNORE = idempotent)
  await mgr.addObservations([{ entityName: 'T13', contents: ['same fact'],
    sources: [{ source_kind: 'document', source_ref: 'doc-B' }] }]);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM observation_sources WHERE observation_id=?`).get(oid).c, 2,
    'T13: repeating the same source must be idempotent');
  // projection 은 1개다 (evidence 가 늘어도 배열은 안 늘어난다)
  assert.equal(
    JSON.parse(db.prepare(`SELECT observations FROM entities WHERE id='entity_t13'`).get().observations).length, 1,
    'T13: projection grew on a dedup');
  console.log('  OK: T13 same content, new source');
}

mgr.cleanup?.();
rmSync(dir, { recursive: true, force: true });
console.log('observation-search: ALL OK');
