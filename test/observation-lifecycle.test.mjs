// 상태 전이 + writer 계약 + projection. spec §4.4 · §6.1 · §8.2b (T21·T23)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const dir = mkdtempSync(join(tmpdir(), 'rag-obs-life-'));
process.env.DB_FILE_PATH = join(dir, 'test.db');
const { RAGKnowledgeGraphManager } = await import('../dist/index.js');
const mgr = new RAGKnowledgeGraphManager();
await mgr.initialize({ skipModel: true });
const db = mgr.db;

const count = (t, where = '1=1', ...p) =>
  db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${where}`).get(...p).c;
const strip = (s) => s.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '');
const proj = (eid) => JSON.parse(db.prepare(`SELECT observations FROM entities WHERE id=?`).get(eid).observations);

// --- T23: createEntities 반환 exact + 부작용 ---
{
  const out = await mgr.createEntities([
    { name: 'T23', entityType: 'CONCEPT', observations: ['fresh'] }
  ]);
  assert.equal(out[0].name, 'T23');
  assert.equal(out[0].created, true, 'T23: created flag');
  assert.equal(out[0].observation_ids.length, 1, 'T23: ids length != observations length');
  assert.ok(out[0].observation_ids[0], 'T23: new revision id missing');

  // 같은 내용을 다시 → dedup 이므로 null, 신규 revision 0행
  const before = count('entity_observations', `entity_id='entity_t23'`);
  const out2 = await mgr.addObservations([{ entityName: 'T23', contents: ['fresh', 'second'] }]);
  assert.equal(out2[0].observation_ids.length, 2, 'T23: 1:1 length not preserved');
  assert.equal(out2[0].observation_ids[0], null, 'T23: dedup must yield null');
  assert.ok(out2[0].observation_ids[1], 'T23: new content must yield uuid');
  assert.equal(count('entity_observations', `entity_id='entity_t23'`), before + 1,
    'T23: dedup created a revision');
  console.log('  OK: T23 writer return + side effects');
}

// --- provenance 입력 ---
{
  const out = await mgr.addObservations([{
    entityName: 'T23', contents: ['sourced'],
    sources: [{ source_kind: 'document', source_ref: 'doc-1', source_hash: 'abc' }]
  }]);
  const oid = out[0].observation_ids[0];
  const s = db.prepare(`SELECT * FROM observation_sources WHERE observation_id=?`).all(oid);
  assert.equal(s.length, 1);
  assert.equal(s[0].source_kind, 'document');
  assert.equal(s[0].source_ref, 'doc-1');
  assert.equal(s[0].source_hash, 'abc');
  console.log('  OK: provenance input');
}

// --- T13: 같은 content 가 다른 source 로 재등장하면 source link 만 늘어난다 ---
{
  await mgr.createEntities([{ name: 'T13', entityType: 'CONCEPT', observations: [] }]);
  const a = await mgr.addObservations([{ entityName: 'T13', contents: ['same fact'],
    sources: [{ source_kind: 'document', source_ref: 'doc-A' }] }]);
  const oid = a[0].observation_ids[0];
  const revs1 = count('entity_observations', `entity_id='entity_t13'`);
  await mgr.addObservations([{ entityName: 'T13', contents: ['same fact'],
    sources: [{ source_kind: 'document', source_ref: 'doc-B' }] }]);
  assert.equal(count('entity_observations', `entity_id='entity_t13'`), revs1,
    'T13: dedup must not create a new revision');
  assert.equal(count('observation_sources', `observation_id=?`, oid), 2,
    'T13: second source not linked to the existing revision');
  console.log('  OK: T13 same content, new source');
}

// --- projection: active 순서 · retract/restore 왕복 ---
{
  await mgr.createEntities([{ name: 'Proj', entityType: 'CONCEPT', observations: ['a', 'b', 'c'] }]);
  const eid = 'entity_proj';
  assert.deepEqual(proj(eid).map(strip), ['a', 'b', 'c'], 'initial projection');

  const mid = db.prepare(`SELECT observation_id FROM entity_observations
    WHERE entity_id=? AND projection_order=1`).get(eid).observation_id;
  await mgr.retractObservation(mid, 'test');
  assert.deepEqual(proj(eid).map(strip), ['a', 'c'], 'projection after retract');

  await mgr.restoreObservation(mid, 'test');
  assert.deepEqual(proj(eid).map(strip), ['a', 'b', 'c'], 'projection after restore (order preserved)');
  console.log('  OK: projection follows active rows');
}

// --- entity vector 무효화 ---
{
  const eid = 'entity_proj';
  db.prepare(`INSERT OR REPLACE INTO entity_embedding_metadata (entity_id, embedding_text)
              VALUES (?, 'stale')`).run(eid);
  const mid = db.prepare(`SELECT observation_id FROM entity_observations
    WHERE entity_id=? AND projection_order=1`).get(eid).observation_id;
  await mgr.retractObservation(mid, 'again');
  assert.equal(count('entity_embedding_metadata', `entity_id=?`, eid), 0,
    'entity vector not invalidated on observation change');
  console.log('  OK: vector invalidation');
}

// --- stale KG chunk 제거 (dormant 경로라 직접 심어서 검증) ---
{
  await mgr.createEntities([{ name: 'KG', entityType: 'CONCEPT', observations: ['kg fact'] }]);
  const eid = 'entity_kg';
  db.prepare(`INSERT INTO chunk_metadata (chunk_id, chunk_type, entity_id, chunk_index, text)
              VALUES ('kgc1','entity',?,0,'stale kg text')`).run(eid);
  assert.equal(count('chunk_metadata', `chunk_type='entity' AND entity_id=?`, eid), 1, 'fixture');
  const oid = db.prepare(`SELECT observation_id FROM entity_observations WHERE entity_id=?`).get(eid).observation_id;
  await mgr.retractObservation(oid, 'kg');
  assert.equal(count('chunk_metadata', `chunk_type='entity' AND entity_id=?`, eid), 0,
    'stale KG chunk not removed on observation change');
  console.log('  OK: stale KG chunk removal');
}

// --- projection_order 는 roots 정본에서 나온다 (retract 된 순번 재사용 금지) ---
{
  await mgr.createEntities([{ name: 'Ord', entityType: 'CONCEPT', observations: ['p0', 'p1'] }]);
  const eid = 'entity_ord';
  const o1 = db.prepare(`SELECT observation_id FROM entity_observations
    WHERE entity_id=? AND projection_order=1`).get(eid).observation_id;
  await mgr.retractObservation(o1, 'free the order');
  const added = await mgr.addObservations([{ entityName: 'Ord', contents: ['p2'] }]);
  const newOrd = db.prepare(`SELECT projection_order FROM entity_observations WHERE observation_id=?`)
    .get(added[0].observation_ids[0]).projection_order;
  assert.equal(newOrd, 2, 'new root must take MAX(roots)+1, not the retracted 1');
  await mgr.restoreObservation(o1, 'back');
  assert.equal(db.prepare(`SELECT status FROM entity_observations WHERE observation_id=?`).get(o1).status,
    'active', 'restore blocked by order reuse');
  console.log('  OK: projection_order from roots (T2d/T2e behaviour)');
}

// --- T21 fixture A : migration/add -> correct -> retract -> restore ---
{
  await mgr.createEntities([{ name: 'T21A', entityType: 'CONCEPT', observations: ['v1'] }]);
  const eid = 'entity_t21a';
  const rid = db.prepare(`SELECT root_id FROM observation_roots WHERE entity_id=?`).get(eid).root_id;

  // ① add
  assert.equal(count('observation_roots', `entity_id=?`, eid), 1, 'A①: roots');
  assert.equal(count('entity_observations', `entity_id=?`, eid), 1, 'A①: revisions');
  assert.equal(count('observation_events', `root_id=?`, rid), 1, 'A①: events');
  assert.equal(db.prepare(`SELECT event FROM observation_events WHERE root_id=?`).get(rid).event, 'add',
    'A①: event literal');

  // ② correct
  const o1 = db.prepare(`SELECT observation_id FROM entity_observations WHERE entity_id=?`).get(eid).observation_id;
  const o2 = await mgr.correctObservation(o1, 'v2 corrected', 'correction', 'was wrong');
  assert.equal(count('observation_roots', `entity_id=?`, eid), 1, 'A②: roots must not grow');
  assert.equal(count('entity_observations', `entity_id=?`, eid), 2, 'A②: revisions');
  assert.equal(count('observation_events', `root_id=?`, rid), 2, 'A②: events');
  assert.equal(db.prepare(`SELECT status FROM entity_observations WHERE observation_id=?`).get(o1).status,
    'superseded', 'A②: predecessor status');
  assert.equal(db.prepare(`SELECT status FROM entity_observations WHERE observation_id=?`).get(o2).status,
    'active', 'A②: successor status');
  const ev = db.prepare(`SELECT * FROM observation_events WHERE root_id=? AND event='correct'`).get(rid);
  assert.ok(ev, 'A②: correct event literal');
  assert.equal(ev.change_kind, 'correction');
  assert.equal(ev.from_id, o1);
  assert.equal(ev.to_id, o2);
  const [pa, pb] = [o1, o2].map(x =>
    db.prepare(`SELECT projection_order FROM entity_observations WHERE observation_id=?`).get(x).projection_order);
  assert.equal(pa, pb, 'A②: projection_order not inherited');

  // ③ retract — revision 증가 없음
  await mgr.retractObservation(o2, 'no longer relevant');
  assert.equal(count('observation_roots', `entity_id=?`, eid), 1, 'A③: roots');
  assert.equal(count('entity_observations', `entity_id=?`, eid), 2, 'A③: retract must not add a revision');
  assert.equal(count('observation_events', `root_id=?`, rid), 3, 'A③: events');
  assert.equal(db.prepare(`SELECT status FROM entity_observations WHERE observation_id=?`).get(o2).status,
    'retracted', 'A③: status');
  assert.ok(db.prepare(`SELECT 1 FROM observation_events WHERE root_id=? AND event='retract'`).get(rid),
    'A③: retract event literal');

  // ④ restore — revision 증가 없음
  await mgr.restoreObservation(o2, 'needed again');
  assert.equal(count('observation_roots', `entity_id=?`, eid), 1, 'A④: roots');
  assert.equal(count('entity_observations', `entity_id=?`, eid), 2, 'A④: restore must not add a revision');
  assert.equal(count('observation_events', `root_id=?`, rid), 4, 'A④: events');
  assert.equal(db.prepare(`SELECT status FROM entity_observations WHERE observation_id=?`).get(o2).status,
    'active', 'A④: status');
  assert.ok(db.prepare(`SELECT 1 FROM observation_events WHERE root_id=? AND event='restore'`).get(rid),
    'A④: restore event literal');
  console.log('  OK: T21 A①②③④');
}

// --- T21 fixture B : provisional -> approve ---
{
  await mgr.createEntities([{ name: 'T21B', entityType: 'CONCEPT', observations: [] }]);
  const out = await mgr.addObservations([
    { entityName: 'T21B', contents: ['maybe true'], status: 'provisional' }
  ]);
  const oid = out[0].observation_ids[0];
  const eid = 'entity_t21b';
  const rid = db.prepare(`SELECT root_id FROM observation_roots WHERE entity_id=?`).get(eid).root_id;

  assert.equal(count('observation_roots', `entity_id=?`, eid), 1, 'B start: roots');
  assert.equal(count('entity_observations', `entity_id=?`, eid), 1, 'B start: revisions');
  assert.equal(count('observation_events', `root_id=?`, rid), 1, 'B start: events');
  assert.equal(db.prepare(`SELECT event FROM observation_events WHERE root_id=?`).get(rid).event, 'add');
  assert.deepEqual(proj(eid), [], 'B: provisional must not appear in projection');

  await mgr.approveObservation(oid, 'verified');
  assert.equal(count('observation_roots', `entity_id=?`, eid), 1, 'B approve: roots must stay 1');
  assert.equal(count('entity_observations', `entity_id=?`, eid), 1, 'B approve: revisions');
  assert.equal(count('observation_events', `root_id=?`, rid), 2, 'B approve: events');
  assert.equal(db.prepare(`SELECT status FROM entity_observations WHERE observation_id=?`).get(oid).status,
    'active', 'B approve: status');
  assert.ok(db.prepare(`SELECT 1 FROM observation_events WHERE root_id=? AND event='approve'`).get(rid),
    'B approve: event literal');
  assert.equal(proj(eid).length, 1, 'B: approved observation must enter the projection');
  console.log('  OK: T21 B provisional/approve');
}

// --- decline ---
{
  const out = await mgr.addObservations([
    { entityName: 'T21B', contents: ['probably false'], status: 'provisional' }
  ]);
  const oid = out[0].observation_ids[0];
  await mgr.declineObservation(oid, 'not true');
  assert.equal(db.prepare(`SELECT status FROM entity_observations WHERE observation_id=?`).get(oid).status,
    'retracted', 'decline -> retracted');
  console.log('  OK: decline');
}

// --- 불법 전이 거부 ---
{
  const sup = db.prepare(`SELECT observation_id FROM entity_observations WHERE status='superseded'`).get().observation_id;
  await assert.rejects(() => mgr.restoreObservation(sup, 'nope'), /superseded/i,
    'superseded must be terminal');
  await assert.rejects(() => mgr.correctObservation(sup, 'x'), /only 'active'/,
    'correct must require active');
  console.log('  OK: illegal transition refused');
}

// --- purgeObservation ---
{
  await mgr.createEntities([{ name: 'Purge', entityType: 'CONCEPT', observations: ['gone soon'] }]);
  const eid = 'entity_purge';
  const oid = db.prepare(`SELECT observation_id FROM entity_observations WHERE entity_id=?`).get(eid).observation_id;

  await assert.rejects(() => mgr.purgeObservation(oid, 'yes'), /PURGE/, 'purge without confirm must reject');
  assert.equal(count('entity_observations', `observation_id=?`, oid), 1);

  const r = await mgr.purgeObservation(oid, 'PURGE');
  assert.equal(r.purged, 1);
  assert.equal(count('entity_observations', `observation_id=?`, oid), 0,
    'purge must physically delete the revision');
  assert.equal(count('observation_roots', `entity_id=?`, eid), 1,
    'purge must keep the root so its projection_order stays reserved');
  const added = await mgr.addObservations([{ entityName: 'Purge', contents: ['next'] }]);
  assert.equal(db.prepare(`SELECT projection_order FROM entity_observations WHERE observation_id=?`)
    .get(added[0].observation_ids[0]).projection_order, 1, 'purged order must not be reused');
  console.log('  OK: purgeObservation');
}

mgr.cleanup?.();
rmSync(dir, { recursive: true, force: true });
console.log('observation-lifecycle: ALL OK');
