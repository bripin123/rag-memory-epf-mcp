#!/usr/bin/env node
// Observation-derived alias links are gated: the token must look like a filename AND
// identify at most MAX_ALIAS_OWNERS(3) entities.
//
// Why this exists (measured 2026-08-22, 2,891-chunk / 604-entity corpus). Two denominators,
// kept apart on purpose: 65,388 of 66,841 chunk_entities rows (97.8%) existed only because of
// an alias hit; counting distinct (chunk, entity) pairs any alias can reach gives 80,096, and
// against THAT "agents.md" alone is 39,248 (49.0%). It is held by 88 entities. A filename that
// dozens of entities mention is a stopword. The extension whitelist alone leaves 92.3% of
// alias links, so the owner cap is what does the work.
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

  // --- 5. the FIRST blocked value is 4, not 5 -------------------------------------
  // Without this, an implementation using `> 4` would pass the 3-allowed / 5-blocked pair.
  const four = [];
  for (let i = 1; i <= 4; i++) four.push({
    name: `QuadOwnerEntity${i}`, entityType: 'TEST',
    observations: ['described in quad_owner_notes.md'],
  });
  await manager.createEntities(four);
  await manager.storeDocument('alias-gate-doc3', 'A line naming quad_owner_notes.md only.');
  await manager.chunkDocument('alias-gate-doc3', { maxTokens: 200 });
  await manager.embedChunks('alias-gate-doc3');
  for (const e of four)
    assert.equal(links(e.name), 0, `${e.name}: 4 owners is one past the cap and must not link`);

  // --- 6. alias match must respect token boundaries --------------------------------
  // Bare substring matching would link "edge_case.py" to a chunk saying "notedge_case.pyc".
  const edge = { name: 'BoundaryAliasEntity', entityType: 'TEST',
                 observations: ['lives in edge_case.py'] };
  await manager.createEntities([edge]);
  await manager.storeDocument('alias-gate-doc4', 'This mentions notedge_case.pyc and nothing else.');
  await manager.chunkDocument('alias-gate-doc4', { maxTokens: 200 });
  await manager.embedChunks('alias-gate-doc4');
  assert.equal(links(edge.name), 0, 'alias must not match inside a longer filename');
  // control: the same token standing alone DOES link (proves the check is not vacuous)
  await manager.storeDocument('alias-gate-doc5', 'This mentions edge_case.py on its own.');
  await manager.chunkDocument('alias-gate-doc5', { maxTokens: 200 });
  await manager.embedChunks('alias-gate-doc5');
  assert.ok(links(edge.name) > 0, 'control: standalone token must link');

  console.log('✅ alias-link-gate: owner cap + filename whitelist hold, sole-owner intent preserved');
} finally {
  await cleanup();
}
