// Tool response shape verification across ready / not-ready / disabled states.
// Spec §5c exact shapes: per-item embedding_status, endpoint_embedding_status,
// structured deleteObservations, sync embedding_status, structured gate errors.
import { rmSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeManager, installFakeEmbedder, simulateModelDown } from './helpers/engine-test-db.mjs';
// 버전은 package.json 이 정본이다 (하드코딩하면 minor 마다 무관한 실패가 난다).
const PKG_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const { manager: mgr, dir } = await makeManager();
const { GateNotReadyError, GateDisabledError } = await import('../dist/src/embeddingGate.js');
mgr.embeddingsMode = 'lazy';
installFakeEmbedder(mgr);

// ---- ready state ----------------------------------------------------------
{
  const created = await mgr.createEntities([{ name: 'Shape One', entityType: 'CONCEPT', observations: ['obs'] }]);
  assert.equal(created[0].embedding_status, 'embedded');
  const rels = await mgr.createRelations([{ from: 'Shape One', to: 'Shape Two', relationType: 'RELATED_TO' }]);
  assert.equal(rels.length, 1);
  assert.deepEqual(Object.keys(rels[0].endpoint_embedding_status).sort(), ['from', 'to']);
  assert.equal(rels[0].endpoint_embedding_status.from, 'n/a', 'existing endpoint must be n/a');
  assert.equal(rels[0].endpoint_embedding_status.to, 'embedded', 'new endpoint must report its embed status');
  const added = await mgr.addObservations([{ entityName: 'Shape One', contents: ['more'] }]);
  assert.equal(added[0].embedding_status, 'embedded');
  const del = await mgr.deleteObservations([
    { entityName: 'Shape One', observations: [] },          // no-op
    { entityName: 'Ghost Entity', observations: ['x'] },    // missing entity
  ]);
  assert.equal(del.results.length, 2);
  assert.equal(del.results[0].embedding_status, 'n/a');
  assert.equal(del.results[1].deleted, 0);
  assert.equal(del.total_deleted, 0);
  const sync = await mgr.syncDocumentFromFile('/x', 'sd1', { content: 'shape sync body' });
  assert.equal(sync.embedding_status, 'embedded');
  console.log('  OK: ready-state shapes (per-item, endpoint map, structured delete, sync)');
}

// ---- not-ready state ------------------------------------------------------
{
  simulateModelDown(mgr);
  const created = await mgr.createEntities([{ name: 'Queued Ent', entityType: 'CONCEPT', observations: ['q'] }]);
  assert.equal(created[0].embedding_status, 'queued');
  const rels = await mgr.createRelations([{ from: 'Queued Ent', to: 'Queued Peer', relationType: 'RELATED_TO' }]);
  assert.equal(rels[0].endpoint_embedding_status.to, 'queued');
  const sync = await mgr.syncDocumentFromFile('/x', 'sd2', { content: 'queued sync body' });
  assert.equal(sync.embedding_status, 'queued');
  // explicit embed tools: structured retryable error, no infinite wait
  const err = await mgr.embedChunks('sd2').catch(e => e);
  assert.ok(err instanceof GateNotReadyError, `embedChunks must throw GateNotReadyError, got ${err?.constructor?.name}`);
  assert.equal(err.code, 'MODEL_NOT_READY');
  console.log('  OK: not-ready shapes (queued everywhere, MODEL_NOT_READY on explicit embed)');
}

// ---- disabled state -------------------------------------------------------
{
  mgr.gate.state = 'disabled';
  const created = await mgr.createEntities([{ name: 'Disabled Ent', entityType: 'CONCEPT', observations: ['d'] }]);
  assert.equal(created[0].embedding_status, 'disabled');
  const sync = await mgr.syncDocumentFromFile('/x', 'sd3', { content: 'disabled sync body' });
  assert.equal(sync.embedding_status, 'disabled');
  const err = await mgr.embedAllEntities().catch(e => e);
  assert.ok(err instanceof GateDisabledError, `embedAllEntities must throw GateDisabledError, got ${err?.constructor?.name}`);
  assert.equal(err.code, 'EMBEDDINGS_DISABLED');
  console.log('  OK: disabled shapes (disabled status, EMBEDDINGS_DISABLED on explicit embed)');
}

// ---- stats server block (spec §8-2, T9) -----------------------------------
{
  const stats = await mgr.getKnowledgeGraphStats();
  assert.ok(stats.server, 'server block missing');
  for (const k of ['version', 'node', 'embeddings_mode', 'model', 'model_state', 'reconciliation_state', 'coverage']) {
    assert.ok(k in stats.server, `server.${k} missing`);
  }
  assert.equal(stats.server.version, PKG_VERSION,
    `stats.server.version must equal the package version (${PKG_VERSION})`);
  assert.ok(stats.server.coverage.entity.total >= 1);
  assert.ok('verified' in stats.server.coverage.chunk && 'legacy_assumed' in stats.server.coverage.chunk);
  console.log('  OK: stats server block (version, states, 3-way provenance coverage)');
}

mgr.cleanup();
rmSync(dir, { recursive: true, force: true });
// ---- registry <-> dispatch parity ----------------------------------------
// 등록만 하고 switch 에 case 를 안 넣으면 도구는 목록에 뜨지만 부르면 'Unknown tool' 이고,
// 반대로 case 만 있으면 목록에 안 뜬다. 둘 다 조용히 실패한다 — v13 에서 실제로
// 엔진 메서드 7종이 도구로 노출되지 않은 채 통과했다. 여기서 기계로 묶는다.
{
  const { getToolsByCategory, getAllMCPTools } = await import('../dist/src/tools/tool-registry.js');

  const src = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
  const cases = new Set([...src.matchAll(/case\s+"([A-Za-z][A-Za-z0-9_]*)":/g)].map(m => m[1]));
  const registered = new Set(getToolsByCategory().all);

  const missingCase = [...registered].filter(n => !cases.has(n));
  const orphanCase = [...cases].filter(n => !registered.has(n));
  assert.deepEqual(missingCase, [], `registered tools with no dispatch case: ${missingCase.join(', ')}`);
  assert.deepEqual(orphanCase, [], `dispatch cases for unregistered tools: ${orphanCase.join(', ')}`);

  // 모든 도구가 유효한 MCP inputSchema 를 낸다 (빈 properties 로 통과하지 못하게)
  for (const t of getAllMCPTools()) {
    assert.ok(t.name && t.description, `tool ${t.name}: missing name/description`);
    assert.equal(t.inputSchema.type, 'object', `tool ${t.name}: inputSchema.type`);
    assert.ok(t.inputSchema.properties, `tool ${t.name}: no properties`);
    // validateToolArgs 가 strict 이므로 광고 스키마도 그렇게 말해야 한다
    assert.equal(t.inputSchema.additionalProperties, false,
      `tool ${t.name}: strict validation is not advertised`);
  }

  // 변환기 fallback 이 하나라도 발동하면 광고 스키마가 실제 입력과 다르다.
  // ZodEnum·ZodLiteral·ZodUnion 이 전부 이 경로로 새고 있었고(type:'string' 으로 광고),
  // 그러면 클라이언트가 정상 호출을 만들 수 없거나 서버가 거부한다.
  {
    const warned = [];
    const orig = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try { getAllMCPTools(); } finally { console.warn = orig; }
    assert.deepEqual(warned, [],
      `zod->JSON schema fallback fired, so the advertised contract is wrong:\n${warned.join('\n')}`);
    // 그리고 "(fallback)" 문구가 광고된 설명에 새어 나오지 않는다
    const leaked = JSON.stringify(getAllMCPTools()).match(/\(fallback\)/g) ?? [];
    assert.deepEqual(leaked, [], 'a fallback description leaked into the advertised schema');
  }

  // 버전은 package.json 이 정본이다 (도구 문서가 옛 버전을 말하면 안 된다)
  const { getSystemInfo } = await import('../dist/src/tools/tool-registry.js');
  assert.equal(getSystemInfo().system.version, PKG_VERSION,
    'advertised system version drifted from package.json');

  // enum·literal 이 광고된 스키마에 살아 있는가 (fallback 으로 떨어지면 값 목록이 사라진다)
  const byName = Object.fromEntries(getAllMCPTools().map(t => [t.name, t]));
  assert.deepEqual(byName.correctObservation.inputSchema.properties.change_kind.enum,
    ['correction', 'world_change'], 'ZodEnum lost its values in the advertised schema');
  assert.deepEqual(byName.purgeObservation.inputSchema.properties.confirm.enum, ['PURGE'],
    'ZodLiteral lost its value in the advertised schema');
  assert.deepEqual(byName.purgeObservation.inputSchema.required.sort(), ['confirm', 'observation_id'],
    'purgeObservation must require both args');
  assert.deepEqual(byName.getObservationHistory.inputSchema.required, [],
    'getObservationHistory selectors are all optional (one-of is enforced at runtime)');
  assert.deepEqual(byName.declineObservation.inputSchema.required.sort(), ['observation_id', 'reason'],
    'declineObservation must require a reason');
  assert.deepEqual(byName.retractObservation.inputSchema.required, ['observation_id'],
    'retractObservation reason is optional');

  // nested strict 도 광고돼야 한다. importGraph.data 는 런타임에서 unknown 키를
  // 거부하는데 광고 스키마가 침묵하면 클라이언트는 허용된다고 읽는다(beta r4 P2).
  assert.equal(byName.importGraph.inputSchema.properties.data.additionalProperties, false,
    'importGraph.data is strict at runtime but does not advertise it');
  assert.equal(byName.importGraph.inputSchema.properties.data.properties.entities.items.type,
    'object', 'dump rows must be advertised as objects, not strings');

  console.log(`  OK: registry<->dispatch parity (${registered.size} tools) + enum/literal schemas`);
}

console.log('TOOL-CONTRACTS OK');
