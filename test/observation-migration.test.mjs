// v13 migration: 변환 정확성 + 검증 게이트 + backup preflight.
// spec §5 + §8.2 (T3·T4·T9·T12·T15)
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// 스키마 최신 버전 — 새 마이그레이션 추가 시 여기 한 곳만 올린다 (v14 도입 때 리터럴 13 두 곳이 무더기로 깨졌다)
const LATEST_VERSION = 14;

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
  // v14 도입 후: "v13 행만 삭제" 위장은 MAX(version)=14 라 v13 이 재실행되지 않는다
  // (조사 문서의 MAX-산술 함정 그대로). 실기계 down 으로 v12 상태를 만든다 —
  // v14 down(컬럼+stamp 제거)과 v13 down(4테이블 drop)이 실제로 돈다.
  await mgr.rollbackMigration(12);
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
  // v14 도입 후: "v13 행만 삭제" 위장은 MAX(version)=14 라 v13 이 재실행되지 않는다
  // (조사 문서의 MAX-산술 함정 그대로). 실기계 down 으로 v12 상태를 만든다 —
  // v14 down(컬럼+stamp 제거)과 v13 down(4테이블 drop)이 실제로 돈다.
  await mgr.rollbackMigration(12);
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

// --- T12b: 기존 backup 을 덮어쓰지 않고 새 슬롯에 만든다 ---
{
  const { dir, dbPath } = await makeV12Db({ Gamma: ['y'] });
  const base = dbPath + '.v12.bak';
  writeFileSync(base, 'PRE-EXISTING');
  const m = await reopen(dbPath);
  m.cleanup?.();
  // 원본은 한 글자도 안 바뀐다
  assert.equal(readFileSync(base, 'utf8'), 'PRE-EXISTING', 'T12b: existing backup was overwritten');
  // 그리고 새 복구점이 옆에 생긴다 (재시작이 막히지 않는다)
  assert.ok(existsSync(base + '.1'), 'T12b: no new recovery slot was created');
  const fresh = new Database(base + '.1', { readonly: true });
  assert.equal(fresh.pragma('quick_check', { simple: true }), 'ok', 'T12b: new slot is corrupt');
  fresh.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('  OK: T12b existing backup preserved, new slot created');
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
  const before = readdirSync(d).filter(f => f.includes('.bak')).sort();
  const m2 = await reopen(dbPath);          // fault 해제 상태 = 정상 재시도
  const db2 = m2.db;
  assert.equal(db2.prepare(`SELECT MAX(version) v FROM schema_migrations`).get().v, LATEST_VERSION,
    `T11: retry after fault at '${at}' did not complete the migration`);
  assert.deepEqual(JSON.parse(db2.prepare(
    `SELECT observations FROM entities WHERE id='entity_fault'`).get().observations), ['f1', 'f2'],
    `T11: retry after fault at '${at}' lost the observations`);
  m2.cleanup?.();
  // 원래 스냅샷은 그대로 있고, 재시도는 **새 슬롯**을 하나 더 만든다
  const after = readdirSync(d).filter(f => f.includes('.bak')).sort();
  assert.ok(before.every(f => after.includes(f)),
    `T11: retry removed a recovery point after fault at '${at}'`);
  assert.equal(after.length, before.length + 1,
    `T11: retry did not create a new recovery slot after fault at '${at}': ${JSON.stringify(after)}`);

  rmSync(d, { recursive: true, force: true });
}
console.log('  OK: T11 fault injection (5 points: rollback, backup retained, restart resumes)');

// --- 복구점 슬롯이 다 차면 fail-closed ---
// 회전의 대가는 디스크다. 무한히 쌓이면 그것도 결함이므로 상한을 두고, 상한에
// 닿으면 멈춘다 — 마이그레이션이 세 번 연속 실패하는 상태는 사람이 봐야 한다.
{
  const { dir: d, dbPath } = await makeV12Db({ Slots: ['s1'] });
  const migMod = await import(`../dist/src/migrations/migrations.js`);
  const base = dbPath + '.v12.bak';

  // 세 번 실패시키면 세 슬롯이 찬다
  for (let i = 0; i < 3; i++) {
    migMod.setMigrationFaultPoint('roots');
    try { const m = await reopen(dbPath); m.cleanup?.(); } catch { /* 의도된 실패 */ }
    migMod.setMigrationFaultPoint(null);
  }
  const baks = readdirSync(d).filter(f => f.includes('.v12.bak')).sort();
  assert.equal(baks.length, 3, `expected 3 recovery points, got ${JSON.stringify(baks)}`);

  // 네 번째 시도는 거부된다 — 그리고 기존 셋을 건드리지 않는다
  const before = baks.map(f => statSync(join(d, f)).size);
  let err = null;
  try { const m = await reopen(dbPath); m.cleanup?.(); } catch (e) { err = String(e.message); }
  assert.ok(err, 'a fourth attempt ran with all recovery slots full');
  assert.match(err, /recovery-point slots .* are taken/i, `unexpected error: ${err}`);
  assert.deepEqual(readdirSync(d).filter(f => f.includes('.v12.bak')).sort(), baks,
    'the refused attempt changed the backup set');
  assert.deepEqual(baks.map(f => statSync(join(d, f)).size), before,
    'the refused attempt modified an existing recovery point');
  rmSync(d, { recursive: true, force: true });
  console.log('  OK: recovery slots are bounded and full slots fail closed');
}

// --- 기존 백업이 무엇이든(손상·남의 것·오래된 것) 재시작을 막지 않는다 ---
// 앞선 세 판본은 남은 .bak 이 "이 DB 의 현재 상태인가"를 판정하려 했고, 그 판정이
// 세 번 틀렸다(스키마 버전=신원 착각 · 복제되는 내부 UUID+약한 지문 · sqlite_sequence·
// hidden rowid·INTEGER 정밀도 누락). 회전은 그 판정을 하지 않으므로 이 셋 전부가
// 같은 결과를 낸다: 건드리지 않고, 옆에 새로 만들고, 부팅은 성공한다.
for (const [label, make] of [
  ['corrupt', (p) => writeFileSync(p, 'not a sqlite file at all')],
  ['foreign', (p) => { const d2 = new Database(p); d2.exec(`CREATE TABLE other(x)`);
                       d2.prepare(`INSERT INTO other VALUES ('someone else')`).run(); d2.close(); }],
]) {
  const { dir: d, dbPath } = await makeV12Db({ [`Keep${label}`]: ['k1'] });
  const base = dbPath + '.v12.bak';
  make(base);
  const bytesBefore = readFileSync(base);
  const m = await reopen(dbPath);
  assert.equal(m.db.prepare(`SELECT MAX(version) v FROM schema_migrations`).get().v, LATEST_VERSION,
    `${label} backup blocked the migration`);
  m.cleanup?.();
  assert.deepEqual(readFileSync(base), bytesBefore, `${label} backup was modified`);
  assert.ok(existsSync(base + '.1'), `${label}: no new recovery slot`);
  rmSync(d, { recursive: true, force: true });
  console.log(`  OK: pre-existing ${label} backup neither blocks nor is touched`);
}

// --- server_meta 없는 구 버전 DB 도 두 번째 시도가 막히지 않는다 ---
// 신원값을 server_meta 에 두던 판본은 pre-v12 DB 에서 "신원 없음"으로 영구 거부해
// 같은 crashloop 을 다시 만들었다(advisor beta r4 P1). 회전은 아무것도 조회하지 않는다.
{
  const dir = mkdtempSync(join(tmpdir(), 'rag-obs-prev12-'));
  const dbPath = join(dir, 'test.db');
  const seed = new Database(dbPath);
  seed.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT, observations TEXT)`);
  seed.prepare(`INSERT INTO entities VALUES ('entity_old','Old','["legacy"]')`).run();
  seed.close();
  const { backupBeforeMigration } = await import('../dist/src/backup/preflight.js');
  const call = async () => { const d = new Database(dbPath);
    try { return await backupBeforeMigration(d, dbPath, [12], 11); } finally { d.close(); } };
  const first = await call();
  assert.ok(first && existsSync(`${dbPath}.v11.bak`), 'no backup for a pre-v12 database');
  const second = await call();
  assert.ok(second, 'pre-v12 retry was refused');
  assert.notEqual(second.path, first.path, 'the retry reused the same file instead of a new slot');
  assert.equal(second.path, `${dbPath}.v11.bak.1`);
  rmSync(dir, { recursive: true, force: true });
  console.log('  OK: pre-v12 DB (no server_meta) retries into a new slot');
}

// --- version 0 인데 데이터가 있으면 백업한다 (테이블 목록 하드코딩 금지) ---
// `entities/documents/relationships` 세 개만 세던 판본은 `embedding_profiles` 에만
// 행이 있는 version-0 DB 를 무백업으로 통과시켰다(advisor beta r6 P0-3).
{
  const dir = mkdtempSync(join(tmpdir(), 'rag-obs-v0data-'));
  const dbPath = join(dir, 'test.db');
  const seed = new Database(dbPath);
  seed.exec(`CREATE TABLE embedding_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  seed.prepare(`INSERT INTO embedding_profiles (name) VALUES ('bge-m3')`).run();
  seed.close();
  const { backupBeforeMigration } = await import('../dist/src/backup/preflight.js');
  const d = new Database(dbPath);
  const got = await backupBeforeMigration(d, dbPath, [1], 0);
  d.close();
  assert.ok(got, 'a version-0 database holding data was migrated without a backup');
  assert.ok(existsSync(`${dbPath}.v0.bak`), 'no backup file was produced');

  // 그리고 진짜 빈 DB 는 여전히 건너뛴다 (정상 경로를 막지 않는다)
  const dir2 = mkdtempSync(join(tmpdir(), 'rag-obs-v0empty-'));
  const p2 = join(dir2, 'test.db');
  const e = new Database(p2);
  e.exec(`CREATE TABLE embedding_profiles (id INTEGER PRIMARY KEY, name TEXT)`);
  const skipped = await backupBeforeMigration(e, p2, [1], 0);
  e.close();
  assert.equal(skipped, null, 'a genuinely empty version-0 database should not be backed up');
  assert.deepEqual(readdirSync(dir2).filter(f => f.endsWith('.bak')), []);
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
  console.log('  OK: version-0 with data is backed up; genuinely empty is skipped');
}

// --- 백업은 복원했을 때 실제로 쓸 수 있어야 한다 (FTS external-content 포함) ---
// `quick_check` 는 페이지 구조만 본다. `entities` 는 hidden ROWID 테이블이고
// `entities_fts` 가 `content_rowid='rowid'` 로 그것을 참조하므로, ROWID 가 재번호된
// 스냅샷은 quick_check 를 통과하면서도 복원 후 FTS 가 깨진다(advisor beta r7 P0-1).
//
// **`rank = 1` 이 필수다.** 인자 없는 integrity-check 는 external-content 를 대조하지
// 않아서, 불일치 스냅샷에서도 통과한다(r8 P0 — 이 테스트의 첫 판이 그래서 무력했다).
{
  const { dir: d, dbPath } = await makeV12Db({ FtsRestore: ['searchable observation alpha'] });
  // ROWID 간격을 실제로 만든다: 2·3 을 만든 뒤 **가운데(2)를 지운다**.
  // 지운 뒤 새로 넣으면 SQLite 가 max+1 을 주므로 간격이 안 생긴다(첫 판의 오류).
  const seed = new Database(dbPath);
  seed.prepare(`INSERT INTO entities (id,name,observations,created_at)
                VALUES ('entity_mid','Mid','["middle"]','2020-01-01T00:00:00Z')`).run();
  seed.prepare(`INSERT INTO entities (id,name,observations,created_at)
                VALUES ('entity_after','After','["zzuniqueafterzz token"]','2020-01-01T00:00:00Z')`).run();
  seed.prepare(`DELETE FROM entities WHERE id='entity_mid'`).run();
  const liveRowids = seed.prepare(`SELECT rowid FROM entities ORDER BY rowid`).all().map(r => r.rowid);
  assert.deepEqual(liveRowids, [1, 3],
    `fixture must have a real ROWID gap, got ${JSON.stringify(liveRowids)}`);
  seed.close();

  const migMod = await import(`../dist/src/migrations/migrations.js`);
  migMod.setMigrationFaultPoint('roots');
  try { const m = await reopen(dbPath); m.cleanup?.(); } catch { /* 백업만 만들고 실패 */ }
  migMod.setMigrationFaultPoint(null);

  const bakName = readdirSync(d).find(f => f.includes('.v12.bak'));
  assert.ok(bakName, 'no backup produced');
  const restored = new Database(join(d, bakName));
  assert.deepEqual(restored.prepare(`SELECT rowid FROM entities ORDER BY rowid`).all().map(r => r.rowid),
    [1, 3], 'the snapshot renumbered ROWIDs — external-content FTS would be inconsistent');
  restored.exec(`INSERT INTO entities_fts(entities_fts, rank) VALUES('integrity-check', 1)`);

  // 간격 **뒤** 행(rowid 3)의 고유 토큰을 content 테이블과 JOIN 해서 회수한다.
  // rowid 1 만 확인하면 간격 뒤가 깨져도 통과한다.
  const hit = restored.prepare(
    `SELECT e.id FROM entities_fts f JOIN entities e ON e.rowid = f.rowid
     WHERE entities_fts MATCH 'zzuniqueafterzz'`).all();
  assert.deepEqual(hit.map(r => r.id), ['entity_after'],
    'FTS did not resolve the row after the gap through its content rowid');
  const gone = restored.prepare(
    `SELECT COUNT(*) c FROM entities_fts WHERE entities_fts MATCH 'nonexistentxyz'`).get().c;
  assert.equal(gone, 0, 'FTS oracle is vacuous — it matches everything');
  restored.close();
  assert.deepEqual(readdirSync(d).filter(f => f.includes('.partial-')), [],
    'a partial backup file was left behind');
  rmSync(d, { recursive: true, force: true });
  console.log('  OK: restored backup keeps the ROWID gap and resolves FTS through it (rank=1)');
}

// --- external-content 가 어긋난 스냅샷은 **발행 전에** 거부된다 ---
// 검증이 실제로 게이트인지 = 틀린 것을 거부하는지를 본다. 이게 없으면 위 대조군은
// "정상 케이스가 정상이다"만 말한다.
{
  const { dir: d, dbPath } = await makeV12Db({ FtsBroken: ['token here'] });
  // 인덱스에 content 없는 rowid 를 심는다 → quick_check ok, rank 없는 검사 통과, rank=1 실패
  const seed = new Database(dbPath);
  seed.prepare(`INSERT INTO entities_fts(rowid, name, observations)
                VALUES (99999, 'ghost', 'ghosttoken')`).run();
  assert.equal(seed.pragma('quick_check', { simple: true }), 'ok',
    'probe must stay structurally valid — that is the point');
  seed.exec(`INSERT INTO entities_fts(entities_fts) VALUES('integrity-check')`);  // rank 없이는 통과
  seed.close();

  let err = null;
  try { const m = await reopen(dbPath); m.cleanup?.(); } catch (e) { err = String(e.message); }
  assert.ok(err, 'a snapshot with an inconsistent external-content index was published');
  assert.match(err, /FTS5 integrity-check/i, `unexpected error: ${err}`);
  // 그리고 아무것도 발행되지 않았고 임시 파일도 남지 않았다
  assert.deepEqual(readdirSync(d).filter(f => f.includes('.bak')), [],
    'a rejected snapshot was published to a slot anyway');
  assert.deepEqual(readdirSync(d).filter(f => f.includes('.partial-')), [],
    'the rejected temp file was left behind');
  rmSync(d, { recursive: true, force: true });
  console.log('  OK: inconsistent external-content snapshot refused before publish');
}

console.log('observation-migration: ALL OK');
