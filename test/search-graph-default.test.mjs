// hybridSearch graph default contract (v5.3.0): the knowledge-graph re-ranker is OPT-IN.
//
// Why: measured 2026-08-17 on three real corpora (self-retrieval, 120 samples each, summaries off):
// with graph on, the known-item chunk got WORSE in 46/49/52 samples and BETTER in 3/2/0
// (paired sign test p < 7e-11 on each corpus); 106 targets fell out of the top-10 entirely.
// The additive boost (0.5^i decay, cap 0.4) attaches to entity-link count, so heavily-linked
// archives outrank the exact chunk even at vector_similarity 0. Until the graph has a validated
// role (candidate generation / intent-gated re-ranking, measured on a graph-required suite), the
// safe default is off; callers who want relationship exploration pass useGraph: true explicitly.
//
// Contract pinned here:
//   1. manager.hybridSearch(q, limit)            === manager.hybridSearch(q, limit, false)  (same order, no graph_boost)
//   2. manager.hybridSearch(q, limit, true)      still applies the graph path (graph_boost present)
//   3. tool schema default (zod + JSON) is false, and validateToolArgs fills useGraph: false
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeManager, installFakeEmbedder } from './helpers/engine-test-db.mjs';

const { manager: mgr, dir } = await makeManager();
mgr.embeddingsMode = 'lazy';
installFakeEmbedder(mgr);
const { validateToolArgs, getAllMCPTools, getToolDefinition } = await import('../dist/src/tools/tool-registry.js');

// Fixture: entities linked to a document so the graph path has something to boost.
await mgr.createEntities([
  { name: 'Quantum Widget', entityType: 'CONCEPT', observations: ['quantum widget observations'] },
  { name: 'Plasma Gadget', entityType: 'CONCEPT', observations: ['plasma gadget observations'] },
]);
await mgr.createRelations([{ from: 'Quantum Widget', to: 'Plasma Gadget', relationType: 'RELATED_TO' }]);
await mgr.syncDocumentFromFile('/a.md', 'da', { content: 'quantum widget document body with searchable words about widgets' });
await mgr.syncDocumentFromFile('/b.md', 'db', { content: 'plasma gadget document body with searchable words about gadgets' });
await mgr.startReconciliation();

const ids = (res) => res.results.map(r => r.chunk_id);

// (1) default === explicit false
{
  const dflt = await mgr.hybridSearch('quantum widget', 5);
  const off = await mgr.hybridSearch('quantum widget', 5, false);
  assert.equal(dflt.search_mode, 'hybrid');
  assert.deepEqual(ids(dflt), ids(off), 'default ranking must equal explicit useGraph:false');
  assert.ok(dflt.results.length >= 1, 'fixture returned nothing');
  for (const r of dflt.results) assert.equal(r.graph_boost, undefined, 'default path must not carry graph_boost');
  console.log('  OK: hybridSearch default === useGraph:false (same order, no graph_boost)');
}

// (2) opt-in true still runs the graph path
{
  const on = await mgr.hybridSearch('quantum widget', 5, true);
  assert.equal(on.search_mode, 'hybrid');
  assert.ok(on.results.length >= 1);
  for (const r of on.results) assert.equal(typeof r.graph_boost, 'number', 'opt-in path must expose graph_boost');
  console.log('  OK: hybridSearch useGraph:true keeps the graph path (graph_boost numeric)');
}

// (3) tool contract: schema default false, validateToolArgs fills false, MCP exposure says false
{
  const def = getToolDefinition('hybridSearch');
  assert.ok(def, 'hybridSearch tool missing from registry');
  assert.equal(def.capability.parameters.properties.useGraph.default, false, 'JSON parameters default must be false');
  const validated = validateToolArgs('hybridSearch', { query: 'x' });
  assert.equal(validated.useGraph, false, 'validateToolArgs must default useGraph to false');
  const mcp = getAllMCPTools().find(t => t.name === 'hybridSearch');
  assert.ok(mcp, 'hybridSearch not exposed over MCP');
  assert.equal(mcp.inputSchema.properties.useGraph.default, false, 'MCP inputSchema default must be false');
  const desc = String(mcp.description);
  assert.ok(/opt-in/i.test(desc), 'description must state that graph enhancement is opt-in');
  assert.ok(!/most powerful search tool/i.test(desc), 'description must not keep the unmeasured "most powerful" claim');
  console.log('  OK: tool contract (schema/JSON/MCP default false, opt-in described)');
}

mgr.cleanup();
rmSync(dir, { recursive: true, force: true });
console.log('search-graph-default: ALL OK');
