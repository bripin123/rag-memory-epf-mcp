#!/usr/bin/env node
// spec §7.1 (r4·r5-8): overlap/maxTokens 검증은 두 공개 경로 모두 + dedup 게이트보다 앞.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';

const { manager, dir, cleanup } = await makeManager();
try {
  installFakeEmbedder(manager);
  await manager.startReconciliation();
  const file = join(dir, 'doc.md');
  writeFileSync(file, '# T\n\npara one\n\n## S\npara two\n', 'utf-8');
  await manager.syncDocumentFromFile(file, 'd1', {});

  const badOverlap = [160, -1, 0.5];
  const badMax = [0, -1, 1.5];
  for (const overlap of badOverlap) {
    await assert.rejects(() => manager.chunkDocument('d1', { overlap }), /overlap/, `chunkDocument overlap=${overlap}`);
    // r5-8 핵심: content 가 "동일"해도(=dedup 대상) invalid param 은 거부돼야 한다
    await assert.rejects(() => manager.syncDocumentFromFile(file, 'd1', { chunkParams: { overlap } }), /overlap/, `sync unchanged-content overlap=${overlap}`);
  }
  for (const maxTokens of badMax) {
    await assert.rejects(() => manager.chunkDocument('d1', { maxTokens }), /maxTokens/, `chunkDocument maxTokens=${maxTokens}`);
    await assert.rejects(() => manager.syncDocumentFromFile(file, 'd1', { chunkParams: { maxTokens } }), /maxTokens/, `sync unchanged-content maxTokens=${maxTokens}`);
  }
  await manager.chunkDocument('d1', { overlap: 0 });   // 0 과 생략은 허용
  await manager.chunkDocument('d1');

  const res = await manager.chunkDocument('d1', { maxTokens: 400 });
  for (const c of res.chunks) {
    assert.equal(c.startToken, null, 'startToken NULL for c1');
    assert.equal(c.endToken, null, 'endToken NULL for c1');
    assert.equal(typeof c.startPos, 'number', 'char offsets exact');
  }
  assert.equal(manager.db.prepare(`SELECT chunking_signature FROM documents WHERE id='d1'`).get().chunking_signature,
    'c1:enc=cl100k_base:max=400:overlap=0:fence=on:merge=200:fallback=cp-exact-400', 'chunkDocument stamps signature');
  console.log('chunk-params-validation: ALL PASS');
} finally { cleanup(); }
