#!/usr/bin/env node
// spec §7.2: 상호배타 predicate + current+legacy+unknown === documents + boot stamp.
import assert from 'node:assert/strict';
import { makeManager } from './helpers/engine-test-db.mjs';

const { manager, cleanup } = await makeManager();
try {
  const db = manager.db;
  await manager.storeDocument('cur', '# a\nbody\n');            // legacy-unknown (store 는 스탬프 안 함)
  await manager.chunkDocument('cur');                            // -> current (signature 스탬프)
  await manager.storeDocument('leg', 'x\n');                     // legacy-unknown 유지
  await manager.storeDocument('unk1', 'y\n');
  await manager.storeDocument('unk2', 'z\n');
  await manager.storeDocument('unk3', 'w\n');
  db.prepare(`UPDATE documents SET chunking_signature='c9:future-format' WHERE id='unk1'`).run();
  db.prepare(`UPDATE documents SET chunking_signature='c1:enc=cl100k_base:max=400:overlap=0:fence=on:fallback=cp-exact-800' WHERE id='unk2'`).run();
  db.prepare(`UPDATE documents SET chunking_signature='c1:enc=cl100k_base:max=0:overlap=0:fence=on:fallback=cp-exact-0' WHERE id='unk3'`).run();

  const stats = await manager.getKnowledgeGraphStats();
  assert.equal(stats.chunking.current, 1, 'current = chunkDocument 스탬프 1건');
  assert.equal(stats.chunking.legacy, 1, 'legacy = legacy-unknown 1건');
  assert.equal(stats.chunking.unknown, 3, 'unknown = 미인식 3건 (malformed-c1 2종 포함, r5-15)');
  assert.equal(stats.chunking.current + stats.chunking.legacy + stats.chunking.unknown,
    db.prepare(`SELECT count(*) n FROM documents`).get().n, 'partition of documents');
  assert.equal(stats.chunking.default_signature, 'c1:enc=cl100k_base:max=800:overlap=0:fence=on:merge=400:fallback=cp-exact-800');

  // boot upsert (initialize 가 이미 실행됨)
  assert.equal(db.prepare(`SELECT value FROM server_meta WHERE key='current_default_chunker'`).get().value,
    stats.chunking.default_signature, 'boot stamp = 런타임 기본값');
  console.log('stats-chunking: ALL PASS');
} finally { cleanup(); }
