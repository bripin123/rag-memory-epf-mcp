// v13 schema invariants. spec §4.1~4.3 + §8.1 대조군.
// 규칙: 각 대조군은 "의도한 제약의 정확한 오류"로 거부되어야 한다.
// 다른 제약이 대신 막으면 목표 제약이 없어도 통과한다(false-pass).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const dir = mkdtempSync(join(tmpdir(), 'rag-obs-schema-'));
process.env.DB_FILE_PATH = join(dir, 'test.db');
const { RAGKnowledgeGraphManager } = await import('../dist/index.js');

const mgr = new RAGKnowledgeGraphManager();
await mgr.initialize({ skipModel: true });
const db = mgr.db;

// throws(fn) -> 오류 메시지 문자열. 안 던지면 null.
const err = (fn) => { try { fn(); return null; } catch (e) { return String(e.message); } };

// --- fixture: entity 1개 + root 2개 + rev1 2개 ---
db.exec(`INSERT INTO entities (id, name, observations) VALUES ('eA','A','[]')`);
const mkRoot = (rid, ord) =>
  db.prepare(`INSERT INTO observation_roots (root_id, entity_id, projection_order, created_at)
              VALUES (?, 'eA', ?, '2026-07-30T00:00:00Z')`).run(rid, ord);
const mkRev = (oid, rid, rev, ord, status, sup) =>
  db.prepare(`INSERT INTO entity_observations
    (observation_id, root_id, entity_id, revision_no, projection_order, content, status, supersedes_id, recorded_at)
    VALUES (?, ?, 'eA', ?, ?, 'c', ?, ?, '2026-07-30T00:00:00Z')`).run(oid, rid, rev, ord, status, sup);

mkRoot('r1', 0); mkRoot('r2', 1);
mkRev('o1', 'r1', 1, 0, 'active', null);
mkRev('o2', 'r2', 1, 1, 'active', null);

// 1) 테이블·인덱스·트리거 존재
for (const t of ['observation_roots', 'entity_observations', 'observation_sources', 'observation_events']) {
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t), `${t} missing`);
}
for (const i of ['idx_obs_active_per_root', 'idx_obs_active_order']) {
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(i), `${i} missing`);
}
for (const tg of ['trg_roots_immutable', 'trg_obs_content_immutable', 'trg_obs_identity_immutable',
                  'trg_obs_matches_root', 'trg_obs_chain_wellformed']) {
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`).get(tg), `${tg} missing`);
}
console.log('  OK: v13 objects present');

// 2) T1 — 같은 root 에 active 2행. revision_no 를 "다르게" 줘서
//    UNIQUE(root_id, revision_no) 가 아니라 부분 인덱스가 잡게 한다.
//
//    실측으로 확인된 구조: trg_obs_matches_root 가 revision 의
//    (entity_id, projection_order) 를 root 의 값과 일치시키므로, 같은 root 의 두 active 행은
//    필연적으로 같은 (entity_id, projection_order) 를 갖는다. 따라서 통합 스키마에서는
//    idx_obs_active_order 가 idx_obs_active_per_root 를 항상 가린다
//    (= 후자는 전자의 부분집합이고, 스키마에 남기는 이유는 계약의 명시성뿐이다).
//    여기서는 "둘 중 하나가 막는다"까지만 확인하고, 각 인덱스의 격리 시험은 아래 T1b/T2c 에서 한다.
assert.match(err(() => mkRev('oX', 'r1', 2, 0, 'active', 'o1')),
  /UNIQUE constraint failed: entity_observations\.(root_id|entity_id)/,
  'T1: neither partial index enforced');
console.log('  OK: T1 active-per-root (combined schema)');

// 2b) T1b — idx_obs_active_per_root 격리 시험.
//     idx_obs_active_order 와 trg_obs_matches_root 를 뺀 스키마에서 이 인덱스만 남긴다.
{
  const iso = new (db.constructor)(':memory:');
  iso.exec(`
    CREATE TABLE entity_observations (
      observation_id TEXT PRIMARY KEY NOT NULL, root_id TEXT NOT NULL, entity_id TEXT NOT NULL,
      revision_no INTEGER NOT NULL, projection_order INTEGER NOT NULL,
      content TEXT NOT NULL, status TEXT NOT NULL, supersedes_id TEXT,
      recorded_at DATETIME NOT NULL, superseded_at DATETIME,
      UNIQUE (root_id, revision_no));
    CREATE UNIQUE INDEX idx_obs_active_per_root
      ON entity_observations(root_id) WHERE status = 'active';
    INSERT INTO entity_observations VALUES ('a','r','e',1,0,'c','active',NULL,'t',NULL);`);
  const msg = (() => { try {
    iso.exec(`INSERT INTO entity_observations VALUES ('b','r','e',2,5,'c','active',NULL,'t',NULL)`);
    return null;
  } catch (e) { return String(e.message); } })();
  iso.close();
  assert.match(msg, /UNIQUE constraint failed: entity_observations\.root_id/,
    'T1b: idx_obs_active_per_root does not enforce one active per root');
  console.log('  OK: T1b active-per-root (isolated)');
}

// 3) T2 — content UPDATE 거부
assert.match(err(() => db.exec(`UPDATE entity_observations SET content='x' WHERE observation_id='o1'`)),
  /content is immutable/, 'T2');

// 4) T2b — 신원 7필드를 각각 별도 UPDATE (묶으면 하나만 막는 구현도 통과)
for (const col of ['observation_id', 'root_id', 'entity_id', 'revision_no',
                   'supersedes_id', 'projection_order', 'recorded_at']) {
  const v = col === 'revision_no' || col === 'projection_order' ? 9 : `'zz'`;
  const msg = err(() => db.exec(`UPDATE entity_observations SET ${col}=${v} WHERE observation_id='o1'`));
  assert.match(msg, /identity\/order fields are immutable/, `T2b: ${col} mutable`);
}
console.log('  OK: T2/T2b immutability');

// 5) T2c2 — root(eA) 에 revision(eB)
db.exec(`INSERT INTO entities (id, name, observations) VALUES ('eB','B','[]')`);
mkRoot('r9', 9);
assert.match(err(() => db.prepare(`INSERT INTO entity_observations
    (observation_id, root_id, entity_id, revision_no, projection_order, content, status, recorded_at)
    VALUES ('o9','r9','eB',1,9,'c','active','2026-07-30T00:00:00Z')`).run()),
  /\(entity_id, projection_order\) must match it/, 'T2c2');

// 6) 없는 root
assert.match(err(() => mkRev('oNo', 'rNONE', 1, 5, 'active', null)),
  /root_id must exist/, 'orphan root accepted');
console.log('  OK: T2c2 root binding');

// 7) T2g — 체인 4 케이스. 기대 오류 문자열까지 대조.
//    (a) rev1 + non-NULL predecessor
assert.match(err(() => mkRev('oa', 'r2', 1, 1, 'active', 'o1')),
  /first revision must have NULL supersedes_id/, 'T2g-a');
//    (b) rev3 + NULL predecessor — rev2 를 먼저 만들어 UNIQUE 가 대신 막지 않게 한다
mkRev('o2b', 'r2', 2, 1, 'superseded', 'o2');
assert.match(err(() => mkRev('ob', 'r2', 3, 1, 'active', null)),
  /non-first revision must have a predecessor/, 'T2g-b');
//    (c) revision_no=0 — BEFORE 트리거가 CHECK 보다 먼저 실행된다
assert.match(err(() => mkRev('oc', 'r9', 0, 9, 'active', null)),
  /revision_no must be >= 1/, 'T2g-c');
//    (d) revision_no='2x' + 유효 predecessor 를 줘야 CHECK 에 도달한다
assert.match(err(() => mkRev('od', 'r2', '2x', 1, 'active', 'o2')),
  /CHECK constraint failed/, 'T2g-d');
console.log('  OK: T2g chain well-formedness');

// 8) T2f — 건너뛴 predecessor (rev4 supersedes rev2)
assert.match(err(() => mkRev('of', 'r2', 4, 1, 'active', 'o2')),
  /immediately preceding revision/, 'T2f');
console.log('  OK: T2f contiguity');

// 9) T22 — roots 4필드 각각 별도 UPDATE. 다른 제약에 안 걸리는 값을 쓴다.
for (const [col, v] of [['root_id', `'rZ'`], ['entity_id', `'eB'`],
                        ['projection_order', 77], ['created_at', `'2020-01-01'`]]) {
  assert.match(err(() => db.exec(`UPDATE observation_roots SET ${col}=${v} WHERE root_id='r9'`)),
    /observation_roots is immutable/, `T22: ${col} mutable`);
}
console.log('  OK: T22 roots immutable');

// 10) T24 — PK NULL. 나머지 필드는 모두 유효하게.
assert.match(err(() => db.prepare(`INSERT INTO observation_roots
    (root_id, entity_id, projection_order, created_at) VALUES (NULL,'eA',50,'t')`).run()),
  /NOT NULL constraint failed: observation_roots\.root_id/, 'T24 roots');
assert.match(err(() => db.prepare(`INSERT INTO observation_events
    (event_id, root_id, event, recorded_at) VALUES (NULL,'r1','add','t')`).run()),
  /NOT NULL constraint failed: observation_events\.event_id/, 'T24 events');
console.log('  OK: T24 PK NOT NULL');

// 11) status enum
assert.match(err(() => mkRev('oe', 'r9', 1, 9, 'bogus', null)), /CHECK constraint failed/, 'status enum');
console.log('  OK: status enum');

// 12) T2c — idx_obs_active_order 격리 시험 (§8.1).
//     통합 스키마에서는 observation_roots UNIQUE 와 trg_obs_matches_root 가 먼저 막으므로
//     이 인덱스가 없어도 통과한다(false-pass). 둘을 뺀 스키마에서 이 인덱스만 남긴다.
{
  const iso = new (db.constructor)(':memory:');
  iso.exec(`
    CREATE TABLE entity_observations (
      observation_id TEXT PRIMARY KEY NOT NULL, root_id TEXT NOT NULL, entity_id TEXT NOT NULL,
      revision_no INTEGER NOT NULL, projection_order INTEGER NOT NULL,
      content TEXT NOT NULL, status TEXT NOT NULL, supersedes_id TEXT,
      recorded_at DATETIME NOT NULL, superseded_at DATETIME,
      UNIQUE (root_id, revision_no));
    CREATE UNIQUE INDEX idx_obs_active_order
      ON entity_observations(entity_id, projection_order) WHERE status = 'active';
    INSERT INTO entity_observations VALUES ('a','rA','e',1,0,'c','active',NULL,'t',NULL);`);
  // 다른 root, 같은 (entity, order) -> 이 인덱스만이 막을 수 있다
  const msg = (() => { try {
    iso.exec(`INSERT INTO entity_observations VALUES ('b','rB','e',1,0,'c','active',NULL,'t',NULL)`);
    return null;
  } catch (e) { return String(e.message); } })();
  // retract 하면 자리가 비어 같은 order 를 다른 root 가 쓸 수 있다(부분 인덱스 의미 확인)
  iso.exec(`UPDATE entity_observations SET status='retracted' WHERE observation_id='a'`);
  const after = (() => { try {
    iso.exec(`INSERT INTO entity_observations VALUES ('c','rC','e',1,0,'c','active',NULL,'t',NULL)`);
    return null;
  } catch (e) { return String(e.message); } })();
  iso.close();
  assert.match(msg, /UNIQUE constraint failed: entity_observations\.entity_id/,
    'T2c: idx_obs_active_order does not enforce unique active order');
  assert.equal(after, null, 'T2c: partial index must only constrain active rows');
  console.log('  OK: T2c active-order (isolated)');
}

mgr.close?.();
rmSync(dir, { recursive: true, force: true });
console.log('observation-schema: ALL OK');
