# rag-memory 엔진 신뢰성 강화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `syncDocumentFromFile`을 원자적·dedup 가능하게 만들고, `hybridSearch`가 임베딩 모델 다운 시 FTS5-only로 graceful degrade하도록 한다.

**Architecture:** 단일 모놀리식 `index.ts`의 `RAGKnowledgeGraphManager`를 수정. #1+#2는 `syncDocumentFromFile`을 "임베딩을 메모리에서 먼저 계산 -> 동기 트랜잭션으로 DB 스왑" 구조로 재구성 (better-sqlite3 트랜잭션이 동기여야 하므로). #3는 `hybridSearch`의 vector 단계를 try/catch로 감싸 실패 시 FTS5 BM25 결과만 반환. 테스트를 위해 클래스를 export하고 import-시-서버부팅을 막는다.

**Tech Stack:** TypeScript (ES2022, ESM), better-sqlite3 + sqlite-vec, @huggingface/transformers (bge-m3), tiktoken, Node 내장 스크립트 테스트 (기존 `test/chunk-invariants.test.mjs` 패턴 = plain assert + `process.exit`).

---

## File Structure

- `index.ts` (repo 루트, 3,213줄): 모든 구현 변경.
  - L166 `class RAGKnowledgeGraphManager` -> `export class ...`
  - L175 `initialize()` -> `initialize({ skipModel })` 옵션
  - L1537-1591 `syncDocumentFromFile` 재구성 (#1 + #2)
  - L118-131 `EnhancedSearchResult` 인터페이스 + L2210-2592 `hybridSearch` (#3)
  - 파일 하단 `main()` 실행을 entry-point 가드로 감쌈
- `test/helpers/engine-test-db.mjs` (신규): temp DB 매니저 생성 + fake embedder 설치 헬퍼.
- `test/sync-atomicity.test.mjs` (신규): #1 테스트.
- `test/dedup.test.mjs` (신규): #2 테스트.
- `test/search-degradation.test.mjs` (신규): #3 테스트.
- `test/engine-smoke.test.mjs` (신규): Task 0 seam 검증.
- `package.json`: 테스트 스크립트 + version bump.
- `README.md`: 변경 동작 반영.

**테스트 격리 원칙**: `DB_FILE_PATH`는 모듈 로드 시 1회 읽힘 (index.ts:47). Node는 모듈을 프로세스당 1회 캐시하므로, **각 테스트 파일은 별도 `node` 프로세스로 실행**해야 fresh DB를 얻는다. 따라서 각 테스트는 독립 `.mjs` 스크립트이고 `&&`로 순차 실행한다. 헬퍼 `makeManager()`는 프로세스당 1회만 호출한다.

---

### Task 0: 테스트 가능성 seam (export + main 가드 + skipModel)

**Files:**
- Modify: `index.ts:166` (class export), `index.ts:175-207` (initialize 옵션), 파일 하단 main 실행부
- Create: `test/helpers/engine-test-db.mjs`
- Test: `test/engine-smoke.test.mjs`

- [ ] **Step 1: 스모크 테스트 헬퍼 작성** (`test/helpers/engine-test-db.mjs`)

```js
// Shared test harness: isolated temp DB + manager without the heavy embedding model.
// IMPORTANT: DB_FILE_PATH is read once at module load (index.ts), and Node caches
// the module per process. So call makeManager() at most ONCE per test process,
// and run each test file as its own `node` invocation.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export async function makeManager() {
  const dir = mkdtempSync(join(tmpdir(), 'ragmem-test-'));
  const dbPath = join(dir, 'test.db');
  process.env.DB_FILE_PATH = dbPath;           // must be set BEFORE the import below
  const mod = await import('../../dist/index.js');
  const manager = new mod.RAGKnowledgeGraphManager();
  await manager.initialize({ skipModel: true }); // DB + migrations, NO embedding model
  const cleanup = () => {
    try { manager.cleanup(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return { manager, dbPath, dir, cleanup };
}

// Install a deterministic fake embedder so embedding-dependent paths run without
// loading bge-m3. TS `private` fields are erased at runtime (compiled JS exposes
// them as plain properties), so direct assignment works from a .mjs test.
export function installFakeEmbedder(manager) {
  const counter = { calls: 0 };
  manager.embeddingModel = async (_text) => {
    counter.calls++;
    return { data: new Float32Array(1024).fill(0.01) }; // bge-m3 is 1024-dim
  };
  manager.modelInitialized = true;
  return counter;
}

export function simulateModelDown(manager) {
  manager.embeddingModel = null;
  manager.modelInitialized = false;
}

function assert(cond, msg) {
  if (!cond) { console.error(`  FAIL: ${msg}`); process.exitCode = 1; return false; }
  console.log(`  OK: ${msg}`); return true;
}
export { assert };
```

- [ ] **Step 2: 스모크 테스트 작성** (`test/engine-smoke.test.mjs`)

```js
// Verifies the testability seam: importing the built module does NOT boot the
// server (no hang), the class is exported, and a temp DB initializes cleanly.
import { makeManager, assert } from './helpers/engine-test-db.mjs';

const { manager, cleanup } = await makeManager();
try {
  const stats = await manager.getKnowledgeGraphStats();
  assert(stats && stats.entities && stats.entities.total === 0, 'fresh temp DB has 0 entities');
  assert(typeof stats.chunks === 'number', 'stats include chunk count');
} finally {
  cleanup();
}
console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE OK');
```

- [ ] **Step 3: 테스트 실행 -> import가 행(hang)하거나 export 없음으로 실패 확인**

Run: `npm run build && node test/engine-smoke.test.mjs`
Expected: FAIL — `new mod.RAGKnowledgeGraphManager()`가 `undefined`라 TypeError, 또는 (가드 전이면) import가 main() 실행으로 행. (export + 가드 + skipModel 미구현 상태)

- [ ] **Step 4: class export**

`index.ts:166` 변경:
```ts
export class RAGKnowledgeGraphManager {
```

- [ ] **Step 5: initialize에 skipModel 옵션 추가**

`index.ts:175` 시그니처 + L197 모델 로드 호출 변경:
```ts
  async initialize(opts: { skipModel?: boolean } = {}) {
```
그리고 L197 `await this.initializeEmbeddingModel();`을 아래로 교체:
```ts
    // Initialize embedding model (skippable for tests / FTS-only environments)
    if (!opts.skipModel) {
      await this.initializeEmbeddingModel();
    } else {
      console.error('⏭️  Skipping embedding model load (skipModel=true)');
    }
```

- [ ] **Step 6: main() 실행을 entry-point 가드로 감쌈**

`index.ts` 파일 하단의 `main().catch(...)` 블록을 가드로 감싼다. `fileURLToPath`는 이미 import됨 (L50 사용). 기존:
```ts
main().catch((error) => {
  console.error("Fatal error in main():", error);
  ragKgManager.cleanup();
  process.exit(1);
});
```
교체:
```ts
// Only boot the server when run as the entry point — not when imported (tests).
const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    ragKgManager.cleanup();
    process.exit(1);
  });
}
```

- [ ] **Step 7: 테스트 실행 -> 통과 확인**

Run: `npm run build && node test/engine-smoke.test.mjs`
Expected: PASS — `SMOKE OK`, exit 0. (import 즉시 반환, stats 0 entities)

- [ ] **Step 8: Commit**

```bash
git add index.ts test/helpers/engine-test-db.mjs test/engine-smoke.test.mjs
git commit -m "test(seam): export manager + guard main() + skipModel for DB-backed tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 1: #1 syncDocumentFromFile 원자화 (임베딩 선계산 + 동기 트랜잭션)

**Files:**
- Modify: `index.ts:1537-1591` (`syncDocumentFromFile` 재구성)
- Test: `test/sync-atomicity.test.mjs`

- [ ] **Step 1: 원자성 실패 테스트 작성** (`test/sync-atomicity.test.mjs`)

```js
// #1: a sync that fails during embedding (model down) must leave the previously
// synced document fully intact — no partial state (old doc deleted but new doc
// half-embedded).
import { writeFileSync } from 'fs';
import { join } from 'path';
import { makeManager, installFakeEmbedder, simulateModelDown, assert } from './helpers/engine-test-db.mjs';

const { manager, dir, cleanup } = await makeManager();
try {
  const counter = installFakeEmbedder(manager);
  const file = join(dir, 'doc.txt');
  const original = 'alpha bravo charlie. '.repeat(50); // multi-chunk-ish content
  writeFileSync(file, original, 'utf-8');

  // 1) Initial successful sync.
  const first = await manager.syncDocumentFromFile(file, 'doc1', {});
  assert(first.embeddedChunks > 0, `initial sync embedded ${first.embeddedChunks} chunks`);

  // Snapshot the stored state.
  const db = manager.db; // private at compile time, plain field at runtime
  const beforeContent = db.prepare('SELECT content FROM documents WHERE id = ?').get('doc1').content;
  const beforeChunks = db.prepare('SELECT count(*) AS n FROM chunk_metadata WHERE document_id = ?').get('doc1').n;
  const beforeEmb = db.prepare(
    'SELECT count(*) AS n FROM chunks c JOIN chunk_metadata m ON c.rowid = m.rowid WHERE m.document_id = ?'
  ).get('doc1').n;
  assert(beforeChunks > 0 && beforeChunks === beforeEmb, `before: ${beforeChunks} chunks all embedded`);

  // 2) Model goes down, content CHANGES (so dedup would not short-circuit anyway).
  simulateModelDown(manager);
  writeFileSync(file, original + ' delta echo foxtrot.', 'utf-8');

  let threw = false;
  try {
    await manager.syncDocumentFromFile(file, 'doc1', {});
  } catch (e) {
    threw = true;
  }
  assert(threw, 'sync with model down throws');

  // 3) Old document must be byte-identical and fully embedded — no partial state.
  const afterContent = db.prepare('SELECT content FROM documents WHERE id = ?').get('doc1').content;
  const afterChunks = db.prepare('SELECT count(*) AS n FROM chunk_metadata WHERE document_id = ?').get('doc1').n;
  const afterEmb = db.prepare(
    'SELECT count(*) AS n FROM chunks c JOIN chunk_metadata m ON c.rowid = m.rowid WHERE m.document_id = ?'
  ).get('doc1').n;
  assert(afterContent === beforeContent, 'document content unchanged after failed sync');
  assert(afterChunks === beforeChunks, 'chunk count unchanged after failed sync');
  assert(afterEmb === beforeEmb, 'embedding count unchanged after failed sync (no partial state)');
} finally {
  cleanup();
}
console.log(process.exitCode ? 'ATOMICITY FAILED' : 'ATOMICITY OK');
```

- [ ] **Step 2: 테스트 실행 -> 실패 확인**

Run: `npm run build && node test/sync-atomicity.test.mjs`
Expected: FAIL — 현재 코드는 `delete -> store -> chunk`를 먼저 하고 embed에서 throw하므로 old doc이 이미 삭제/교체됨. `afterChunks`/`afterContent`가 변경되어 assert 실패.

- [ ] **Step 3: syncDocumentFromFile 재구성**

`index.ts:1537-1591` 전체를 아래로 교체 (dedup은 Task 2에서 추가):
```ts
  async syncDocumentFromFile(
    filePath: string,
    documentId: string,
    options: {
      metadata?: Record<string, any>;
      content?: string;
      entityNames?: string[];
      chunkParams?: { maxTokens?: number; overlap?: number };
    } = {}
  ): Promise<{ documentId: string; bytes: number; chunks: number; embeddedChunks: number; linkedEntities: number; explicitlyLinked?: number; warning?: string; skipped?: boolean; reason?: string }> {
    if (!this.db) throw new Error('Database not initialized');

    // 1. Resolve content: raw file verbatim (default) or explicit override.
    const content = options.content !== undefined
      ? options.content
      : fsSync.readFileSync(filePath, 'utf-8');
    const bytes = Buffer.byteLength(content, 'utf-8');

    // 2. Metadata: default source=path, updated=today; caller can override either.
    const today = new Date().toISOString().slice(0, 10);
    const metadata = { source: filePath, updated: today, ...(options.metadata || {}) };

    console.error(`🔄 syncDocumentFromFile: ${documentId} <- ${filePath} (${bytes} bytes)`);

    // 3. Pre-compute chunks + embeddings BEFORE any DB mutation. If embedding
    //    throws (model down), the existing document is left completely intact.
    const { maxTokens = 800, overlap = 160 } = options.chunkParams || {};
    const segments = this.chunkText(content, maxTokens, overlap);
    const embedded: Array<{ seg: typeof segments[number]; embedding: Float32Array }> = [];
    for (const seg of segments) {
      const embedding = await this.generateEmbedding(seg.text);
      embedded.push({ seg, embedding });
    }

    // 4. Atomic swap: delete old -> insert doc -> insert chunks + embeddings,
    //    all in a single synchronous better-sqlite3 transaction (all-or-nothing).
    const applyTx = this.db.transaction(() => {
      const db = this.db!;
      // 4a. cleanup old doc (inlined sync version of cleanupDocument).
      const existing = db.prepare(`SELECT rowid FROM chunk_metadata WHERE document_id = ?`).all(documentId) as { rowid: number }[];
      for (const ch of existing) {
        db.prepare(`DELETE FROM chunk_entities WHERE chunk_rowid = ?`).run(ch.rowid);
        db.exec(`DELETE FROM chunks WHERE rowid = ${safeRowid(ch.rowid)}`);
      }
      db.prepare(`DELETE FROM chunk_metadata WHERE document_id = ?`).run(documentId);
      db.prepare(`DELETE FROM documents WHERE id = ?`).run(documentId);

      // 4b. insert document.
      db.prepare(`INSERT INTO documents (id, content, metadata) VALUES (?, ?, ?)`)
        .run(documentId, content, JSON.stringify(metadata));

      // 4c. insert chunk_metadata (FTS5 chunks_fts auto-filled by trigger) + embeddings.
      for (const { seg, embedding } of embedded) {
        const chunkId = `${documentId}_chunk_${seg.chunk_index}`;
        const info = db.prepare(`
          INSERT INTO chunk_metadata (chunk_id, document_id, chunk_index, text, start_pos, end_pos, start_token, end_token)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(chunkId, documentId, seg.chunk_index, seg.text, seg.start_pos, seg.end_pos, seg.start_token, seg.end_token);
        const rowid = Number(info.lastInsertRowid);
        db.prepare(`INSERT INTO chunks (rowid, embedding) VALUES (${rowid}, ?)`).run(Buffer.from(embedding.buffer));
      }
    });
    applyTx();

    const embeddedChunks = embedded.length;

    // 5. Entity linking AFTER commit. Non-destructive + idempotent (INSERT OR
    //    IGNORE), so a linking failure cannot corrupt the doc/embeddings.
    const linkedEntities = await this.autoLinkEntities(documentId);
    let explicitlyLinked: number | undefined;
    if (options.entityNames && options.entityNames.length > 0) {
      const linkResult = await this.linkEntitiesToDocument(documentId, options.entityNames);
      explicitlyLinked = linkResult.linkedEntities;
    }

    // 6. Terse summary only.
    const result: { documentId: string; bytes: number; chunks: number; embeddedChunks: number; linkedEntities: number; explicitlyLinked?: number; warning?: string; skipped?: boolean; reason?: string } = {
      documentId,
      bytes,
      chunks: segments.length,
      embeddedChunks,
      linkedEntities,
      ...(explicitlyLinked !== undefined ? { explicitlyLinked } : {}),
    };
    if (linkedEntities === 0 && explicitlyLinked === undefined) {
      result.warning = 'linkedEntities=0: ensure the file content contains entity-name literals (e.g. a wiki anchor line "RAG entity: ...") so term-matching can link entities.';
    }
    console.error(`✅ syncDocumentFromFile done: ${documentId} (${result.chunks} chunks, ${result.embeddedChunks} embedded, ${linkedEntities} linked)`);
    return result;
  }
```

- [ ] **Step 4: 테스트 실행 -> 통과 확인**

Run: `npm run build && node test/sync-atomicity.test.mjs`
Expected: PASS — `ATOMICITY OK`. 모델 다운 시 임베딩 단계가 DB 변경 전에 throw하므로 old doc 무손상.

- [ ] **Step 5: 회귀 확인 (기존 invariant 테스트)**

Run: `npm run verify:invariants`
Expected: PASS — `Publish-time invariants OK.`

- [ ] **Step 6: Commit**

```bash
git add index.ts test/sync-atomicity.test.mjs
git commit -m "fix(sync): atomic syncDocumentFromFile (embed-first, synchronous transaction swap)

embedChunks throw 시 기존 doc이 삭제+부분임베딩 잔존하던 부분상태 제거.
임베딩을 DB 변경 전 메모리에서 선계산 후 단일 동기 트랜잭션으로 스왑.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: #2 content_hash dedup (metadata JSON, 완전성 게이트)

**Files:**
- Modify: `index.ts` `syncDocumentFromFile` (Task 1에서 재구성한 버전)
- Test: `test/dedup.test.mjs`

- [ ] **Step 1: dedup 테스트 작성** (`test/dedup.test.mjs`)

```js
// #2: identical content short-circuits (skipped=true, no re-embed); changed
// content re-syncs; partial state (missing embeddings) does NOT short-circuit.
import { writeFileSync } from 'fs';
import { join } from 'path';
import { makeManager, installFakeEmbedder, assert } from './helpers/engine-test-db.mjs';

const { manager, dir, cleanup } = await makeManager();
try {
  const counter = installFakeEmbedder(manager);
  const file = join(dir, 'doc.txt');
  writeFileSync(file, 'alpha bravo charlie delta.', 'utf-8');

  // 1) First sync.
  const first = await manager.syncDocumentFromFile(file, 'doc1', {});
  assert(!first.skipped && first.embeddedChunks > 0, `first sync runs (embedded ${first.embeddedChunks})`);

  // 2) Same content -> skipped, no embedding work.
  counter.calls = 0;
  const second = await manager.syncDocumentFromFile(file, 'doc1', {});
  assert(second.skipped === true, 'unchanged content short-circuits (skipped=true)');
  assert(second.reason === 'unchanged', 'skip reason is "unchanged"');

  // 3) Changed content -> re-syncs (not skipped).
  writeFileSync(file, 'alpha bravo charlie delta ECHO.', 'utf-8');
  const third = await manager.syncDocumentFromFile(file, 'doc1', {});
  assert(third.skipped !== true && third.embeddedChunks > 0, 'changed content re-syncs');

  // 4) Partial state: drop vec embeddings but keep chunk_metadata + same hash.
  const db = manager.db;
  db.exec('DELETE FROM chunks'); // remove all vector rows (simulate partial/failed prior sync)
  const fourth = await manager.syncDocumentFromFile(file, 'doc1', {});
  assert(fourth.skipped !== true, 'incomplete embeddings (hash match) does NOT short-circuit');
  const reEmb = db.prepare(
    'SELECT count(*) AS n FROM chunks c JOIN chunk_metadata m ON c.rowid = m.rowid WHERE m.document_id = ?'
  ).get('doc1').n;
  assert(reEmb > 0, 'partial-state recovery re-embeds chunks');
} finally {
  cleanup();
}
console.log(process.exitCode ? 'DEDUP FAILED' : 'DEDUP OK');
```

- [ ] **Step 2: 테스트 실행 -> 실패 확인**

Run: `npm run build && node test/dedup.test.mjs`
Expected: FAIL — 현재(Task 1까지) `skipped` 필드가 없어 `second.skipped === true`에서 실패.

- [ ] **Step 3: dedup 게이트 + 해시 저장 추가**

`syncDocumentFromFile`의 2번(metadata) 블록을 아래로 교체 (content_hash 계산 + metadata 포함):
```ts
    // 2. Metadata: default source=path, updated=today, content_hash; caller can override.
    const today = new Date().toISOString().slice(0, 10);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const metadata = { source: filePath, updated: today, content_hash: contentHash, ...(options.metadata || {}) };

    // 2b. Dedup gate: skip the full delete/store/chunk/embed pipeline when the
    //     file is unchanged AND the existing document is fully embedded. The
    //     completeness check avoids wrongly skipping a partial/failed prior sync.
    const existingDoc = this.db.prepare(`SELECT metadata FROM documents WHERE id = ?`).get(documentId) as { metadata: string } | undefined;
    if (existingDoc) {
      let existingHash: string | undefined;
      try { existingHash = JSON.parse(existingDoc.metadata)?.content_hash; } catch { /* ignore */ }
      if (existingHash === contentHash) {
        const cmCount = (this.db.prepare(`SELECT count(*) AS n FROM chunk_metadata WHERE document_id = ?`).get(documentId) as { n: number }).n;
        const embCount = (this.db.prepare(`
          SELECT count(*) AS n FROM chunks c JOIN chunk_metadata m ON c.rowid = m.rowid WHERE m.document_id = ?
        `).get(documentId) as { n: number }).n;
        if (cmCount > 0 && cmCount === embCount) {
          const linked = (this.db.prepare(`
            SELECT count(DISTINCT ce.entity_id) AS n FROM chunk_entities ce
            JOIN chunk_metadata m ON ce.chunk_rowid = m.rowid WHERE m.document_id = ?
          `).get(documentId) as { n: number }).n;
          console.error(`⏭️  syncDocumentFromFile: ${documentId} unchanged (hash match, ${cmCount} chunks embedded) — skipped`);
          return { documentId, bytes, chunks: cmCount, embeddedChunks: embCount, linkedEntities: linked, skipped: true, reason: 'unchanged' };
        }
      }
    }
```
(content_hash가 metadata에 포함되었으므로 Task 1의 트랜잭션 4b INSERT는 변경 불필요 — 이미 `JSON.stringify(metadata)`를 저장한다.)

- [ ] **Step 4: 테스트 실행 -> 통과 확인**

Run: `npm run build && node test/dedup.test.mjs`
Expected: PASS — `DEDUP OK`. (skip / re-sync / partial-state 4케이스 통과)

- [ ] **Step 5: #1 회귀 확인** (atomicity 테스트는 내용 변경 케이스라 dedup과 무관해야 함)

Run: `node test/sync-atomicity.test.mjs`
Expected: PASS — `ATOMICITY OK`.

- [ ] **Step 6: Commit**

```bash
git add index.ts test/dedup.test.mjs
git commit -m "feat(sync): content_hash dedup with completeness gate

파일 미변경 + 임베딩 완전 시 재청킹/재임베딩을 short-circuit (skipped=true).
부분상태(임베딩 누락)는 해시 일치해도 재처리하여 복구.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: #3 hybridSearch FTS5-only degradation

**Files:**
- Modify: `index.ts:118-131` (`EnhancedSearchResult`), `index.ts:2210-2592` (`hybridSearch`)
- Test: `test/search-degradation.test.mjs`

- [ ] **Step 1: degradation 테스트 작성** (`test/search-degradation.test.mjs`)

```js
// #3: with the embedding model down, hybridSearch returns FTS5 (BM25) results
// tagged search_mode='fts-only' instead of throwing.
import { writeFileSync } from 'fs';
import { join } from 'path';
import { makeManager, installFakeEmbedder, simulateModelDown, assert } from './helpers/engine-test-db.mjs';

const { manager, dir, cleanup } = await makeManager();
try {
  installFakeEmbedder(manager);
  const file = join(dir, 'doc.txt');
  // ASCII content so the default FTS5 tokenizer matches the query term cleanly.
  writeFileSync(file, 'the quick brown fox jumps over the lazy dog zebra', 'utf-8');
  await manager.syncDocumentFromFile(file, 'doc1', {});

  // Sanity: normal (non-degraded) search returns hybrid results.
  const normal = await manager.hybridSearch('zebra', 5, true);
  assert(Array.isArray(normal), 'normal search returns an array');

  // Model goes down.
  simulateModelDown(manager);

  let threw = false, results = null;
  try {
    results = await manager.hybridSearch('zebra', 5, true);
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'hybridSearch does NOT throw when model is down');
  assert(Array.isArray(results) && results.length > 0, `FTS5-only search returns results (${results ? results.length : 0})`);
  assert(results.every(r => r.search_mode === 'fts-only'), 'all results tagged search_mode=fts-only');
} finally {
  cleanup();
}
console.log(process.exitCode ? 'DEGRADATION FAILED' : 'DEGRADATION OK');
```

- [ ] **Step 2: 테스트 실행 -> 실패 확인**

Run: `npm run build && node test/search-degradation.test.mjs`
Expected: FAIL — 현재 `hybridSearch`는 L2219에서 임베딩을 try 밖에서 호출하므로 모델 다운 시 throw. `!threw` assert 실패.

- [ ] **Step 3: EnhancedSearchResult에 search_mode 추가**

`index.ts:118-131` 인터페이스에 필드 추가 (`source_id` 다음 줄):
```ts
  source_id?: string; // NEW: ID of the source entity/relationship if applicable
  search_mode?: 'hybrid' | 'fts-only'; // NEW: 'fts-only' when vector/embedding degraded
}
```

- [ ] **Step 4: primary 임베딩 + vector 변형 루프를 try/catch로 감쌈**

`index.ts:2219`의 한 줄을 제거하고 `let` 선언으로 교체:
```ts
    let vectorDegraded = false;
    let primaryQueryEmbedding: Float32Array | null = null;
```
(이 줄들은 기존 `const primaryQueryEmbedding = await this.generateEmbedding(queryVariants[0], 1024, true);` 자리에 들어간다. `searchChunks` 헬퍼 정의와 `ChunkSearchResult` 타입(2221-2265)은 그대로 둔다 — 임베딩을 호출하지 않음.)

그 다음 변형 루프 블록 (기존 2267-2279):
```ts
    const resultMap = new Map<string, ChunkSearchResult>();
    for (const variant of queryVariants) {
      const embedding = await this.generateEmbedding(variant, 1024, true);
      const variantResults = searchChunks(embedding, limit * 3);
      for (const r of variantResults) {
        const existing = resultMap.get(r.chunk_id);
        if (!existing || r.distance < existing.distance) {
          resultMap.set(r.chunk_id, r);
        }
      }
    }
    const vectorResults = Array.from(resultMap.values()).sort((a, b) => a.distance - b.distance);
```
을 아래로 교체:
```ts
    const resultMap = new Map<string, ChunkSearchResult>();
    try {
      primaryQueryEmbedding = await this.generateEmbedding(queryVariants[0], 1024, true);
      for (const variant of queryVariants) {
        const embedding = await this.generateEmbedding(variant, 1024, true);
        const variantResults = searchChunks(embedding, limit * 3);
        for (const r of variantResults) {
          const existing = resultMap.get(r.chunk_id);
          if (!existing || r.distance < existing.distance) {
            resultMap.set(r.chunk_id, r);
          }
        }
      }
    } catch (embErr) {
      vectorDegraded = true;
      console.error(`⚠️ Vector search unavailable (embedding model down) — degrading to FTS5-only:`, embErr instanceof Error ? embErr.message : embErr);
    }
    const vectorResults = Array.from(resultMap.values()).sort((a, b) => a.distance - b.distance);
```
(degraded 시 resultMap이 비어 vectorResults=[]; 이후 FTS5 블록이 BM25 매치를 vectorResults에 push한다.)

- [ ] **Step 5: 그래프 강화 블록을 degraded 시 skip**

`index.ts`의 두 `if (useGraph)` 가드를 `if (useGraph && !vectorDegraded)`로 변경:
1. 엔티티 벡터 검색 블록 (기존 2374): `if (useGraph) {` -> `if (useGraph && !vectorDegraded) {`
2. graphBoost 계산 블록 (기존 2484): `if (useGraph) {` -> `if (useGraph && !vectorDegraded) {`

- [ ] **Step 6: semantic summary를 degraded 시 텍스트 폴백으로 대체**

`generateContentSummary` 호출 (기존 2533-2539)을 아래로 교체 (이 함수는 문장을 임베딩하므로 모델 다운 시 throw):
```ts
      // Generate semantic summary (skip when degraded — no embeddings available).
      let summary: string, keyHighlight: string, relevanceScore: number;
      if (vectorDegraded || !primaryQueryEmbedding) {
        keyHighlight = result.text.slice(0, 150);
        summary = result.text.slice(0, 300);
        relevanceScore = 0;
      } else {
        ({ summary, keyHighlight, relevanceScore } = await this.generateContentSummary(
          result.text,
          primaryQueryEmbedding,
          chunkEntities,
          result.chunk_type === 'relationship' ? 1 : 2 // Shorter summary for relationships
        ));
      }
```

- [ ] **Step 7: 결과에 search_mode 부착 + graph_boost 가드 갱신**

결과 push 객체 (기존 2564-2577)에서 `graph_boost` 줄과 `source_id` 줄을 변경/보강:
```ts
        graph_boost: (useGraph && !vectorDegraded) ? graphBoost : undefined,
        fts_boost: ftsBoost > 0 ? ftsBoost : undefined,
        full_context_available: true,
        chunk_type: result.chunk_type as 'document' | 'entity' | 'relationship',
        source_id: sourceId,
        search_mode: vectorDegraded ? 'fts-only' : 'hybrid'
```

- [ ] **Step 8: 테스트 실행 -> 통과 확인**

Run: `npm run build && node test/search-degradation.test.mjs`
Expected: PASS — `DEGRADATION OK`. 모델 다운 시 throw 없이 FTS5 결과 반환 + 전부 `search_mode='fts-only'`.

- [ ] **Step 9: 전체 회귀 확인**

Run: `node test/engine-smoke.test.mjs && node test/sync-atomicity.test.mjs && node test/dedup.test.mjs && npm run verify:invariants`
Expected: 모두 PASS.

- [ ] **Step 10: Commit**

```bash
git add index.ts test/search-degradation.test.mjs
git commit -m "feat(search): FTS5-only graceful degradation when embedding model is down

hybridSearch가 모델 다운 시 throw 대신 BM25 결과를 search_mode='fts-only'로 반환.
graph 강화 + semantic summary는 degraded 시 skip.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 테스트 배선 + 버전 + README + 최종 검증

**Files:**
- Modify: `package.json` (scripts + version), `README.md`

- [ ] **Step 1: package.json 테스트 스크립트 + 버전**

`package.json` `scripts`를 아래로 교체:
```json
  "scripts": {
    "build": "tsc && shx chmod +x dist/*.js",
    "prepare": "npm run build",
    "watch": "tsc --watch",
    "verify:invariants": "node test/chunk-invariants.test.mjs",
    "verify:engine": "node test/engine-smoke.test.mjs && node test/sync-atomicity.test.mjs && node test/dedup.test.mjs && node test/search-degradation.test.mjs",
    "test": "npm run build && npm run verify:invariants && npm run verify:engine",
    "prepublishOnly": "npm run build && npm run verify:invariants && npm run verify:engine"
  },
```
그리고 `"version": "3.4.0"` -> `"version": "3.5.0"`.

- [ ] **Step 2: 전체 테스트 스위트 실행**

Run: `npm test`
Expected: build 후 invariants OK + `SMOKE OK` + `ATOMICITY OK` + `DEDUP OK` + `DEGRADATION OK`, exit 0.

- [ ] **Step 3: README 갱신**

`README.md`에서 `syncDocumentFromFile` 항목에 "동일 content 재호출 시 short-circuit(skipped) + 임베딩 실패 시 기존 doc 무손상(원자적)" 한 줄, `hybridSearch` 항목에 "임베딩 모델 다운 시 FTS5 BM25로 graceful degrade (결과에 search_mode 표시)" 한 줄 추가. (정확한 위치는 해당 툴 설명 단락. 버전 표기는 사용자 정책상 `@latest` 유지 — 특정 버전 박지 말 것.)

- [ ] **Step 4: 빌드 산출물 확인 + 커밋**

Run: `npm run build && node test/engine-smoke.test.mjs`
Expected: PASS.

```bash
git add package.json README.md
git commit -m "chore(release): wire engine tests into prepublish + bump v3.5.0 + README

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: 최종 검증 게이트 (verification-before-completion)**

Run: `npm test && git log --oneline -6 && git status`
Expected: 전체 PASS, 6개 커밋(spec + Task0~4), working tree clean (untracked `migrate-ids-*.cjs` 제외).

> **배포(npm publish + GitHub push)는 이 plan 범위 밖** — 별도 사용자 승인. deployed 18개는 `/mcp` 재연결로 자연 노출.

---

## Self-Review (writing-plans 체크리스트)

**1. Spec coverage:**
- #1 원자화 -> Task 1 ✓ / #2 dedup -> Task 2 ✓ / #3 degradation -> Task 3 ✓
- 테스트 전략(DB-backed 하네스) -> Task 0 헬퍼 + 각 Task 테스트 ✓
- 비목표(standalone 툴 불변) -> Task 1이 chunkText/직접 INSERT로 재구현, embedChunks/chunkDocument 메서드 미변경 ✓
- 버전/배포 -> Task 4 ✓ (publish는 범위 밖 명시)
- 검증 포인트(vec0 트랜잭션 / search_mode 노출) -> Task 1 Step4 + Task 3 Step8 테스트가 실증 ✓

**2. Placeholder scan:** TBD/TODO 없음. 모든 코드 블록은 실제 코드. README Step 3만 "해당 단락" 표현이나 정확한 삽입 내용 명시 = 허용 범위.

**3. Type consistency:**
- `makeManager()` -> `{ manager, dbPath, dir, cleanup }` (Task1/2/3에서 `dir`/`cleanup` 사용, 일치)
- `installFakeEmbedder()` -> `counter { calls }`, `simulateModelDown()`, `assert` 모두 헬퍼에서 export (일치)
- `syncDocumentFromFile` 반환 타입에 `skipped?/reason?` 추가 -> 인터페이스/스킵반환/정상반환 일치
- `EnhancedSearchResult.search_mode?: 'hybrid' | 'fts-only'` -> Task3 push에서 동일 리터럴 사용
- `this.chunkText(...)` -> `Chunk[]` (`chunk_index/text/start_pos/end_pos/start_token/end_token`), Task1 트랜잭션에서 동일 필드 사용
