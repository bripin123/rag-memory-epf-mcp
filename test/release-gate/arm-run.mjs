#!/usr/bin/env node
// 3-arm 하네스의 child — 한 프로세스 = 한 DB (DB_FILE_PATH 는 모듈 로드 시 고정, r5-1).
// 서브커맨드: build | probe | links | invariants | boost | synthetic | coldreplay
import fs from 'node:fs';
const [cmd, ...args] = process.argv.slice(2);
process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const mod = await import('../../dist/index.js');
const mgr = new mod.RAGKnowledgeGraphManager();
await mgr.initialize();

// r6-1: 검색/임베딩 eligibility = gate ready ∧ reconciliation ∈ {complete, n/a}.
const READY_CMDS = ['build', 'probe', 'boost', 'synthetic', 'coldreplay'];
if (READY_CMDS.includes(cmd)) {
  await mgr.gate.start();
  await mgr.startReconciliation();
  for (let i = 0; i < 600; i++) {
    const st = await mgr.getKnowledgeGraphStats();
    if (st.server.model_state === 'ready' && ['complete', 'n/a'].includes(st.server.reconciliation_state)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const st = await mgr.getKnowledgeGraphStats();
  if (st.server.model_state !== 'ready' || !['complete', 'n/a'].includes(st.server.reconciliation_state)) {
    console.error(`not eligible: model=${st.server.model_state} recon=${st.server.reconciliation_state}`); process.exit(1);
  }
}
const docTop = (r) => r.results.filter(x => x.chunk_type === 'document').map(x => x.source_id);
// r7-4: on/off 양쪽 모두 hybrid 를 assert 하는 공통 래퍼.
const hybrid = async (q, useGraph = true) => {
  const r = await mgr.hybridSearch(q, 5, useGraph);
  if (r.search_mode !== 'hybrid') { console.error(`search_mode=${r.search_mode} (useGraph=${useGraph})`); process.exit(1); }
  return r;
};
const statusMeta = async () => {
  const st = await mgr.getKnowledgeGraphStats();
  return { model_state: st.server.model_state, reconciliation_state: st.server.reconciliation_state,
           coverageMissing: st.server.coverage.chunk.missing };
};

if (cmd === 'build') {
  const ids = args[0] === 'ALL'
    ? mgr.db.prepare(`SELECT id FROM documents ORDER BY id`).all().map(r => r.id)
    : JSON.parse(fs.readFileSync(args[0], 'utf-8')).convert;
  const t0 = Date.now();
  for (const [i, id] of ids.entries()) {
    await mgr.chunkDocument(id);
    await mgr.embedChunks(id);
    console.log(`build ${i + 1}/${ids.length} ${id} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  const st = await mgr.getKnowledgeGraphStats();
  if (st.server.coverage.chunk.missing !== 0) { console.error(`coverage missing=${st.server.coverage.chunk.missing}`); process.exit(1); }
} else if (cmd === 'probe') {
  const self = JSON.parse(fs.readFileSync(args[0], 'utf-8'));
  const known = JSON.parse(fs.readFileSync(args[1], 'utf-8'));
  const results = [];
  for (const p of self) { const r = await hybrid(p.probeText);
    results.push({ probeId: p.probeId, kind: 'self', topDocIds: docTop(r), hit: docTop(r).includes(p.docId) }); }
  for (const p of known) { const r = await hybrid(p.query);
    results.push({ probeId: p.id, kind: 'known', topDocIds: docTop(r), hit: docTop(r).includes(p.expectDocId) }); }
  // r7-4: eligibility·coverage 실측값 저장 — verdict 가 이 값을 소비한다.
  fs.writeFileSync(args[2], JSON.stringify({ meta: await statusMeta(), results }, null, 1));
} else if (cmd === 'links') {
  const perPair = mgr.db.prepare(`SELECT ce.entity_id || '|' || m.document_id AS t, count(*) AS c
    FROM chunk_entities ce JOIN chunk_metadata m ON m.rowid = ce.chunk_rowid
    WHERE m.document_id IS NOT NULL GROUP BY t ORDER BY c`).all();
  // r8-4: LEFT JOIN — 링크 0개 chunk 도 분포에 포함 (inner join 은 [0,0,1] 을 [1] 로 왜곡)
  const perChunk = mgr.db.prepare(`SELECT count(ce.entity_id) AS c FROM chunk_metadata m
    LEFT JOIN chunk_entities ce ON ce.chunk_rowid = m.rowid
    WHERE m.document_id IS NOT NULL GROUP BY m.rowid ORDER BY c`).all().map(r => r.c);
  const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;
  const pairCounts = perPair.map(r => r.c);
  fs.writeFileSync(args[0], JSON.stringify({
    tuples: perPair.map(r => r.t), pairs: perPair.length,
    pairChunkP50: q(pairCounts, 0.5), pairChunkP95: q(pairCounts, 0.95),
    perChunkEntityP50: q(perChunk, 0.5), perChunkEntityP95: q(perChunk, 0.95) }, null, 1));
} else if (cmd === 'invariants') {
  const { get_encoding } = await import('tiktoken');
  const enc = get_encoding('cl100k_base');
  const docs = mgr.db.prepare(`SELECT id, content, chunking_signature FROM documents WHERE chunking_signature LIKE 'c1:%'`).all();
  const errors = [];
  const tokenCounts = [];
  for (const d of docs) {
    const chunks = mgr.db.prepare(`SELECT chunk_index, text, start_pos, end_pos, start_token, end_token
      FROM chunk_metadata WHERE document_id = ? ORDER BY chunk_index`).all(d.id);
    if (chunks.map(c => c.text).join('') !== d.content) errors.push(`${d.id}: partition`);
    let cursor = 0;
    for (const [i, c] of chunks.entries()) {
      if (c.chunk_index !== i) errors.push(`${d.id}#${i}: dense index`);
      if (c.start_pos !== cursor || c.end_pos !== cursor + [...c.text].length) errors.push(`${d.id}#${i}: offsets`);
      cursor = c.end_pos;
      if (c.start_token !== null || c.end_token !== null) errors.push(`${d.id}#${i}: token offsets not NULL`);
      const t = enc.encode(c.text).length;
      tokenCounts.push(t);
      if (t > 800) errors.push(`${d.id}#${i}: token budget`);
    }
  }
  tokenCounts.sort((a, b) => a - b);
  const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;
  fs.writeFileSync(args[0], JSON.stringify({ docs: docs.length, errors,
    structure: { chunks: tokenCounts.length, tokenP50: q(tokenCounts, 0.5), tokenP95: q(tokenCounts, 0.95) } }, null, 1));
  if (errors.length) process.exit(1);
} else if (cmd === 'boost') {
  const self = JSON.parse(fs.readFileSync(args[0], 'utf-8'));
  let changed = 0;
  for (const p of self) {
    const on = docTop(await hybrid(p.probeText, true));
    const off = docTop(await hybrid(p.probeText, false));
    if (JSON.stringify(on) !== JSON.stringify(off)) changed++;
  }
  fs.writeFileSync(args[1], JSON.stringify({ probes: self.length, boostChangedTop5: changed }, null, 1));
} else if (cmd === 'synthetic') {
  // r7-2: 결정론 배치 — 이름 없는 base 의 첫 경계 B 실측 후 B-k 에 공백으로 감싸 삽입
  // (접착되면 \b 가 성립하지 않는다 — 실행 적발).
  const { get_encoding } = await import('tiktoken');
  const { chunkStructured } = await import('../../dist/src/chunkerC.js');
  const enc = get_encoding('cl100k_base');
  const NAME = 'SyntheticBoundaryEntity';
  const filler = 'x'.repeat(6) + ' ';
  const base = filler.repeat(800) + '\n';
  const baseSegs = chunkStructured(base, enc, 200);
  if (baseSegs.length < 2) { console.error('precondition FAIL: base not split'); process.exit(1); }
  const B = baseSegs[0].end_pos;
  const baseCps = [...base];
  let doc = null, nameStart = -1;
  for (let k = 1; k < NAME.length + 2 && !doc; k++) {
    const cand = baseCps.slice(0, B - k).join('') + ' ' + NAME + ' ' + baseCps.slice(B - k).join('');
    const segs = chunkStructured(cand, enc, 200);
    const ns = B - k + 1;
    if (segs.some(s => s.start_pos > ns && s.start_pos < ns + NAME.length)) { doc = cand; nameStart = ns; }
  }
  if (!doc) { console.error('precondition FAIL: no straddling placement'); process.exit(1); }
  await mgr.createEntities([{ name: NAME, entityType: 'TEST', observations: ['synthetic control'] }]);
  await mgr.storeDocument('synthetic-boundary-doc', doc);
  await mgr.chunkDocument('synthetic-boundary-doc', { maxTokens: 200 });   // r7-2: 탐색과 동일 설정
  await mgr.embedChunks('synthetic-boundary-doc');
  await mgr.autoLinkEntities('synthetic-boundary-doc');
  const rows = mgr.db.prepare(`SELECT start_pos, text FROM chunk_metadata WHERE document_id='synthetic-boundary-doc' ORDER BY chunk_index`).all();
  const stored = mgr.db.prepare(`SELECT content FROM documents WHERE id='synthetic-boundary-doc'`).get().content;
  const ns2 = [...stored.slice(0, stored.indexOf(NAME))].length;
  const crossed = rows.some(r => r.start_pos > ns2 && r.start_pos < ns2 + NAME.length);
  const wholeInOne = rows.some(r => r.text.includes(NAME));
  const linked = mgr.db.prepare(`SELECT count(*) n FROM chunk_entities ce JOIN chunk_metadata m ON m.rowid=ce.chunk_rowid
    JOIN entities e ON e.id = ce.entity_id WHERE m.document_id='synthetic-boundary-doc' AND e.name = ?`).get(NAME).n;
  fs.writeFileSync(args[0], JSON.stringify({
    boundaryCrossesName: crossed, nameWhollyInOneChunk: wholeInOne, syntheticEntityLinked: linked > 0, linkedChunks: linked }, null, 1));
  if (!crossed || wholeInOne) { console.error('precondition FAIL: name not actually cut'); process.exit(1); }
} else if (cmd === 'coldreplay') {
  // r6-2: ready 필수 — lazy 오염이면 측정이 거짓.
  const docId = args[0];
  if (!mgr.gate.isReady) { console.error('coldreplay requires ready model'); process.exit(1); }
  const doc = mgr.db.prepare(`SELECT content FROM documents WHERE id=?`).get(docId);
  const entry = (n) => `## [SYNTH] cold replay entry ${n}\n대표 편집 재현용 합성 엔트리다.\n\n`;
  const r1 = await mgr.syncDocumentFromFile('/dev/null', docId, { content: entry(1) + doc.content });
  const r2 = await mgr.syncDocumentFromFile('/dev/null', docId, { content: entry(2) + entry(1) + doc.content });
  for (const [i, r] of [r1, r2].entries()) {
    if (r.queuedChunks !== 0) { console.error(`replay ${i}: queued=${r.queuedChunks} (lazy 오염)`); process.exit(1); }
    if (r.embeddedChunks !== r.reusedChunks + r.newlyEmbeddedChunks) { console.error(`replay ${i}: 합산식 위반`); process.exit(1); }
  }
  fs.writeFileSync(args[1], JSON.stringify({
    cold: { reused: r1.reusedChunks, total: r1.chunks },
    steady: { reused: r2.reusedChunks, total: r2.chunks } }, null, 1));
}
mgr.cleanup();
