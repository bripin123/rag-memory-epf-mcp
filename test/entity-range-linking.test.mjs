#!/usr/bin/env node
// spec §5.4 (r7-2): fallback 경계에 잘린 entity 이름도 교차 chunk 에 링크된다.
// + finder 직접 검증 (r9: 문서 fixture 는 chunk matcher 로도 녹색이 되므로 무효).
import assert from 'node:assert/strict';
import { get_encoding } from 'tiktoken';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';
import { chunkStructured } from '../dist/src/chunkerC.js';

const { manager, cleanup } = await makeManager();
try {
  installFakeEmbedder(manager);
  await manager.startReconciliation();
  const enc = get_encoding('cl100k_base');
  const NAME = 'SyntheticBoundaryEntity';

  // 결정론적 straddle 배치: 이름 없는 base 의 첫 경계 B 를 재고, 이름이 B 를 가로지르게
  // B-k 에 삽입한다 (r7-2 — 공백 shift 스캔은 관통 불가 실측).
  const filler = 'x'.repeat(6) + ' ';
  const base = filler.repeat(800) + '\n';
  const baseSegs = chunkStructured(base, enc, 200);
  assert.ok(baseSegs.length > 1, 'precondition: base 가 실제로 분할된다');
  const B = baseSegs[0].end_pos;
  const baseCps = [...base];
  // 이름을 공백으로 감싼다 — 삽입점이 filler 토큰 중간이면 이름이 'x' 에 접착돼
  // \b word-boundary 가 성립하지 않는다 (matcher 의미상 올바른 미매치 = fixture 결함).
  let doc = null, nameStart = -1;
  for (let k = 1; k < NAME.length + 2 && !doc; k++) {
    const cand = baseCps.slice(0, B - k).join('') + ' ' + NAME + ' ' + baseCps.slice(B - k).join('');
    const segs = chunkStructured(cand, enc, 200);
    const ns = B - k + 1;
    if (segs.some(s => s.start_pos > ns && s.start_pos < ns + NAME.length)) { doc = cand; nameStart = ns; }
  }
  assert.ok(doc, 'precondition: 경계가 이름을 가로지르는 배치를 찾았다');

  await manager.createEntities([{ name: NAME, entityType: 'TEST', observations: ['ctl'] }]);
  await manager.storeDocument('straddle-doc', doc);
  await manager.chunkDocument('straddle-doc', { maxTokens: 200 });
  // precondition: 어느 단일 chunk.text 에도 이름 전체가 없다 (chunk 단위 매칭이면 0 링크)
  const chunkTexts = manager.db.prepare(`SELECT text FROM chunk_metadata WHERE document_id='straddle-doc'`).all().map(r => r.text);
  assert.ok(chunkTexts.every(t => !t.includes(NAME)), 'precondition: 이름이 실제로 잘려 있다');

  await manager.autoLinkEntities('straddle-doc');
  const n = manager.db.prepare(`SELECT count(*) n FROM chunk_entities ce
    JOIN chunk_metadata m ON m.rowid = ce.chunk_rowid
    JOIN entities e ON e.id = ce.entity_id
    WHERE m.document_id='straddle-doc' AND e.name = ?`).get(NAME).n;
  assert.ok(n >= 2, `range 링킹: 이름과 교차하는 두 chunk 모두 링크 (got ${n})`);

  // [보강 1] word-boundary 보존: 'Data' entity 는 'Database' 문서에 링크되지 않는다
  await manager.createEntities([{ name: 'Data', entityType: 'TEST', observations: [] }]);
  await manager.storeDocument('wb-doc', '## W\nthe Database holds rows\n');
  await manager.chunkDocument('wb-doc');
  await manager.autoLinkEntities('wb-doc');
  assert.equal(manager.db.prepare(`SELECT count(*) n FROM chunk_entities ce JOIN chunk_metadata m ON m.rowid=ce.chunk_rowid
    JOIN entities e ON e.id=ce.entity_id WHERE m.document_id='wb-doc' AND e.name='Data'`).get().n, 0,
    'word-boundary 유지: Database 에 Data 오링크 없음');

  // [보강 2] case-fold 길이 변화: İ 뒤에서도 offset 정확 (문서 레벨)
  await manager.createEntities([{ name: 'DataCore', entityType: 'TEST', observations: [] }]);
  await manager.storeDocument('fold-doc', '## F\nİİİ DataCore appears here\n');
  await manager.chunkDocument('fold-doc');
  await manager.autoLinkEntities('fold-doc');
  assert.ok(manager.db.prepare(`SELECT count(*) n FROM chunk_entities ce JOIN chunk_metadata m ON m.rowid=ce.chunk_rowid
    JOIN entities e ON e.id=ce.entity_id WHERE m.document_id='fold-doc' AND e.name='DataCore'`).get().n >= 1,
    'İ fold(1cp->2u16) 뒤에서도 링크');

  // [보강 3] astral prefix
  await manager.storeDocument('astral-doc', '## A\n🎉🎉🎉 DataCore again\n');
  await manager.chunkDocument('astral-doc');
  await manager.autoLinkEntities('astral-doc');
  assert.ok(manager.db.prepare(`SELECT count(*) n FROM chunk_entities ce JOIN chunk_metadata m ON m.rowid=ce.chunk_rowid
    JOIN entities e ON e.id=ce.entity_id WHERE m.document_id='astral-doc' AND e.name='DataCore'`).get().n >= 1,
    'astral prefix 뒤에서도 링크');

  // [보강 4] 재실행 = INSERT OR IGNORE 멱등
  const before = manager.db.prepare(`SELECT count(*) n FROM chunk_entities`).get().n;
  await manager.autoLinkEntities('astral-doc');
  assert.equal(manager.db.prepare(`SELECT count(*) n FROM chunk_entities`).get().n, before, '재실행 멱등');

  // [보강 5 — r9] finder 직접 검증 (역매핑이 고장나도 문서 fixture 는 통과할 수 있으므로)
  {
    const f1 = manager.buildEntityRangeFinder('İİİ DataCore appears');
    assert.deepEqual(f1('DataCore', false), [{ s: 4, e: 12 }], 'İ(1cp→2u16 fold) 뒤 Latin 좌표 [4,12)');
    const f2 = manager.buildEntityRangeFinder('🎉🎉🎉 DataCore again');
    assert.deepEqual(f2('DataCore', false), [{ s: 4, e: 12 }], 'astral(1cp=2u16) 뒤 Latin 좌표 [4,12)');
    const f3 = manager.buildEntityRangeFinder('漢İ');
    assert.deepEqual(f3('漢i', true), [{ s: 0, e: 2 }], 'mid-expansion exclusive end = [0,2) (r9)');
    const f4 = manager.buildEntityRangeFinder('哈哈哈');
    assert.deepEqual(f4('哈哈', true), [{ s: 0, e: 2 }, { s: 1, e: 3 }], 'CJK 중첩 occurrence 2건 (r9)');
    const f5 = manager.buildEntityRangeFinder('fooİ and fooi here');
    assert.deepEqual(f5('fooi', false), [{ s: 9, e: 13 }], 'fooİ 미매치 — 현행 Latin matcher 의미 보존 (r9)');
  }

  console.log('entity-range-linking: ALL PASS');
} finally { cleanup(); }
