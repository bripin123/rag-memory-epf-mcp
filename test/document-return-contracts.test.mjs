#!/usr/bin/env node
// storeDocument 반환 계약 + syncDocumentFromFile excludePattern.
// 유래: 2026-08-05 deployed #19 실사용 평가 — "storeDocument 가 {stored:true} 만 줘서
// 무엇을 날렸는지 반환값으로 몰랐다". cleanupDocument 는 이미 삭제 수를 세면서 void 로 버리고 있었다.
// 케이스는 순차 실행 — 각 케이스가 상태를 만든다.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';

const { manager, dir, cleanup } = await makeManager();

try {
  installFakeEmbedder(manager);
  const db = manager.db;

  // [1] 신규 저장은 아무것도 대체하지 않는다 — replaced=false, deletedChunks=0.
  {
    const r = await manager.storeDocument('d-new', 'alpha body', {});
    assert.equal(r.stored, true, 'stored');
    assert.equal(r.replaced, false, '신규는 replaced=false');
    assert.equal(r.deletedChunks, 0, '신규는 지운 chunk 0');
    console.log('  OK: 신규 storeDocument 는 replaced=false / deletedChunks=0');
  }

  // [2] 기존 문서를 덮어쓰면 지운 chunk 수를 반환한다.
  //     이게 이 파일의 본론이다 — 지금까지는 조용히 지우고 {stored:true} 만 돌려줬다.
  {
    await manager.chunkDocument('d-new', { maxTokens: 80 });
    const before = db.prepare(`SELECT count(*) AS n FROM chunk_metadata WHERE document_id='d-new'`).get().n;
    assert.ok(before > 0, `사전 조건: chunk 가 있어야 한다 (실측 ${before})`);

    const r = await manager.storeDocument('d-new', 'alpha body v2', {});
    assert.equal(r.replaced, true, '기존 문서를 덮어썼으면 replaced=true');
    assert.equal(r.deletedChunks, before, `지운 chunk 수를 그대로 반환 (기대 ${before})`);
    console.log(`  OK: 대체 storeDocument 는 replaced=true / deletedChunks=${before}`);
  }

  // [3] chunk 가 없던 문서를 덮어써도 대체는 대체다 (replaced 판정 근거는 chunk 가 아니라 document row).
  {
    await manager.storeDocument('d-bare', 'first', {});
    const r = await manager.storeDocument('d-bare', 'second', {});
    assert.equal(r.replaced, true, 'chunk 0 이어도 document row 가 있었으면 replaced=true');
    assert.equal(r.deletedChunks, 0, '지울 chunk 는 없었다');
    console.log('  OK: chunk 0 인 문서의 대체도 replaced=true / deletedChunks=0');
  }

  // ---- excludePattern -------------------------------------------------------

  // [4] 제외 구간은 색인되지 않는다.
  {
    const file = join(dir, 'ex.md');
    writeFileSync(file, 'keep-alpha\n<!-- SECRET -->\ndrop-beta\n<!-- /SECRET -->\nkeep-gamma\n', 'utf-8');
    await manager.syncDocumentFromFile(file, 'd-ex', {
      excludePattern: '<!-- SECRET -->[\\s\\S]*?<!-- /SECRET -->',
    });
    const texts = db.prepare(`SELECT text FROM chunk_metadata WHERE document_id='d-ex'`).all()
      .map((r) => r.text).join('\n');
    assert.ok(texts.includes('keep-alpha') && texts.includes('keep-gamma'), '바깥 내용은 남는다');
    assert.ok(!texts.includes('drop-beta'), '제외 구간 본문이 색인에 없다');
    console.log('  OK: excludePattern 구간이 색인에서 빠진다');
  }

  // [5] 패턴만 바꿔도 재색인된다 — hash 지름길이 "실제 색인한 텍스트" 기준이어야 한다.
  //     원본 파일 기준으로 해싱하면 패턴을 바꿔도 unchanged 로 조용히 넘어간다.
  {
    const file = join(dir, 'ex.md');
    const r = await manager.syncDocumentFromFile(file, 'd-ex', {}); // 같은 파일, 패턴 없음
    assert.notEqual(r.reason, 'unchanged', '패턴이 달라졌으면 unchanged 지름길로 빠지면 안 된다');
    const texts = db.prepare(`SELECT text FROM chunk_metadata WHERE document_id='d-ex'`).all()
      .map((r) => r.text).join('\n');
    assert.ok(texts.includes('drop-beta'), '패턴을 빼면 그 내용이 다시 색인된다');
    console.log('  OK: excludePattern 변경이 hash 지름길을 통과하지 못한다');
  }

  // [6] 배열로 여러 구간을 제외한다.
  {
    const file = join(dir, 'ex2.md');
    writeFileSync(file, 'A-keep\nX-drop-one\nB-keep\nY-drop-two\nC-keep\n', 'utf-8');
    await manager.syncDocumentFromFile(file, 'd-ex2', { excludePattern: ['X-drop-one', 'Y-drop-two'] });
    const texts = db.prepare(`SELECT text FROM chunk_metadata WHERE document_id='d-ex2'`).all()
      .map((r) => r.text).join('\n');
    assert.ok(!texts.includes('X-drop-one') && !texts.includes('Y-drop-two'), '두 구간 다 빠진다');
    assert.ok(texts.includes('B-keep'), '사이 내용은 남는다');
    console.log('  OK: excludePattern 배열이 여러 구간을 제외한다');
  }

  // [7] 깨진 정규식은 조용히 무시하지 않고 던진다 (fail-closed).
  //     조용히 무시하면 "제외했다고 믿는데 전문이 색인된" 상태가 된다 — 색인은 유출 경로다.
  {
    const file = join(dir, 'ex3.md');
    writeFileSync(file, 'body\n', 'utf-8');
    await assert.rejects(
      () => manager.syncDocumentFromFile(file, 'd-ex3', { excludePattern: '[unclosed' }),
      /excludePattern/,
      '깨진 정규식은 excludePattern 을 지목하는 에러로 실패해야 한다',
    );
    console.log('  OK: 깨진 excludePattern 은 fail-closed');
  }

  // [8] 도구 스키마 계약 — validateToolArgs 가 excludePattern 을 벗겨내면 안 된다.
  //     CODE_CONTEXT §1: tool-contracts 는 중첩 인자 스키마를 검사하지 않는다. 스키마에
  //     빠진 필드는 조용히 사라지고 매니저는 그것을 못 받는다. 그 구멍을 여기서 막는다.
  {
    const { validateToolArgs } = await import('../dist/src/tools/tool-registry.js');
    const out = validateToolArgs('syncDocumentFromFile', {
      path: '/tmp/x.md', documentId: 'd', excludePattern: ['a', 'b'],
    });
    assert.deepEqual(out.excludePattern, ['a', 'b'], 'excludePattern 이 스키마를 통과해 살아남아야 한다');
    const out2 = validateToolArgs('syncDocumentFromFile', {
      path: '/tmp/x.md', documentId: 'd', excludePattern: 'solo',
    });
    assert.equal(out2.excludePattern, 'solo', '문자열 단일 형태도 통과한다');
    console.log('  OK: excludePattern 이 도구 스키마를 통과한다 (validateToolArgs 생존)');
  }

  console.log('document-return-contracts: all OK');
} finally {
  cleanup();
}
