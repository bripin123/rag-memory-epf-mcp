#!/usr/bin/env node
// v5 진단 스위치: RAG_MEMORY_SEARCH_SUMMARIES=off 면 문장별 임베딩(검색당 100+ 추론)이
// 꺼지고 preview 요약 + relevanceScore 0 으로 동작한다. 기본값(on)은 불변.
import assert from 'node:assert/strict';
process.env.RAG_MEMORY_SEARCH_SUMMARIES = 'off';   // makeManager 의 dynamic import 전에
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';

const { manager, dir, cleanup } = await makeManager();
try {
  const counter = installFakeEmbedder(manager);
  await manager.startReconciliation();
  const file = join(dir, 'doc.md');
  writeFileSync(file, '## A\nfirst sentence here. second sentence follows. third one too.\n\n## B\nanother section body.\n', 'utf-8');
  await manager.syncDocumentFromFile(file, 'd1', {});

  counter.calls = 0;
  const r = await manager.hybridSearch('first sentence', 5, true);
  assert.ok(r.results.length >= 1, 'results returned');
  assert.equal(counter.calls, 1, 'summaries off: 쿼리 1회만 임베딩 (문장별 임베딩 0)');
  for (const res of r.results) {
    assert.ok(typeof res.content_summary === 'string' && res.content_summary.length > 0, 'preview summary present');
    // 주의: 응답의 relevance_score 는 최종 hybrid 점수(벡터+부스트)라 0 이 아니다 —
    // 요약 경로 차단의 계약은 위의 "쿼리 1회만 임베딩" assert 가 잠근다.
  }
  console.log('search-summaries-off: ALL PASS');
} finally { cleanup(); }
