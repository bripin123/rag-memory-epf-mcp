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

  // hybridSearch 도 포함한다. 관찰이 chunk 검색에 닿는 경로(KG chunk)는 dormant 라
  // 자연 발생하지 않지만, generateKnowledgeGraphChunks() 를 명시로 부르면 정상
  // positive control 이 만들어진다. 처음에는 "entity chunk 가 0이니 경계 밖"이라고
  // 적었는데 그건 실패하는 대조군을 경계로 재정의한 것이었다 — advisor 가 같은
  // 방법으로 positive control 을 만들어 반박했다(beta 자기의심 4 = "더 나쁘다").
  await mgr.generateKnowledgeGraphChunks();
  const kgChunks = db.prepare(
    `SELECT COUNT(*) c FROM chunk_metadata WHERE chunk_type='entity' AND entity_id=?`).get(eid).c;
  assert.ok(kgChunks > 0, 'T7: no entity chunk was generated — hybridSearch oracle would be vacuous');

  const modes = {
    openNodes:    () => mgr.openNodes(['T7']),
    searchNodes:  () => mgr.searchNodes(SENTINEL, 5),
    readGraph:    () => mgr.readGraph(),
    getNeighbors: () => mgr.getNeighbors(['T7'], 1),
    hybridSearch: () => mgr.hybridSearch(SENTINEL, 5, false),
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
  // stale KG chunk 가 물리적으로 제거됐는지도 확인한다 (payload 부재만으로는
  // "검색이 안 걸렸을 뿐"인 경우와 구분되지 않는다)
  assert.equal(db.prepare(
    `SELECT COUNT(*) c FROM chunk_metadata WHERE text LIKE '%'||?||'%'`).get(SENTINEL).c, 0,
    'T7: a KG chunk still holds the retracted text');
  console.log('  OK: T7 active-only across 5 reader modes (KG chunk positive control)');
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
