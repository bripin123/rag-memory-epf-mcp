// 도구 계약: history 창구 + export/import lifecycle 왕복·충돌.
// spec §6.2 · §6.4 · §8.2b (T16 · T17)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const dir = mkdtempSync(join(tmpdir(), 'rag-obs-contract-'));
process.env.DB_FILE_PATH = join(dir, 'test.db');
const { RAGKnowledgeGraphManager } = await import('../dist/index.js');
// 선택자 부재는 동기 throw 다. manager 래퍼는 async 이므로 순수 함수를 직접 부른다.
const { getObservationHistory } = await import('../dist/src/observations/history.js');
const mgr = new RAGKnowledgeGraphManager();
await mgr.initialize({ skipModel: true });
const db = mgr.db;

// 격리된 엔진 인스턴스. DB_FILE_PATH 는 모듈 로드 시점에 읽히므로
// 새 DB 마다 모듈을 새로 import 해야 한다 (migration 테스트와 같은 관례).
let seq = 0;
async function freshManager() {
  const d = mkdtempSync(join(tmpdir(), 'rag-obs-contract-x-'));
  process.env.DB_FILE_PATH = join(d, 'test.db');
  const { RAGKnowledgeGraphManager: M } = await import(`../dist/index.js?v=${seq++}`);
  const m = new M();
  await m.initialize({ skipModel: true });
  return { m, d };
}

// --- getObservationHistory: 항상 roots 배열, 결정론적 정렬, 전 필드 ---
{
  // sources 를 명시로 넘긴다. addRevision 은 출처를 모르면 source 행을 만들지
  // 않으므로(허위 provenance 금지, ADV5) 기본값에 기대면 sources 단정이 무의미해진다.
  await mgr.createEntities([{
    name: 'Hist', entityType: 'CONCEPT', observations: ['h0', 'h1'],
    sources: [{ source_kind: 'document', source_ref: 'doc-hist' }],
  }]);
  const eid = 'entity_hist';
  const o0 = db.prepare(`SELECT observation_id FROM entity_observations
    WHERE entity_id=? AND projection_order=0`).get(eid).observation_id;
  await mgr.correctObservation(o0, 'h0 fixed', 'correction', 'typo');

  const h = await mgr.getObservationHistory({ entity_name: 'Hist' });
  assert.ok(Array.isArray(h.roots), 'history must always return a roots array');
  assert.equal(h.roots.length, 2, 'two roots');
  assert.deepEqual(h.roots.map(r => r.projection_order), [0, 1], 'roots sorted by projection_order');

  const r0 = h.roots[0];
  assert.equal(r0.revisions.length, 2, 'corrected root has 2 revisions');
  assert.deepEqual(r0.revisions.map(v => v.revision_no), [1, 2], 'revisions sorted by revision_no');
  assert.equal(r0.revisions[0].status, 'superseded');
  assert.equal(r0.revisions[1].status, 'active');
  assert.equal(r0.revisions[1].supersedes_id, r0.revisions[0].observation_id);
  for (const k of ['observation_id', 'revision_no', 'content', 'status', 'supersedes_id',
                   'recorded_at', 'superseded_at', 'sources', 'events']) {
    assert.ok(k in r0.revisions[0], `revision field missing: ${k}`);
  }
  assert.ok(r0.revisions[0].sources.length >= 1, 'sources present on the revision that had them');
  assert.ok(r0.revisions.some(v => v.events.some(e => e.event === 'correct')), 'correct event surfaced');

  // 대조군: history 만이 과거 판본을 낸다. 일반 reader 는 active 만 낸다.
  const opened = JSON.stringify(await mgr.openNodes(['Hist']));
  assert.ok(opened.includes('h0 fixed'), 'reader must show the active revision');
  assert.ok(!/\[\d{4}-\d{2}-\d{2}\] h0"/.test(opened), 'reader leaked the superseded revision');

  const one = await mgr.getObservationHistory({ root_id: r0.root_id });
  assert.equal(one.roots.length, 1, 'root_id selector returns exactly one root');
  const byObs = await mgr.getObservationHistory({ observation_id: r0.revisions[0].observation_id });
  assert.equal(byObs.roots.length, 1, 'observation_id selector returns its root');
  assert.equal(byObs.roots[0].root_id, r0.root_id, 'observation_id selector picked the wrong root');
  assert.throws(() => getObservationHistory(db, {}), /requires one of/,
    'no selector must be rejected, not silently return everything');
  console.log('  OK: getObservationHistory');
}

// --- T16: lifecycle round-trip. 2판본 체인 + 복수 source/event + 역순 입력 ---
{
  await mgr.createEntities([{ name: 'RT', entityType: 'CONCEPT', observations: ['rt-v1'] }]);
  const eid = 'entity_rt';
  const o1 = db.prepare(`SELECT observation_id FROM entity_observations WHERE entity_id=?`).get(eid).observation_id;
  await mgr.correctObservation(o1, 'rt-v2', 'correction', 'round trip');
  await mgr.addObservations([{ entityName: 'RT', contents: ['rt-second'],
    sources: [{ source_kind: 'document', source_ref: 'd1' }, { source_kind: 'decision', source_ref: 'D42' }] }]);

  const dump = await mgr.exportGraph();
  for (const k of ['observation_roots', 'entity_observations', 'observation_sources', 'observation_events']) {
    assert.ok(Array.isArray(dump[k]), `T16: export missing ${k}`);
    assert.ok(dump[k].length > 0, `T16: export ${k} empty`);
  }

  // 역순으로 뒤집어 import 해도 성공해야 한다 (importer 가 재정렬한다)
  const reversed = { ...dump, entity_observations: [...dump.entity_observations].reverse() };

  const { m: mgr2, d: dir2 } = await freshManager();
  await mgr2.importGraph(reversed);
  const db2 = mgr2.db;

  const cmp = (t, order) =>
    JSON.stringify(db2.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all()) ===
    JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all());
  assert.ok(cmp('observation_roots', 'root_id'), 'T16: roots differ after round-trip');
  assert.ok(cmp('entity_observations', 'observation_id'), 'T16: revisions differ');
  assert.ok(cmp('observation_sources', 'observation_id, source_kind, source_ref'), 'T16: sources differ');
  assert.ok(cmp('observation_events', 'event_id'), 'T16: events differ');
  // projection 도 재합성돼야 한다 (lifecycle 행만 맞고 배열이 빈 채로 통과하면 안 된다)
  const projRt = db2.prepare(`SELECT observations FROM entities WHERE id='entity_rt'`).get().observations;
  assert.equal(projRt, db.prepare(`SELECT observations FROM entities WHERE id='entity_rt'`).get().observations,
    'T16: projection not rebuilt after import');
  assert.ok(projRt.includes('rt-v2'), 'T16: projection must hold the active revision');

  mgr2.cleanup?.();
  rmSync(dir2, { recursive: true, force: true });
  process.env.DB_FILE_PATH = join(dir, 'test.db');
  console.log('  OK: T16 lifecycle round-trip (reversed input)');
}

// --- T17: 충돌 매개변수화. 비-key 필드를 하나씩 바꿔 abort 를 확인한다. ---
{
  const dump = await mgr.exportGraph();
  const mk = async (mutate) => {
    const { m, d } = await freshManager();
    await m.importGraph(dump);                     // 1차: 정상
    const before = m.db.prepare(`SELECT COUNT(*) c FROM entity_observations`).get().c;
    const beforeEnt = m.db.prepare(`SELECT COUNT(*) c FROM entities`).get().c;
    const mutated = mutate(JSON.parse(JSON.stringify(dump)));
    let threw = null;
    try { await m.importGraph(mutated); } catch (e) { threw = String(e.message); }
    const after = m.db.prepare(`SELECT COUNT(*) c FROM entity_observations`).get().c;
    const afterEnt = m.db.prepare(`SELECT COUNT(*) c FROM entities`).get().c;
    m.cleanup?.(); rmSync(d, { recursive: true, force: true });
    return { threw, mutated0: before === after, entities0: beforeEnt === afterEnt };
  };

  const revFields = ['root_id', 'entity_id', 'revision_no', 'projection_order', 'content',
                     'status', 'supersedes_id', 'recorded_at', 'superseded_at'];
  for (const f of revFields) {
    const r = await mk(d => {
      d.entity_observations[0][f] =
        typeof d.entity_observations[0][f] === 'number' ? 999 : 'MUTATED';
      return d;
    });
    assert.ok(r.threw, `T17: revision field '${f}' mismatch not rejected`);
    assert.match(r.threw, /import conflict|differs/i, `T17: unclear error for '${f}'`);
    assert.ok(r.mutated0, `T17: mutation applied despite abort for '${f}'`);
  }
  for (const f of ['entity_id', 'projection_order', 'created_at']) {
    const r = await mk(d => {
      d.observation_roots[0][f] =
        typeof d.observation_roots[0][f] === 'number' ? 999 : 'MUTATED';
      return d;
    });
    assert.ok(r.threw, `T17: root field '${f}' mismatch not rejected`);
    assert.match(r.threw, /import conflict|differs/i, `T17: unclear error for root '${f}'`);
  }
  // 동일 = skip
  const same = await mk(d => d);
  assert.ok(!same.threw, `T17: identical re-import must skip, not abort (${same.threw})`);

  // --- T17b: abort 는 0 mutation 이다. entity 삽입도 같은 트랜잭션 안이어야 한다. ---
  // 이 대조군이 없으면 "lifecycle 행만 롤백되고 새 entity·document 는 남는" 구현이
  // T17 을 전부 통과한다 (revision count 만 재기 때문).
  const ghost = await mk(d => {
    d.entities.push({ id: 'entity_ghost_t17b', name: 'GhostT17b',
                      entityType: 'CONCEPT', observations: [], metadata: {} });
    d.entity_observations[0].content = 'MUTATED';
    return d;
  });
  assert.ok(ghost.threw, 'T17b: conflicting import did not abort');
  assert.ok(ghost.mutated0, 'T17b: revisions changed despite abort');
  assert.ok(ghost.entities0,
    'T17b: a new entity survived an aborted import — entity insertion is outside the transaction');

  process.env.DB_FILE_PATH = join(dir, 'test.db');
  console.log('  OK: T17 import conflict parameterized (+T17b whole-import atomicity)');
}

mgr.cleanup?.();
rmSync(dir, { recursive: true, force: true });
console.log('observation-contracts: ALL OK');
