#!/usr/bin/env node
// `\b` cannot fire when the entity name's own edge is punctuation, so a name like
// "Widget Review (2026-05-27)" was invisible to chunk-level and range-level linking even when
// it appeared verbatim. Measured 2026-08-23 on a live 2,913-chunk corpus: 23 standalone
// occurrences across 13 names were missed. The fix requires both neighbours to be non-word,
// so it is not a widening — "Data" still must not match inside "Database".
import assert from 'node:assert/strict';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';

const { manager, cleanup } = await makeManager();
try {
  installFakeEmbedder(manager);
  await manager.startReconciliation();
  const links = (name) => manager.db.prepare(
    `SELECT COUNT(*) c FROM chunk_entities ce JOIN entities e ON e.id = ce.entity_id WHERE e.name = ?`
  ).get(name).c;

  const PAREN = 'Widget Review (2026-05-27)';        // edge is ')' — \b can never assert here
  const DASH  = '--build-flag';                      // edge is '-' on the left
  const PLAIN = 'Database';                          // control for the non-widening claim
  const SHORT = 'Data';                              // must NOT match inside "Database"
  await manager.createEntities([PAREN, DASH, PLAIN, SHORT].map(name =>
    ({ name, entityType: 'TEST', observations: ['ctl'] })));

  const doc = [
    `The note "${PAREN}" is cited here.`,            // quoted -> both neighbours non-word
    `We pass ${DASH} to the builder.`,
    `The Database holds rows.`,                      // contains "Data" as a prefix only
  ].join('\n\n');
  await manager.storeDocument('boundary-doc', doc);
  await manager.chunkDocument('boundary-doc', { maxTokens: 200 });
  await manager.embedChunks('boundary-doc');

  assert.ok(links(PAREN) > 0, 'name ending in ) must link when it appears verbatim');
  assert.ok(links(DASH)  > 0, 'name starting with - must link when it appears verbatim');
  assert.ok(links(PLAIN) > 0, 'control: ordinary name still links');
  assert.equal(links(SHORT), 0, 'NOT a widening: "Data" must not match inside "Database"');

  // range path must agree with the chunk path — a name split by a chunk boundary is out of
  // scope here, but the two matchers must at least not disagree on the same document.
  const finder = manager.buildEntityRangeFinder
    ? manager.buildEntityRangeFinder(doc)
    : null;
  if (finder) {
    assert.ok(finder(PAREN, false).length > 0, 'range finder must see the parenthesised name');
    assert.equal(finder(SHORT, false).length, 0, 'range finder must not widen either');
  }

  console.log('✅ entity-name-boundary: punctuation-edged names link, no widening');
} finally {
  await cleanup();
}
