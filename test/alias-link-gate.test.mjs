#!/usr/bin/env node
// Observation-derived alias links are gated: the token must look like a filename AND
// identify at most MAX_ALIAS_OWNERS(3) entities.
//
// Why this exists (measured 2026-08-22, 2,891-chunk corpus): ungated, 97.8% of all
// chunk_entities rows came from alias hits and two tokens — "agents.md" (88 owners) and
// "gotchas.md" (64) — produced 50.5% of them. A filename dozens of entities mention is a
// stopword. The extension whitelist alone leaves 92.3%; the owner cap is what does the work.
import assert from 'node:assert/strict';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';

const { manager, cleanup } = await makeManager();
try {
  installFakeEmbedder(manager);
  await manager.startReconciliation();

  const links = (name) => manager.db.prepare(
    `SELECT COUNT(*) c FROM chunk_entities ce JOIN entities e ON e.id = ce.entity_id WHERE e.name = ?`
  ).get(name).c;

  // --- 1. shared token (> 3 owners) must not link ---------------------------------
  // 5 entities all mention shared_widget.py in observations; none has its name in the doc.
  const shared = [];
  for (let i = 1; i <= 5; i++) shared.push({
    name: `SharedOwnerEntity${i}`, entityType: 'TEST',
    observations: [`touches shared_widget.py during setup`],
  });
  // --- 2. sole-owner token (1 owner) must still link (the original, working intent) --
  const solo = { name: 'SoleOwnerEntity', entityType: 'TEST',
                 observations: ['implemented in uniquely_named_helper.py'] };
  // --- 3. non-filename tokens must never link --------------------------------------
  const verEnt = { name: 'VersionTokenEntity', entityType: 'TEST',
                   observations: ['pinned at v3.3 and gpt-5.6, size 1.7mb, see github.com'] };
  await manager.createEntities([...shared, solo, verEnt]);

  const doc = [
    'This paragraph mentions shared_widget.py in passing.',
    'This one mentions uniquely_named_helper.py in passing.',
    'This one mentions v3.3 and gpt-5.6 and 1.7mb and github.com in passing.',
  ].join('\n\n');
  await manager.storeDocument('alias-gate-doc', doc);
  await manager.chunkDocument('alias-gate-doc', { maxTokens: 200 });
  await manager.embedChunks('alias-gate-doc');   // autoLinkEntities runs here, not in chunkDocument

  // precondition: no entity NAME appears in the document (so every link must be alias-borne)
  const texts = manager.db.prepare(
    `SELECT text FROM chunk_metadata WHERE document_id='alias-gate-doc'`).all().map(r => r.text);
  for (const e of [...shared, solo, verEnt])
    assert.ok(texts.every(t => !t.includes(e.name)),
      `precondition: entity name ${e.name} must not appear literally`);

  for (const e of shared)
    assert.equal(links(e.name), 0, `${e.name}: token shared by 5 entities must not link`);
  assert.ok(links(solo.name) > 0, 'sole-owner filename alias must still link (intended behaviour)');
  assert.equal(links(verEnt.name), 0, 'version/size/domain tokens must not link');

  // --- 4. the gate is a cap, not a ban: exactly 3 owners still links ---------------
  const three = [];
  for (let i = 1; i <= 3; i++) three.push({
    name: `TripleOwnerEntity${i}`, entityType: 'TEST',
    observations: ['configured by triple_owner_config.toml'],
  });
  await manager.createEntities(three);
  await manager.storeDocument('alias-gate-doc2', 'A line naming triple_owner_config.toml only.');
  await manager.chunkDocument('alias-gate-doc2', { maxTokens: 200 });
  await manager.embedChunks('alias-gate-doc2');
  for (const e of three)
    assert.ok(links(e.name) > 0, `${e.name}: 3 owners is at the cap and must still link`);

  console.log('✅ alias-link-gate: owner cap + filename whitelist hold, sole-owner intent preserved');
} finally {
  await cleanup();
}
