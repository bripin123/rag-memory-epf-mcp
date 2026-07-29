// v13 migration: 변환 정확성 + 검증 게이트 + backup preflight.
// spec §5 + §8.2 (T3·T4·T9·T12·T15)
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
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

console.log('observation-migration: ALL OK');
