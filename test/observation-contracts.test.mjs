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

// --- MCP 왕복: validateToolArgs -> dispatch -> manager 가 lifecycle 을 보존하는가 ---
// 위의 T16/T17 은 manager.importGraph() 를 직접 부르므로 MCP 검증 층을 우회한다.
// 그 사각에서 실제 P0 이 살아 있었다: importGraph 스키마에 lifecycle 4배열이 없어
// z.object().parse() 가 조용히 버리고, 완전한 dump 가 legacy 관찰로 재생성됐다
// (advisor beta 발견 1). 이제 검증 층을 통과시켜 대조한다.
{
  const { validateToolArgs } = await import('../dist/src/tools/tool-registry.js');

  const dump = await mgr.exportGraph();
  const validated = validateToolArgs('importGraph', { data: dump, merge: true });
  for (const k of ['observation_roots', 'entity_observations', 'observation_sources', 'observation_events']) {
    assert.ok(Array.isArray(validated.data[k]),
      `MCP validation dropped ${k} — a full dump cannot survive the tool boundary`);
    assert.equal(validated.data[k].length, dump[k].length, `MCP validation truncated ${k}`);
  }

  // 그리고 그 검증된 인자로 실제 import 하면 history 가 남는가
  const { m: m2, d: d2 } = await freshManager();
  await m2.importGraph(validated.data, { merge: validated.merge !== false });
  const revs = m2.db.prepare(`SELECT COUNT(*) c FROM entity_observations`).get().c;
  const supers = m2.db.prepare(`SELECT COUNT(*) c FROM entity_observations WHERE status='superseded'`).get().c;
  const legacy = m2.db.prepare(
    `SELECT COUNT(*) c FROM observation_sources WHERE source_ref='legacy-export'`).get().c;
  assert.equal(revs, dump.entity_observations.length, 'MCP round-trip lost revisions');
  assert.ok(supers >= 1, 'MCP round-trip lost the superseded revision (history flattened)');
  assert.equal(legacy, 0, 'MCP round-trip re-created observations as legacy imports');
  m2.cleanup?.();
  rmSync(d2, { recursive: true, force: true });
  process.env.DB_FILE_PATH = join(dir, 'test.db');
  console.log('  OK: MCP round-trip preserves lifecycle (validateToolArgs -> manager)');
}

// --- 구 형식 dump 는 event='import' 로 승격된다 (spec §6.4) ---
{
  const { m, d } = await freshManager();
  await m.importGraph({ entities: [{ id: 'entity_legacy', name: 'Legacy',
    entityType: 'CONCEPT', observations: ['legacy fact'] }] });
  const ev = m.db.prepare(`SELECT event, actor FROM observation_events`).all();
  assert.equal(ev.length, 1, 'legacy import must record exactly one event');
  assert.equal(ev[0].event, 'import',
    `legacy import recorded event='${ev[0].event}' — history would claim a human added it now`);
  assert.equal(ev[0].actor, 'import');
  m.cleanup?.();
  rmSync(d, { recursive: true, force: true });
  process.env.DB_FILE_PATH = join(dir, 'test.db');
  console.log('  OK: legacy import records event=import');
}

// --- import 는 파생 상태를 무효화한다 (비어 있지 않은 target + KG chunk) ---
// 앞의 왕복 테스트는 전부 **빈 새 DB** 로 import 한다. 그래서 "이미 있는 entity 를
// 덮어쓸 때 옛 벡터·옛 KG chunk 가 남는다"는 P0 을 전부 통과시켰다
// (advisor beta 발견 2, hybridSearch 로 실측). 여기서는 target 을 채워서 대조한다.
for (const merge of [true, false]) {
  const STALE = 'zzstaleimportzz';
  const { m, d } = await freshManager();
  await m.createEntities([{ name: 'ImportTarget', entityType: 'CONCEPT',
                           observations: [`old fact ${STALE}`] }]);
  // KG chunk 는 dormant 경로라 자연 발생하지 않는다 — 명시로 만든다.
  await m.generateKnowledgeGraphChunks();
  const idb = m.db;
  const chunksBefore = idb.prepare(
    `SELECT COUNT(*) c FROM chunk_metadata WHERE chunk_type='entity' AND entity_id='entity_importtarget'`).get().c;
  assert.ok(chunksBefore > 0, 'positive control: no entity chunk was created, the oracle proves nothing');
  assert.ok(idb.prepare(`SELECT COUNT(*) c FROM chunk_metadata WHERE text LIKE '%'||?||'%'`)
    .get(STALE).c > 0, 'positive control: the stale token is not in any chunk');
  // 임베딩 metadata 를 심어 벡터 무효화 여부를 관찰 가능하게 만든다
  idb.prepare(`INSERT OR REPLACE INTO entity_embedding_metadata (entity_id, embedding_text)
               VALUES ('entity_importtarget', ?)`).run(`old fact ${STALE}`);

  // 같은 entity 를 다른 내용으로 가진 dump
  const { m: src, d: sd } = await freshManager();
  await src.createEntities([{ name: 'ImportTarget', entityType: 'CONCEPT', observations: ['fresh only'] }]);
  const freshDump = await src.exportGraph();
  src.cleanup?.(); rmSync(sd, { recursive: true, force: true });

  await m.importGraph(freshDump, { merge });

  const proj = JSON.parse(idb.prepare(
    `SELECT observations FROM entities WHERE id='entity_importtarget'`).get().observations);
  assert.ok(proj.some(o => o.includes('fresh only')), `merge=${merge}: projection not updated`);
  if (merge) {
    // merge 는 더하기다: 들어온 관찰은 **다른** 논리 관찰이므로 배열 끝에 붙고
    // 기존 관찰은 살아 있어야 한다. 같은 배열 위치를 요구하는 슬롯 충돌은
    // 순번 재배정으로 해결한다(옛것을 덮으면 merge 가 아니라 replace 다).
    assert.ok(proj.some(o => o.includes(STALE)),
      'merge=true dropped an existing observation — that is replace semantics, not merge');
    assert.equal(proj.length, 2, `merge=true: expected both observations, got ${JSON.stringify(proj)}`);
    const orders = idb.prepare(
      `SELECT projection_order FROM observation_roots WHERE entity_id='entity_importtarget'
       ORDER BY projection_order`).all().map(r => r.projection_order);
    assert.deepEqual(orders, [0, 1], `merge=true: projection_order not reallocated: ${orders}`);
    // root 와 revision 의 순번이 어긋나면 trg_obs_matches_root 가 잡아야 한다 — 어긋남 0 확인
    assert.equal(idb.prepare(
      `SELECT COUNT(*) c FROM entity_observations o JOIN observation_roots r USING(root_id)
       WHERE o.projection_order <> r.projection_order`).get().c, 0,
      'merge=true: revision projection_order drifted from its root');
  } else {
    assert.ok(!proj.some(o => o.includes(STALE)),
      'merge=false: the cleared observation came back');
    assert.equal(proj.length, 1, `merge=false: expected only the imported observation`);
  }

  const staleChunks = idb.prepare(
    `SELECT COUNT(*) c FROM chunk_metadata WHERE text LIKE '%'||?||'%'`).get(STALE).c;
  assert.equal(staleChunks, 0,
    `merge=${merge}: a stale KG chunk survived the import and stays searchable`);
  const staleMeta = idb.prepare(
    `SELECT COUNT(*) c FROM entity_embedding_metadata WHERE entity_id='entity_importtarget'`).get().c;
  assert.equal(staleMeta, 0,
    `merge=${merge}: the entity vector was not invalidated, so search keeps the old embedding`);

  m.cleanup?.();
  rmSync(d, { recursive: true, force: true });
  process.env.DB_FILE_PATH = join(dir, 'test.db');
}
console.log('  OK: import invalidates derived state (merge true/false, non-empty target)');

// --- 계약: 알 수 없는 인자 거부 + history 선택자 정확히 하나 ---
{
  const { validateToolArgs } = await import('../dist/src/tools/tool-registry.js');

  // v3.6 의 index 기반 지정이 조용히 무시되면 호출자는 엉뚱한 revision 이
  // 처리됐다는 사실을 모른다 (spec T6, advisor beta 발견 4-1)
  assert.throws(() => validateToolArgs('retractObservation', { observation_id: 'x', index: 0 }),
    /unrecognized|unknown/i, 'old index field must be rejected, not stripped');
  assert.throws(() => validateToolArgs('correctObservation',
    { observation_id: 'x', content: 'y', observation_index: 0 }),
    /unrecognized|unknown/i, 'old observation_index must be rejected');
  // 정상 인자는 통과한다 (strict 가 정상 경로를 막지 않는다)
  assert.deepEqual(validateToolArgs('retractObservation', { observation_id: 'x' }),
    { observation_id: 'x' }, 'strict must not reject a valid call');

  assert.throws(() => getObservationHistory(db, { entity_name: 'Hist', root_id: 'missing' }),
    /exactly one selector/i,
    'two selectors must be rejected — precedence silently answers a different question');
  assert.throws(() => getObservationHistory(db, {}), /requires one of/);
  console.log('  OK: strict tool args + history one-of');
}

mgr.cleanup?.();
rmSync(dir, { recursive: true, force: true });
console.log('observation-contracts: ALL OK');
