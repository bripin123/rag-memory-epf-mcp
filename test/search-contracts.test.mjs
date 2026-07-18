// Search contract verification: eligibility-gated vector usage, searchNodes FTS
// fallback + hybrid-partial merge, hybridSearch envelope with state on empty
// results. Spec §4·§5·§5c, DoD 3(부분)/15(부분).
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeManager, installFakeEmbedder, simulateModelDown } from './helpers/engine-test-db.mjs';

const { manager: mgr, dir } = await makeManager();
mgr.embeddingsMode = 'lazy';
const counter = installFakeEmbedder(mgr);
const db = mgr.db;

// Fixture: two entities + one synced doc, all embedded (fake gate ready).
await mgr.createEntities([
  { name: 'Quantum Widget', entityType: 'CONCEPT', observations: ['quantum widget observations'] },
  { name: 'Plasma Gadget', entityType: 'CONCEPT', observations: ['plasma gadget observations'] },
]);
await mgr.syncDocumentFromFile('/x.md', 'd1', { content: 'quantum widget document body with searchable words' });
await mgr.startReconciliation(); // fresh rows -> n/a
assert.equal(mgr.coordinator.reconState, 'n/a');

// (a) eligible + full coverage -> hybrid envelope
{
  const res = await mgr.hybridSearch('quantum widget', 3, false);
  assert.ok(Array.isArray(res.results), 'envelope.results missing');
  assert.equal(res.search_mode, 'hybrid');
  assert.equal(res.model_state, 'ready');
  assert.equal(res.coverage.chunk_pct, 100);
  console.log('  OK: hybridSearch envelope (hybrid, coverage 100)');
}

// (b) searchNodes eligible path carries state fields
{
  const res = await mgr.searchNodes('quantum widget', 5);
  assert.ok(res.entities.length >= 1);
  assert.equal(res.search_mode, 'hybrid');
  assert.equal(res.coverage.entity_pct, 100);
  console.log('  OK: searchNodes hybrid + state fields');
}

// (c) not eligible -> fts-only + degradation_reason, empty results still typed
{
  simulateModelDown(mgr);
  const res = await mgr.searchNodes('quantum', 5);
  assert.equal(res.search_mode, 'fts-only');
  assert.equal(res.degradation_reason, 'model_not_ready');
  assert.ok(res.entities.some(e => e.name === 'Quantum Widget'), 'FTS fallback missed lexical hit');
  const hy = await mgr.hybridSearch('quantum', 3, false);
  assert.equal(hy.search_mode, 'fts-only');
  assert.equal(hy.degradation_reason, 'model_not_ready');
  assert.ok(hy.results.length >= 1, 'hybrid FTS-only found nothing');
  const empty = await mgr.hybridSearch('zzz-no-match-term', 3, false);
  assert.equal(empty.results.length, 0);
  assert.equal(empty.search_mode, 'fts-only', 'empty result lost state');
  console.log('  OK: fts-only fallback + reason + stateful empty result');
}

// (d) unsearchable query -> warning, no error
{
  const res = await mgr.searchNodes('(())**--""', 5);
  assert.equal(res.entities.length, 0);
  assert.ok(res.warning, 'warning missing for unsearchable query');
  console.log('  OK: unsearchable query -> empty + warning');
}

// (e) hybrid-partial: one entity loses its vector -> merged lexical hit + label
{
  mgr.gate.state = 'ready';
  mgr.gate.embedFn = async (text) => { const v = new Float32Array(1024); for (let i = 0; i < text.length; i++) v[i % 1024] += text.charCodeAt(i) / 1000; return v; };
  mgr.invalidateEntityVector('entity_plasma_gadget');   // vectorless but should stay findable
  mgr.coordinator.invalidateCoverage();
  const res = await mgr.searchNodes('plasma gadget', 5);
  assert.equal(res.search_mode, 'hybrid-partial', `expected hybrid-partial, got ${res.search_mode}`);
  assert.ok(res.entities.some(e => e.name === 'Plasma Gadget'), 'vectorless entity vanished from search');
  assert.ok(res.coverage.entity_pct < 100);
  console.log('  OK: hybrid-partial merges lexical hits for vectorless entities');
}

mgr.cleanup();
rmSync(dir, { recursive: true, force: true });
console.log('SEARCH-CONTRACTS OK');
