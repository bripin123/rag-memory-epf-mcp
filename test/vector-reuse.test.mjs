#!/usr/bin/env node
// spec §5.2/§5.3: 벡터 재사용 5조건 매트릭스(각 단독 위반) + 반환 계약 3분기 + CAS +
// failure predicate + byteOffset 순수 helper. 케이스는 순차 실행 — 각 케이스가 상태를 만든다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';

const { manager, dir, cleanup } = await makeManager();
const sha = (s) => createHash('sha256').update(s).digest('hex');
const fakeVec = (seed) => { const f = new Float32Array(1024); f[0] = seed; return Buffer.from(f.buffer); };

try {
  const counter = installFakeEmbedder(manager);
  await manager.startReconciliation();
  const db = manager.db;
  const file = join(dir, 'doc.md');
  // r11 병합 규칙: 절이 merge 최소치(400tk) 미만이면 이웃과 병합된다. 이 테스트는
  // A/B/C 가 별개 chunk 여야 하므로 각 절을 패딩으로 ≥ 400tk 로 유지한다.
  const PAD = 'pad '.repeat(440);
  const V1 = `## A\nalpha body ${PAD}\n\n## B\nbeta body ${PAD}\n\n## C\ngamma body ${PAD}\n`;
  writeFileSync(file, V1, 'utf-8');
  await manager.syncDocumentFromFile(file, 'd1', {});

  const rows = () => db.prepare(`SELECT rowid, text FROM chunk_metadata WHERE document_id='d1' ORDER BY chunk_index`).all();
  // 전 행을 "재사용 가능" 정상 상태로 (조건 1~5 충족)
  const makeReusable = (provenance = 'verified') => {
    for (const r of rows()) {
      db.prepare(`UPDATE chunk_metadata SET input_hash=?, profile_id=?, provenance_state=? WHERE rowid=?`)
        .run(sha(r.text), manager.currentProfileId, provenance, r.rowid);
      db.exec(`DELETE FROM chunks WHERE rowid = ${r.rowid}`);
      db.prepare(`INSERT INTO chunks (rowid, embedding) VALUES (${r.rowid}, ?)`).run(fakeVec(r.rowid));
    }
  };
  const syncEdited = (marker) => {
    writeFileSync(file, V1.replace('beta body', `beta ${marker}`), 'utf-8');
    return manager.syncDocumentFromFile(file, 'd1', {});
  };

  // [1] 정상 재사용 + 합산식 + dense index + token NULL
  makeReusable();
  counter.calls = 0;
  const r1 = await syncEdited('CHANGED-1');
  assert.equal(r1.reusedChunks, 2, 'A·C 재사용');
  assert.equal(r1.newlyEmbeddedChunks, 1, 'B 만 재임베딩');
  assert.equal(r1.reusedChunks + r1.newlyEmbeddedChunks + r1.queuedChunks, r1.chunks, 'chunks 합산식');
  assert.equal(r1.embeddedChunks, r1.reusedChunks + r1.newlyEmbeddedChunks, 'embeddedChunks 합산식');
  assert.equal(r1.deletedChunks, 3, 'deletedChunks = pre-state 수');
  assert.equal(r1.chunkerTransitioned, false, 'c1 -> c1');
  assert.equal(counter.calls, r1.newlyEmbeddedChunks, 'cache miss 만 임베딩');
  const idx = db.prepare(`SELECT chunk_index FROM chunk_metadata WHERE document_id='d1' ORDER BY chunk_index`).all().map(r => r.chunk_index);
  assert.deepEqual(idx, idx.map((_, i) => i), 'dense 0..n-1');
  assert.equal(db.prepare(`SELECT count(*) n FROM chunk_metadata WHERE document_id='d1' AND (start_token IS NOT NULL OR end_token IS NOT NULL)`).get().n, 0, 'token offsets NULL');
  const aRow1 = db.prepare(`SELECT m.provenance_state FROM chunk_metadata m JOIN chunks c ON c.rowid=m.rowid WHERE m.document_id='d1' AND m.text LIKE '%alpha body%'`).get();
  assert.equal(aRow1.provenance_state, 'verified', 'verified 승계');

  // [2] 조건 1 단독 위반: A 행만 벡터 삭제 + B 편집 -> reused=1(C), newlyEmbedded=2(A,B)
  makeReusable();
  const alphaRow = rows().find(r => r.text.includes('alpha body'));
  db.exec(`DELETE FROM chunks WHERE rowid = ${alphaRow.rowid}`);
  counter.calls = 0;
  const r2 = await syncEdited('CHANGED-2');
  assert.equal(r2.reusedChunks, 1, 'vectorless(A)·edited(B) 제외 = C 만 재사용');
  assert.equal(r2.newlyEmbeddedChunks, 2, 'A(벡터 부재) + B(편집) 재임베딩');

  // [3] 조건 2 단독 위반: 전 행 input_hash 오염 -> reused 0
  makeReusable();
  for (const r of rows()) db.prepare(`UPDATE chunk_metadata SET input_hash='deadbeef' WHERE rowid=?`).run(r.rowid);
  const r3 = await syncEdited('CHANGED-3');
  assert.equal(r3.reusedChunks, 0, 'hash 불일치 -> 전량 재임베딩');

  // [4] 조건 3 단독 위반: gamma 의 input_hash 는 원문 hash 그대로, text 만 훼손 ->
  //     후보는 hash 로 잡히지만 exact-text 최종판정이 기각 -> gamma 신규 임베딩
  makeReusable();
  const gRow = rows().find(r => r.text.includes('gamma body'));
  db.prepare(`UPDATE chunk_metadata SET text = text || ' [tampered]' WHERE rowid=?`).run(gRow.rowid);
  const r4 = await syncEdited('CHANGED-4');
  const gammaVec = db.prepare(`SELECT c.embedding FROM chunk_metadata m JOIN chunks c ON c.rowid=m.rowid
    WHERE m.document_id='d1' AND m.text LIKE '%gamma body%'`).get();
  assert.ok(Buffer.compare(Buffer.from(gammaVec.embedding), fakeVec(gRow.rowid)) !== 0,
    'text 불일치 후보 기각 -> 옛 벡터가 아니라 신규 임베딩');

  // [5] 조건 4 단독 위반: profile 오염 -> reused 0
  makeReusable();
  for (const r of rows()) db.prepare(`UPDATE chunk_metadata SET profile_id = profile_id + 999 WHERE rowid=?`).run(r.rowid);
  const r5 = await syncEdited('CHANGED-5');
  assert.equal(r5.reusedChunks, 0, '구프로필 배제 (차원 동일해도)');

  // [6] 조건 5 단독 위반: provenance NULL -> reused 0
  makeReusable();
  for (const r of rows()) db.prepare(`UPDATE chunk_metadata SET provenance_state=NULL WHERE rowid=?`).run(r.rowid);
  const r6 = await syncEdited('CHANGED-6');
  assert.equal(r6.reusedChunks, 0, 'NULL provenance 제외 (reconciliation 소유)');

  // [7] legacy_assumed 승계 (승격 금지)
  makeReusable('legacy_assumed');
  const r7 = await syncEdited('CHANGED-7');
  assert.ok(r7.reusedChunks >= 1, 'legacy_assumed 재사용 가능');
  assert.ok(db.prepare(`SELECT count(*) n FROM chunk_metadata WHERE document_id='d1' AND provenance_state='legacy_assumed'`).get().n >= 1,
    '복사는 검증이 아니다 — legacy_assumed 승계');

  // [8] 동일 전문 다회 출현 (r6-4: 실제로 동일한 chunk 전문이 나오는 fixture)
  // 각 절 ≥ 400tk (r11 병합 억제) — X 두 절은 byte-동일 유지.
  const DUP = `## X\nsame paragraph body ${PAD}\n\n## X\nsame paragraph body ${PAD}\n\n## Z\nend ${PAD}\n`;
  writeFileSync(file, DUP, 'utf-8');
  await manager.syncDocumentFromFile(file, 'd1', {});
  const dupTexts = db.prepare(`SELECT text FROM chunk_metadata WHERE document_id='d1' ORDER BY chunk_index`).all().map(r => r.text);
  assert.equal(dupTexts[0], dupTexts[1], 'precondition: 두 chunk 전문이 실제로 동일');
  makeReusable();
  writeFileSync(file, DUP + '## W\ntail\n', 'utf-8');
  await manager.syncDocumentFromFile(file, 'd1', {});
  const dupVecs = db.prepare(`SELECT c.embedding FROM chunk_metadata m JOIN chunks c ON c.rowid=m.rowid
    WHERE m.document_id='d1' AND m.chunk_index IN (0,1) ORDER BY m.chunk_index`).all();
  assert.equal(Buffer.compare(Buffer.from(dupVecs[0].embedding), Buffer.from(dupVecs[1].embedding)), 0,
    '동일 전문 두 occurrence 에 같은 벡터 복사');

  // [9] legacy-unknown + 동일 content -> 재-chunk 하지 않는다 (spec §5.1)
  db.prepare(`UPDATE documents SET chunking_signature='legacy-unknown' WHERE id='d1'`).run();
  const before9 = db.prepare(`SELECT count(*) n FROM chunk_metadata WHERE document_id='d1'`).get().n;
  const r9 = await manager.syncDocumentFromFile(file, 'd1', {});
  assert.equal(r9.skipped, true, 'signature 불일치 단독은 트리거 아님');
  assert.equal(db.prepare(`SELECT chunking_signature FROM documents WHERE id='d1'`).get().chunking_signature, 'legacy-unknown', '관측 상태 유지');
  assert.equal(db.prepare(`SELECT count(*) n FROM chunk_metadata WHERE document_id='d1'`).get().n, before9, 'chunk 불변');

  // [10] chunkerTransitioned=true: legacy 문서의 content 변경
  writeFileSync(file, DUP + '## W\ntail\n\n## V\nnew section\n', 'utf-8');
  const r10 = await manager.syncDocumentFromFile(file, 'd1', {});
  assert.equal(r10.chunkerTransitioned, true, 'legacy-unknown -> c1 전환 보고');

  // [11] full-skip / revectorizing 의 additive 필드
  const r11a = await manager.syncDocumentFromFile(file, 'd1', {});
  assert.deepEqual(
    [r11a.reusedChunks, r11a.newlyEmbeddedChunks, r11a.queuedChunks, r11a.deletedChunks, r11a.chunkerTransitioned],
    [0, 0, 0, 0, false], 'full-skip additive 필드');
  db.exec('DELETE FROM chunks');
  const r11b = await manager.syncDocumentFromFile(file, 'd1', {});
  assert.equal(r11b.reason, 'unchanged-revectorizing');
  assert.ok(r11b.queuedChunks > 0 && r11b.reusedChunks === 0 && r11b.deletedChunks === 0, 'revectorizing additive 필드');

  // [12] failure predicate: kind='chunk' 만 지운다
  {
    const pre = db.prepare(`SELECT rowid FROM chunk_metadata WHERE document_id='d1' ORDER BY chunk_index LIMIT 1`).get();
    db.prepare(`INSERT INTO embedding_backfill_failures (kind, target_id, attempts, last_error) VALUES ('chunk', ?, 3, 'x')`).run(String(pre.rowid));
    db.prepare(`INSERT INTO embedding_backfill_failures (kind, target_id, attempts, last_error) VALUES ('entity', ?, 3, 'x')`).run(String(pre.rowid));
    const content = db.prepare(`SELECT content FROM documents WHERE id='d1'`).get().content;
    writeFileSync(file, content + '\nfailure-case\n', 'utf-8');
    await manager.syncDocumentFromFile(file, 'd1', {});
    assert.equal(db.prepare(`SELECT count(*) n FROM embedding_backfill_failures WHERE kind='chunk' AND target_id=?`).get(String(pre.rowid)).n, 0, 'chunk failure 행 제거');
    assert.equal(db.prepare(`SELECT count(*) n FROM embedding_backfill_failures WHERE kind='entity' AND target_id=?`).get(String(pre.rowid)).n, 1, '같은 숫자 ID 의 entity failure 생존');
  }

  // [13] CAS (r6-3·r7-1: dedup 에 막히지 않게 — DB=v0, 디스크=v1 로 실제 변경을 만든다)
  {
    const { setSyncFaultPoint } = await import('../dist/index.js');
    writeFileSync(file, '## CAS\nversion zero\n', 'utf-8');
    await manager.syncDocumentFromFile(file, 'd1', {});          // DB = version zero
    writeFileSync(file, '## CAS\nversion one\n', 'utf-8');       // 디스크만 변경 (sync 안 함)
    let fired = false;
    setSyncFaultPoint('pre-transaction', () => {
      if (fired) return; fired = true;
      writeFileSync(file, '## CAS\nversion two (changed on disk)\n', 'utf-8');
      db.prepare(`UPDATE documents SET metadata = json_set(metadata, '$.content_hash', 'intruder') WHERE id='d1'`).run();
    });
    try {
      await manager.syncDocumentFromFile(file, 'd1', {});        // full 경로 -> hook -> CAS 재시작
    } finally {
      setSyncFaultPoint(null, null);
    }
    assert.ok(fired, 'fault fired (dedup 에 안 막혔다)');
    const finalDoc = db.prepare(`SELECT content, metadata FROM documents WHERE id='d1'`).get();
    assert.match(finalDoc.content, /version two/, '두 번째 attempt 가 디스크의 새 내용을 다시 읽었다 (r6-3)');
    assert.equal(JSON.parse(finalDoc.metadata).content_hash, sha('## CAS\nversion two (changed on disk)\n'), '최종 hash = 새 파일');
  }

  // [14] byteOffset 순수 helper: 강제 subarray 입력 -> owned copy 증명
  {
    const { selectReusableVector } = await import('../dist/index.js');
    const big = Buffer.alloc(8192, 7); fakeVec(42).copy(big, 4096);
    const sub = big.subarray(4096, 8192);                      // byteOffset=4096 강제
    const hit = selectReusableVector(
      [{ rowid: 1, text: 'T', input_hash: sha('T'), profile_id: manager.currentProfileId, provenance_state: 'verified', embedding: sub }],
      'T', manager.currentProfileId, sha);
    assert.ok(hit, 'candidate accepted');
    assert.equal(hit.vec.byteOffset, 0, 'owned copy: byteOffset 0');
    assert.equal(Buffer.compare(hit.vec, fakeVec(42)), 0, 'owned copy: 올바른 4096B');
  }

  console.log('vector-reuse: ALL PASS');
} finally { cleanup(); }
