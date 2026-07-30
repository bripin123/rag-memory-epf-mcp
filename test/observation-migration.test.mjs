// v13 migration: 변환 정확성 + 검증 게이트 + backup preflight.
// spec §5 + §8.2 (T3·T4·T9·T12·T15)
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.RAG_MEMORY_NO_AUTOSTART = '1';

// v12 상태의 DB 를 만든다: 엔진을 한 번 띄워 마이그레이션을 돌리고,
// v13 만 되돌린 뒤 legacy 배열을 심는다.
let seq = 0;
async function makeV12Db(observationsByEntity) {
  const dir = mkdtempSync(join(tmpdir(), 'rag-obs-mig-'));
  const dbPath = join(dir, 'test.db');
  process.env.DB_FILE_PATH = dbPath;
  const { RAGKnowledgeGraphManager } = await import(`../dist/index.js?v=${seq++}`);
  const mgr = new RAGKnowledgeGraphManager();
  await mgr.initialize({ skipModel: true });
  const db = mgr.db;
  db.exec(`DROP TABLE IF EXISTS observation_events`);
  db.exec(`DROP TABLE IF EXISTS observation_sources`);
  db.exec(`DROP TABLE IF EXISTS entity_observations`);
  db.exec(`DROP TABLE IF EXISTS observation_roots`);
  db.prepare(`DELETE FROM schema_migrations WHERE version = 13`).run();
  for (const [name, obs] of Object.entries(observationsByEntity)) {
    const id = `entity_${name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;
    db.prepare(`INSERT OR REPLACE INTO entities (id, name, observations, created_at)
                VALUES (?, ?, ?, '2020-01-01T00:00:00Z')`)
      .run(id, name, JSON.stringify(obs));
  }
  mgr.cleanup?.();
  return { dir, dbPath };
}

// 같은 DB 를 다시 열면 v13 마이그레이션이 돈다.
async function reopen(dbPath) {
  process.env.DB_FILE_PATH = dbPath;
  const { RAGKnowledgeGraphManager } = await import(`../dist/index.js?v=${seq++}`);
  const mgr = new RAGKnowledgeGraphManager();
  await mgr.initialize({ skipModel: true });
  return mgr;
}

// --- T15 + T9 + T3: 변환 정확성 (중복 문자열·순서 보존) ---
{
  const obs = ['[2026-01-01] first', 'dup', 'dup', '[2026-02-02] third'];
  const { dir, dbPath } = await makeV12Db({ Alpha: obs });
  const mgr = await reopen(dbPath);
  const db = mgr.db;
  const eid = 'entity_alpha';

  const roots = db.prepare(`SELECT * FROM observation_roots WHERE entity_id=? ORDER BY projection_order`).all(eid);
  assert.equal(roots.length, 4, 'T15: root count');
  assert.deepEqual(roots.map(r => r.projection_order), [0, 1, 2, 3], 'T15: projection_order 0..N-1');

  const revs = db.prepare(`SELECT * FROM entity_observations WHERE entity_id=? ORDER BY projection_order`).all(eid);
  assert.equal(revs.length, 4);
  // T9: 중복 문자열과 순서가 그대로 살아 있다
  assert.deepEqual(revs.map(r => r.content), obs, 'T9: content order/duplicates');
  for (const r of revs) {
    assert.equal(r.status, 'active');
    assert.equal(r.revision_no, 1);
    assert.equal(r.supersedes_id, null, 'T15: rev1 supersedes must be NULL');
    assert.equal(r.superseded_at, null, 'T15: superseded_at must be NULL');
  }

  // T15: MIGRATION_TS 가 전 행에서 동일하고 entities.created_at 이 아니다
  const ts = revs[0].recorded_at;
  assert.notEqual(ts, '2020-01-01T00:00:00Z', 'T15: recorded_at must not copy entities.created_at');
  for (const r of revs) assert.equal(r.recorded_at, ts, 'T15: revision recorded_at shared');
  for (const r of roots) assert.equal(r.created_at, ts, 'T15: root created_at = MIGRATION_TS');

  // T15: source 1행 / event 1행 · 필드값 exact
  const srcs = db.prepare(`SELECT s.* FROM observation_sources s
    JOIN entity_observations o USING(observation_id) WHERE o.entity_id=?`).all(eid);
  assert.equal(srcs.length, 4, 'T15: one source per revision');
  for (const s of srcs) {
    assert.equal(s.source_kind, 'import');
    assert.equal(s.source_ref, 'v12-migration');
    assert.equal(s.source_hash, null);
    assert.equal(s.recorded_at, ts);
  }
  const evs = db.prepare(`SELECT e.* FROM observation_events e
    JOIN observation_roots r USING(root_id) WHERE r.entity_id=?`).all(eid);
  assert.equal(evs.length, 4, 'T15: one event per root');
  const batch = evs[0].batch_id;
  assert.ok(batch, 'T15: batch_id present');
  for (const e of evs) {
    assert.equal(e.event, 'import');
    assert.equal(e.actor, 'v12-migration');
    assert.equal(e.change_kind, null);
    assert.equal(e.from_id, null);
    assert.equal(e.batch_id, batch, 'T15: all events share one batch_id');
    assert.equal(e.recorded_at, ts);
    const rev = db.prepare(`SELECT root_id FROM entity_observations WHERE observation_id=?`).get(e.to_id);
    assert.equal(rev?.root_id, e.root_id, 'T15: to_id points at own root revision');
  }

  // T3: projection 이 원본과 byte 동일
  const proj = db.prepare(`SELECT observations FROM entities WHERE id=?`).get(eid).observations;
  assert.equal(proj, JSON.stringify(obs), 'T3: projection != original array');

  mgr.cleanup?.();
  rmSync(dir, { recursive: true, force: true });
  console.log('  OK: T15/T9/T3 conversion exact');
}

// --- T4: 잘못된 observations 는 마이그레이션 시작 거부 ---
for (const bad of ['{"a":1}', '[1,2]', '[null]', '[{"x":1}]', 'not json']) {
  const dir = mkdtempSync(join(tmpdir(), 'rag-obs-bad-'));
  const dbPath = join(dir, 'test.db');
  process.env.DB_FILE_PATH = dbPath;
  const { RAGKnowledgeGraphManager } = await import(`../dist/index.js?v=${seq++}`);
  const mgr = new RAGKnowledgeGraphManager();
  await mgr.initialize({ skipModel: true });
  const db = mgr.db;
  db.exec(`DROP TABLE IF EXISTS observation_events`);
  db.exec(`DROP TABLE IF EXISTS observation_sources`);
  db.exec(`DROP TABLE IF EXISTS entity_observations`);
  db.exec(`DROP TABLE IF EXISTS observation_roots`);
  db.prepare(`DELETE FROM schema_migrations WHERE version = 13`).run();
  db.prepare(`INSERT OR REPLACE INTO entities (id, name, observations, created_at)
              VALUES ('entity_bad','Bad',?, '2020-01-01')`).run(bad);
  mgr.cleanup?.();

  let threw = null;
  try {
    const m2 = await reopen(dbPath);
    m2.cleanup?.();
  } catch (e) { threw = String(e.message); }
  assert.ok(threw, `T4: bad observations accepted -> ${bad}`);
  assert.match(threw, /array<string>|not JSON|observations/i, `T4: unclear error for ${bad}`);

  // 트랜잭션이 롤백됐으므로 v13 이 기록되지 않았다
  const raw = new Database(dbPath, { readonly: true });
  const v13 = raw.prepare(`SELECT 1 FROM schema_migrations WHERE version=13`).get();
  raw.close();
  assert.ok(!v13, `T4: version recorded despite failure -> ${bad}`);
  rmSync(dir, { recursive: true, force: true });
}
console.log('  OK: T4 array<string> preflight (5 cases)');

// --- T12: backup 이 만들어지고 검증되는가 ---
{
  const { dir, dbPath } = await makeV12Db({ Beta: ['x'] });
  const mgr = await reopen(dbPath);
  const bak = dbPath + '.v12.bak';
  assert.ok(existsSync(bak), 'T12: backup not created');
  const raw = new Database(bak, { readonly: true });
  assert.equal(raw.pragma('quick_check', { simple: true }), 'ok', 'T12: backup corrupt');
  // 백업은 v13 이전 상태여야 한다
  const hasV13 = raw.prepare(`SELECT 1 FROM schema_migrations WHERE version=13`).get();
  raw.close();
  assert.ok(!hasV13, 'T12: backup taken after migration');
  mgr.cleanup?.();
  rmSync(dir, { recursive: true, force: true });
  console.log('  OK: T12 backup preflight');
}

// --- T12b: 기존 backup 을 덮어쓰지 않는다 ---
{
  const { dir, dbPath } = await makeV12Db({ Gamma: ['y'] });
  writeFileSync(dbPath + '.v12.bak', 'PRE-EXISTING');
  let threw = null;
  try { const m = await reopen(dbPath); m.cleanup?.(); } catch (e) { threw = String(e.message); }
  assert.ok(threw, 'T12b: existing backup silently overwritten');
  assert.match(threw, /backup/i, 'T12b: unclear error');
  rmSync(dir, { recursive: true, force: true });
  console.log('  OK: T12b backup overwrite refused');
}

// --- T12c: 대기 중 마이그레이션이 없으면 backup 을 만들지 않는다 (no-op) ---
{
  const { dir, dbPath } = await makeV12Db({ Delta: ['z'] });
  const m1 = await reopen(dbPath);      // v13 적용 + backup 생성
  m1.cleanup?.();
  rmSync(dbPath + '.v12.bak');          // 백업을 지우고 다시 열어 본다
  const m2 = await reopen(dbPath);      // 대기 0 -> backup 없어야 한다
  m2.cleanup?.();
  assert.ok(!existsSync(dbPath + '.v12.bak'), 'T12c: backup created with no pending migrations');
  rmSync(dir, { recursive: true, force: true });
  console.log('  OK: T12c no-op when nothing pending');
}

// --- T12d: 신규 DB(스키마 버전 0)는 백업 대상이 아니다 ---
//     이 가드가 없으면 같은 경로 재초기화가 남은 .bak 때문에 죽는다(실제로 기존
//     reconciliation.test.mjs 가 이 결함을 잡아냈다).
{
  const dir = mkdtempSync(join(tmpdir(), 'rag-obs-fresh-'));
  const dbPath = join(dir, 'test.db');
  process.env.DB_FILE_PATH = dbPath;
  const { RAGKnowledgeGraphManager } = await import(`../dist/index.js?v=${seq++}`);
  const m = new RAGKnowledgeGraphManager();
  await m.initialize({ skipModel: true });      // 신규 DB: v1..v13 전부 대기
  m.cleanup?.();
  const baks = readdirSync(dir).filter(f => f.endsWith('.bak'));
  assert.deepEqual(baks, [], `T12d: fresh DB must not be backed up, got ${JSON.stringify(baks)}`);

  // 같은 경로를 지우고 다시 만들어도 부팅이 성공해야 한다 (정상 경로)
  rmSync(dbPath);
  const m2 = new (await import(`../dist/index.js?v=${seq++}`)).RAGKnowledgeGraphManager();
  await m2.initialize({ skipModel: true });
  m2.cleanup?.();
  rmSync(dir, { recursive: true, force: true });
  console.log('  OK: T12d fresh DB not backed up; re-init survives');
}

// --- T11: 각 지점 fault injection -> 전체 rollback (commit 전이므로 부분 잔존 불허) ---
for (const at of ['preflight', 'roots', 'revisions', 'sources', 'gate']) {
  const { dir: d, dbPath } = await makeV12Db({ Fault: ['f1', 'f2'] });
  // 주입은 dist 의 명시적 setter 로만 한다. 같은 모듈 인스턴스를 reopen 이 쓰도록
  // 쿼리 파라미터를 맞춰 import 한다.
  const migMod = await import(`../dist/src/migrations/migrations.js`);
  migMod.setMigrationFaultPoint(at);
  let threw = null;
  try { const m = await reopen(dbPath); m.cleanup?.(); } catch (e) { threw = String(e.message); }
  migMod.setMigrationFaultPoint(null);
  assert.ok(threw, `T11: fault at '${at}' did not fail the migration`);
  assert.match(threw, new RegExp(`injected fault at '${at}'`),
    `T11: fault at '${at}' failed for the wrong reason: ${threw}`);

  const raw = new Database(dbPath, { readonly: true });
  // v13 이 기록되지 않았고, lifecycle 테이블에 부분 데이터가 남지 않았다
  assert.ok(!raw.prepare(`SELECT 1 FROM schema_migrations WHERE version=13`).get(),
    `T11: version recorded despite fault at '${at}'`);
  const tableExists = raw.prepare(`SELECT 1 FROM sqlite_master WHERE name='entity_observations'`).get();
  if (tableExists) {
    const n = raw.prepare(`SELECT COUNT(*) c FROM entity_observations`).get().c;
    assert.equal(n, 0, `T11: partial revisions survived fault at '${at}'`);
    const r = raw.prepare(`SELECT COUNT(*) c FROM observation_roots`).get().c;
    assert.equal(r, 0, `T11: partial roots survived fault at '${at}'`);
  }
  // 원본 배열은 그대로다
  const obs = raw.prepare(`SELECT observations FROM entities WHERE id='entity_fault'`).get().observations;
  raw.close();
  assert.deepEqual(JSON.parse(obs), ['f1', 'f2'], `T11: source array mutated by fault at '${at}'`);

  // 백업은 남아 있어야 한다 — 롤백이 성공했더라도 운영자가 스냅샷을 잃으면 안 된다.
  const baks = readdirSync(d).filter(f => f.endsWith('.bak'));
  assert.equal(baks.length, 1, `T11: backup missing after fault at '${at}': ${JSON.stringify(baks)}`);

  // **재시작이 가능해야 한다.** 예전 구현은 남은 .bak 때문에 마이그레이션 진입 전에
  // 죽어서, 한 번의 일시적 실패가 fleet 자동 재시작 환경을 영구 정지시켰다
  // (advisor beta 발견 3). 이제는 남은 .bak 을 검증하고 재사용한다.
  const before = readdirSync(d).filter(f => f.endsWith('.bak'));
  const m2 = await reopen(dbPath);          // fault 해제 상태 = 정상 재시도
  const db2 = m2.db;
  assert.equal(db2.prepare(`SELECT MAX(version) v FROM schema_migrations`).get().v, 13,
    `T11: retry after fault at '${at}' did not complete the migration`);
  assert.deepEqual(JSON.parse(db2.prepare(
    `SELECT observations FROM entities WHERE id='entity_fault'`).get().observations), ['f1', 'f2'],
    `T11: retry after fault at '${at}' lost the observations`);
  m2.cleanup?.();
  // 그리고 원래 스냅샷을 덮어쓰거나 늘리지 않았다
  assert.deepEqual(readdirSync(d).filter(f => f.endsWith('.bak')), before,
    `T11: retry changed the backup set after fault at '${at}'`);

  rmSync(d, { recursive: true, force: true });
}
console.log('  OK: T11 fault injection (5 points: rollback, backup retained, restart resumes)');

// --- 손상된 .bak 은 재사용하지 않는다 (재사용 정책이 검증을 건너뛰면 게이트가 사라진다) ---
{
  const { dir: d, dbPath } = await makeV12Db({ Corrupt: ['c1'] });
  const migMod = await import(`../dist/src/migrations/migrations.js`);
  migMod.setMigrationFaultPoint('roots');
  try { const m = await reopen(dbPath); m.cleanup?.(); } catch { /* 의도된 실패 */ }
  migMod.setMigrationFaultPoint(null);
  const bak = readdirSync(d).find(f => f.endsWith('.bak'));
  assert.ok(bak, 'backup was not created');
  writeFileSync(join(d, bak), 'not a sqlite file at all');
  let err = null;
  try { const m2 = await reopen(dbPath); m2.cleanup?.(); } catch (e) { err = String(e.message); }
  assert.ok(err, 'a corrupt backup must not be silently reused');
  assert.match(err, /not a usable recovery point/i, `unexpected error: ${err}`);
  rmSync(d, { recursive: true, force: true });
  console.log('  OK: corrupt backup refused (reuse is verified, not assumed)');
}

// --- 다른 DB 의 정상 .bak 은 재사용하지 않는다 ---
// 손상 파일만 음성 대조군으로 쓰면 "정상 SQLite 이지만 남의 백업"이 통과한다.
// 스키마 버전은 판정 근거가 못 된다 — fleet 의 다른 프로젝트 DB 도 v12 이고
// quick_check 도 ok 다 (advisor beta r3 발견 1, 두 DB 로 실행 재현).
// 기준은 신원이 아니라 **논리 상태 동일성**이다(r4 P0 에서 신원 접근이 폐기됐다:
// DB 내부 UUID 는 파일 복사와 함께 복제된다).
{
  const A = await makeV12Db({ FleetA: ['a1'] });
  const B = await makeV12Db({ FleetB: ['b1'] });
  // A 를 실패시켜 A 의 .bak 을 만든다
  const migMod = await import(`../dist/src/migrations/migrations.js`);
  migMod.setMigrationFaultPoint('roots');
  try { const m = await reopen(A.dbPath); m.cleanup?.(); } catch { /* 의도된 실패 */ }
  migMod.setMigrationFaultPoint(null);
  const bakA = readdirSync(A.dir).find(f => f.endsWith('.bak'));
  assert.ok(bakA, 'A produced no backup');

  // 그 .bak 을 B 의 자리로 옮긴다 = 정상 SQLite · 같은 v12 · 다른 DB
  copyFileSync(join(A.dir, bakA), `${B.dbPath}.v12.bak`);
  let err = null;
  try { const m = await reopen(B.dbPath); m.cleanup?.(); } catch (e) { err = String(e.message); }
  assert.ok(err, "another database's backup was accepted as this one's recovery point");
  assert.match(err, /logical state differs/i, `unexpected error: ${err}`);
  // 그리고 남의 백업을 덮어쓰지 않았다
  assert.ok(existsSync(`${B.dbPath}.v12.bak`), 'the foreign backup was destroyed');
  rmSync(A.dir, { recursive: true, force: true });
  rmSync(B.dir, { recursive: true, force: true });
  console.log("  OK: another database's backup refused (state equality, not version)");
}

// --- 실패 후 live 가 변한 뒤에는 옛 .bak 을 현 상태의 복구점으로 인정하지 않는다 ---
{
  const { dir: d, dbPath } = await makeV12Db({ Drift: ['d1'] });
  const migMod = await import(`../dist/src/migrations/migrations.js`);
  migMod.setMigrationFaultPoint('roots');
  try { const m = await reopen(dbPath); m.cleanup?.(); } catch { /* 의도된 실패 */ }
  migMod.setMigrationFaultPoint(null);

  // **행 수를 바꾸지 않는** 변경을 넣는다. 새 행을 넣으면 COUNT 가 달라져서
  // 약한 집계 지문도 잡는다 — 그건 지문을 시험하지 않는다. 같은 길이 교체가
  // 통과하던 것이 실제 결함이었다(advisor beta r4 P0).
  const raw = new Database(dbPath);
  const beforeObs = raw.prepare(`SELECT observations FROM entities WHERE id='entity_drift'`).get().observations;
  const sameLength = beforeObs.replace('d1', 'zZ');   // 길이 동일, 내용 다름
  assert.equal(sameLength.length, beforeObs.length, 'probe must keep the length identical');
  raw.prepare(`UPDATE entities SET observations=? WHERE id='entity_drift'`).run(sameLength);
  raw.close();

  let err = null;
  try { const m = await reopen(dbPath); m.cleanup?.(); } catch (e) { err = String(e.message); }
  assert.ok(err, 'a stale backup was accepted after a same-length change to live');
  assert.match(err, /logical state differs|not a snapshot/i, `unexpected error: ${err}`);
  rmSync(d, { recursive: true, force: true });
  console.log('  OK: same-length change to live refuses the older backup (real digest)');
}

// --- 복제된 DB: 파일을 복사해도 상태가 갈리면 남의 .bak 을 쓰지 않는다 ---
// fleet 에는 실제로 `_copy_`·`_backup` DB 들이 있다. DB 내부 신원값은 복사와 함께
// 복제되므로 신원으로는 가를 수 없다 — 상태 동일성만이 기준이다(advisor beta r4 P0).
{
  const A = await makeV12Db({ Clone: ['c1'] });
  const B = { dir: mkdtempSync(join(tmpdir(), 'rag-obs-clone-')) };
  B.dbPath = join(B.dir, 'test.db');
  copyFileSync(A.dbPath, B.dbPath);      // 완전 복제 = 내부 신원값까지 동일

  // A 를 실패시켜 A 의 .bak 을 만든 뒤 B 자리로 옮긴다
  const migMod = await import(`../dist/src/migrations/migrations.js`);
  migMod.setMigrationFaultPoint('roots');
  try { const m = await reopen(A.dbPath); m.cleanup?.(); } catch { /* 의도된 실패 */ }
  migMod.setMigrationFaultPoint(null);
  copyFileSync(join(A.dir, readdirSync(A.dir).find(f => f.endsWith('.bak'))), `${B.dbPath}.v12.bak`);

  // 복제 직후에는 상태가 같으므로 재사용이 **허용**된다 (그게 맞는 계약이다)
  const okRun = await reopen(B.dbPath);
  assert.equal(okRun.db.prepare(`SELECT MAX(version) v FROM schema_migrations`).get().v, 13,
    'an identical-state backup should have been reusable');
  okRun.cleanup?.();

  // 이제 B 를 v12 로 되돌리고 내용을 바꾼 뒤 다시 시도하면 거부돼야 한다
  const raw = new Database(B.dbPath);
  raw.exec(`DROP TABLE IF EXISTS observation_events; DROP TABLE IF EXISTS observation_sources;
            DROP TABLE IF EXISTS entity_observations; DROP TABLE IF EXISTS observation_roots`);
  raw.prepare(`DELETE FROM schema_migrations WHERE version=13`).run();
  raw.prepare(`UPDATE entities SET name='Cl0ne' WHERE id='entity_clone'`).run();  // 같은 길이
  raw.close();
  let err2 = null;
  try { const m = await reopen(B.dbPath); m.cleanup?.(); } catch (e) { err2 = String(e.message); }
  assert.ok(err2, 'a cloned database reused a backup that no longer matches its state');
  assert.match(err2, /logical state differs/i, `unexpected error: ${err2}`);
  rmSync(A.dir, { recursive: true, force: true });
  rmSync(B.dir, { recursive: true, force: true });
  console.log('  OK: cloned DB — identical state reusable, diverged state refused');
}

// --- server_meta 가 없는 구 버전 DB 도 재사용이 된다 ---
// 신원값을 server_meta 에 두던 판본은 pre-v12 DB 에서 "신원 없음"으로 영구 거부해
// 같은 crashloop 을 다시 만들었다(advisor beta r4 P1). 논리 다이제스트는 의존하지 않는다.
{
  const dir = mkdtempSync(join(tmpdir(), 'rag-obs-prev12-'));
  const dbPath = join(dir, 'test.db');
  const raw = new Database(dbPath);
  raw.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT, observations TEXT)`);
  raw.prepare(`INSERT INTO entities VALUES ('entity_old','Old','["legacy"]')`).run();
  raw.close();
  const { backupBeforeMigration } = await import('../dist/src/backup/preflight.js');
  const open = () => { const d = new Database(dbPath); return d; };
  const d1 = open();
  const first = backupBeforeMigration(d1, dbPath, [12], 11);
  d1.close();
  assert.ok(first && existsSync(`${dbPath}.v11.bak`), 'no backup for a pre-v12 database');
  const d2 = open();
  const second = backupBeforeMigration(d2, dbPath, [12], 11);   // 재시도 = 거부되면 안 된다
  d2.close();
  assert.equal(second.path, first.path, 'pre-v12 retry did not reuse the existing backup');
  rmSync(dir, { recursive: true, force: true });
  console.log('  OK: pre-v12 DB (no server_meta) can still resume');
}

console.log('observation-migration: ALL OK');
