// cascade 격리 + FK 부팅 게이트. spec §5.2 · §8.2b (T20 · T25)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const dir = mkdtempSync(join(tmpdir(), 'rag-obs-casc-'));
process.env.DB_FILE_PATH = join(dir, 'test.db');
const { RAGKnowledgeGraphManager } = await import('../dist/index.js');
const mgr = new RAGKnowledgeGraphManager();
await mgr.initialize({ skipModel: true });
const db = mgr.db;

// --- T25 positive: 부팅 후 FK 가 켜져 있다 ---
assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'T25: FK not enabled at boot');
console.log('  OK: T25 positive (FK on)');

// --- T20 ⓓ: FK 선언 튜플이 정확한가 ---
{
  const fks = (t) => db.pragma(`foreign_key_list(${t})`)
    .map(f => `${f.table}.${f.to}<-${f.from} ${f.on_delete}`).sort();
  assert.deepEqual(fks('entity_observations'), [
    'entities.id<-entity_id CASCADE',
    'entity_observations.observation_id<-supersedes_id NO ACTION',
    'observation_roots.root_id<-root_id CASCADE',
  ].sort(), 'T20ⓓ: entity_observations FK tuples');
  assert.deepEqual(fks('observation_events'), ['observation_roots.root_id<-root_id CASCADE'],
    'T20ⓓ: observation_events FK tuples');
  assert.deepEqual(fks('observation_sources'),
    ['entity_observations.observation_id<-observation_id CASCADE'], 'T20ⓓ: sources FK tuples');
  assert.deepEqual(fks('observation_roots'), ['entities.id<-entity_id CASCADE'],
    'T20ⓓ: roots FK tuples');
  console.log('  OK: T20ⓓ FK declarations');
}

// --- T20 ⓐⓑ: raw parent DELETE 후 자식이 전부 사라진다 ---
{
  // sources 를 명시로 넘긴다. 출처를 모르면 source 행을 만들지 않으므로(ADV5)
  // 기본값에 기대면 orphan-source 검사가 0 대 0 으로 무의미하게 통과한다.
  await mgr.createEntities([{ name: 'Casc', entityType: 'CONCEPT', observations: ['c1', 'c2'],
                             sources: [{ source_kind: 'document', source_ref: 'casc-doc' }] }]);
  await mgr.createEntities([{ name: 'Keep', entityType: 'CONCEPT', observations: ['k1'],
                             sources: [{ source_kind: 'document', source_ref: 'keep-doc' }] }]);
  const c = (t, w = '1=1', ...p) => db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${w}`).get(...p).c;

  // 사전 상태 — 부재로 통과하지 못하게 자식 4종이 실제로 있는지 먼저 센다.
  // observation_sources 에는 entity_id 컬럼이 없어 root 를 통해 세야 한다.
  const srcOf = (eid) => db.prepare(
    `SELECT COUNT(*) c FROM observation_sources s
     JOIN entity_observations o USING(observation_id) WHERE o.entity_id = ?`).get(eid).c;
  assert.ok(c('observation_roots', `entity_id='entity_casc'`) > 0, 'T20ⓐ: roots empty before delete');
  assert.ok(c('entity_observations', `entity_id='entity_casc'`) > 0, 'T20ⓐ: revisions empty before delete');
  assert.ok(srcOf('entity_casc') > 0, 'T20ⓐ: sources empty before delete');
  assert.ok(c('observation_events') > 0, 'T20ⓐ: events empty before delete');

  // deleteEntities 가 아니라 raw DELETE — 수동 child 삭제가 FK 누락을 가리지 못하게
  db.prepare(`DELETE FROM entities WHERE id='entity_casc'`).run();
  assert.equal(c('observation_roots', `entity_id='entity_casc'`), 0, 'T20ⓑ: roots');
  assert.equal(c('entity_observations', `entity_id='entity_casc'`), 0, 'T20ⓑ: revisions');
  const orphanSrc = db.prepare(`SELECT COUNT(*) c FROM observation_sources s
    LEFT JOIN entity_observations o USING(observation_id) WHERE o.observation_id IS NULL`).get().c;
  assert.equal(orphanSrc, 0, 'T20ⓑ: orphan sources');
  const orphanEv = db.prepare(`SELECT COUNT(*) c FROM observation_events e
    LEFT JOIN observation_roots r USING(root_id) WHERE r.root_id IS NULL`).get().c;
  assert.equal(orphanEv, 0, 'T20ⓑ: orphan events');
  // 무관 fixture 는 유지
  assert.ok(c('observation_roots', `entity_id='entity_keep'`) > 0, 'T20ⓑ: unrelated rows destroyed');
  assert.ok(srcOf('entity_keep') > 0, 'T20ⓑ: unrelated sources destroyed');
  console.log('  OK: T20ⓐⓑ entity cascade');
}

// --- T20 ⓒ: root 단독 DELETE 로 revision->root FK 를 독립 검증 ---
{
  const rid = db.prepare(`SELECT root_id FROM observation_roots WHERE entity_id='entity_keep'`).get().root_id;
  db.prepare(`DELETE FROM observation_roots WHERE root_id=?`).run(rid);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM entities WHERE id='entity_keep'`).get().c, 1,
    'T20ⓒ: entity must survive a root delete');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM entity_observations WHERE root_id=?`).get(rid).c, 0,
    'T20ⓒ: revisions not cascaded from root');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM observation_events WHERE root_id=?`).get(rid).c, 0,
    'T20ⓒ: events not cascaded from root');
  console.log('  OK: T20ⓒ root-only cascade');
}

mgr.cleanup?.();
rmSync(dir, { recursive: true, force: true });

// --- T25 negative: FK 를 끈 상태로 부팅하면 fail-closed ---
{
  const d2 = mkdtempSync(join(tmpdir(), 'rag-obs-fk0-'));
  const p = join(d2, 'test.db');
  process.env.DB_FILE_PATH = p;
  const { RAGKnowledgeGraphManager: M } = await import('../dist/index.js?fk=0');
  const m = new M();
  let threw = null;
  // 주입은 인자로만 한다 — 환경변수 스위치는 프로덕션 부팅을 막을 수 있어 제거됐다.
  try { await m.initialize({ skipModel: true, __testForceFkOff: true }); }
  catch (e) { threw = String(e.message); }
  assert.ok(threw, 'T25 negative: boot succeeded with FK off');
  assert.match(threw, /foreign_keys/i, 'T25 negative: unclear error');
  // 게이트가 마이그레이션·버전 기록 *앞*에 있었는가
  const raw = new Database(p, { readonly: true });
  const hasTable = raw.prepare(`SELECT 1 FROM sqlite_master WHERE name='schema_migrations'`).get();
  const v = hasTable ? raw.prepare(`SELECT COUNT(*) c FROM schema_migrations`).get().c : 0;
  const hasLifecycle = raw.prepare(
    `SELECT 1 FROM sqlite_master WHERE name='entity_observations'`).get();
  raw.close();
  assert.equal(v, 0, 'T25 negative: migrations were recorded despite the gate');
  assert.ok(!hasLifecycle, 'T25 negative: schema was created despite the gate');
  m.cleanup?.();
  rmSync(d2, { recursive: true, force: true });
  console.log('  OK: T25 negative (fail-closed)');
}

console.log('observation-cascade: ALL OK');
