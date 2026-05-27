---
type: spec
created: 2026-05-27
tags: [rag-memory, reliability, syncDocumentFromFile, hybridSearch]
status: draft
---

# rag-memory 엔진 신뢰성 강화 (v3.4.x)

> Session 27(2026-05-27) 자가감사에서 deferred된 엔진 개선 3건을 한 spec으로 묶음.
> 대상: `~/Development/rag-memory-epf-mcp/index.ts` (단일 모놀리식, 3,213줄).
> 출처 리뷰: RAG entity `_template + rag-memory v3.4.0 Review (2026-05-27)`.

## 목적

rag-memory-epf-mcp는 AI Project Lifecycle Framework의 **Layer 1 엔진**이고, 모든 deployed 프로젝트의 기억 기반이다. 따라서 엔진의 신뢰성 결함은 프레임워크 전체로 전파된다. Session 27 자가감사가 찾은 3가지 신뢰성 결함을 수정한다:

1. **#1 트랜잭션 부재**: `syncDocumentFromFile`이 `delete -> store -> chunk -> embed`를 트랜잭션 없이 순차 실행. 임베딩 단계가 throw하면 기존 문서는 이미 삭제되고 신규 문서는 부분 임베딩 상태로 남아 rollback 불가.
2. **#2 dedup 부재**: 파일이 변경되지 않아도 매 sync마다 전체 재청킹 + 재임베딩 = 낭비 ("/sync 느림"의 한 원인).
3. **#3 검색 복원력 부재**: `hybridSearch`가 임베딩 모델 다운 시 전체 검색을 throw. FTS5 BM25 인덱스가 살아있어도 활용하지 못함.

## 비목표 (YAGNI)

- standalone 툴 `storeDocument` / `chunkDocument` / `embedChunks`의 동작 변경 (sync 경로만 손댄다)
- 엔티티 검색(`searchNodes`)의 degradation (엔티티는 FTS5 인덱스 대상이 아니므로 BM25 폴백 불가, 범위 외)
- 모놀리식 `index.ts`의 구조 리팩토링 (별도 작업)
- chunkDocument default 광고 오류 등 Session 27 🟢 Polish 항목 (별도)

## 제약 (코드 검증 완료)

- **better-sqlite3 트랜잭션은 동기 함수만 받는다.** 임베딩 생성(`generateEmbedding`, index.ts:1501)은 async (모델 추론). 따라서 `delete~embed` 전체를 단일 `db.transaction()`으로 감쌀 수 없다. 원자성은 "임베딩을 DB 변경 전에 미리 계산"하는 재구성으로만 달성 가능하다.
- `generateEmbedding`은 모델 미초기화 시 throw (index.ts:1528 모델 실패 / 1532 미초기화).
- `documents` 테이블 스키마 = `(id, content, metadata)`, metadata는 JSON 문자열. `content_hash`는 코드 어디에도 없음 (net-new).
- FTS5(`chunks_fts`)는 `chunk_metadata` INSERT 시 trigger로 자동 채워짐 (Migration 7). 즉 chunk_metadata만 넣으면 BM25 검색 가능.
- `hybridSearch`는 이미 FTS 실패에 대한 graceful degradation을 가짐 (index.ts:2362, "FTS가 죽을 때 vector 유지"). #3은 그 정반대 방향이다.

---

## 컴포넌트 1: `syncDocumentFromFile` 원자화 + dedup (#1 + #2)

`syncDocumentFromFile` (index.ts:1537-1591)을 아래 순서로 재구성. 다른 툴은 불변.

### 재구성된 흐름

```
1. content 해석 (sync, fsSync.readFileSync 또는 options.content)
2. sha256(content) 해시 계산
3. [DEDUP 게이트] 기존 doc 조회:
     - 기존 doc 존재
     - AND metadata.content_hash === 새 해시
     - AND 임베딩 완전: chunk_metadata 행 수 == chunks(vec) 행 수 > 0
   3개 모두 참 -> short-circuit:
     { documentId, bytes, skipped: true, reason: 'unchanged', chunks, embeddedChunks } 즉시 반환
4. [임베딩 선계산 — DB 변경 전]
     - chunks = this.chunkText(content, maxTokens, overlap)   // 순수함수, DB 미접근
     - 각 chunk에 대해 await generateEmbedding(chunk.text) -> 메모리 배열 [{chunk, embedding}]
     ── 이 단계에서 throw 시 DB는 전혀 건드리지 않은 상태 = 기존 doc 그대로 ──
5. [동기 트랜잭션] db.transaction(() => {
       cleanupDocument(id) + DELETE old document row
       INSERT document (metadata = {source, updated, content_hash, ...override})
       INSERT chunk_metadata 행들 (FTS5 trigger 자동)
       INSERT 임베딩 (chunks vec, rowid 매칭)
   })()
6. [커밋 후] autoLinkEntities(id) + (options.entityNames 있으면) linkEntitiesToDocument
     - term-matching 기반, idempotent (INSERT OR IGNORE)
     - 실패해도 doc/임베딩 무손상 + 재실행 가능 -> 트랜잭션 밖
7. terse summary 반환 (기존과 동일 + skipped/reason 필드 추가)
```

### 핵심 설계 원리

- **sync 경로는 더 이상 `chunkDocument`/`embedChunks`에 위임하지 않는다.** 두 메서드는 각자 DB에 직접 쓰므로(임베딩 도중 부분 쓰기 발생) "임베딩을 DB 변경 전에 미리 계산"이라는 원자성 전제를 깬다. 따라서 sync는 순수함수 `chunkText` + 인라인 임베딩 루프 + 트랜잭션 내 직접 INSERT로 그 로직을 재구현한다. `chunkDocument`/`embedChunks` 메서드 자체는 자신의 툴 엔트리포인트용으로 **변경 없이 유지** (비목표 준수).
- **모든 async 작업(임베딩)을 DB 변경 전에 완료.** better-sqlite3 동기 트랜잭션 제약을 우회하면서 진짜 all-or-nothing 달성.
- **엔티티 링킹만 트랜잭션 밖.** 링킹은 비파괴적(기존 doc/임베딩을 손상시키지 않음) + idempotent라 트랜잭션 실패와 무관하게 안전. 트랜잭션을 순수 동기로 유지하기 위함.
- **dedup 완전성 게이트.** 단순 해시 일치만으로 skip하면 이전 sync가 임베딩 중간에 실패해 부분 상태로 남았을 때 잘못 skip한다. 그래서 "임베딩 완전" 조건을 AND로 추가.
- **해시 저장**: `documents.metadata` JSON의 `content_hash` 키. 마이그레이션 불필요 (최소 변경). skip 시 `metadata.updated`는 갱신 안 함 (content 불변이므로 의미상 정합).

### 반환 타입 변경 (additive, 비파괴)

기존 필드 유지 + 선택 필드 추가:
```ts
{ documentId, bytes, chunks, embeddedChunks, linkedEntities, explicitlyLinked?, warning?,
  skipped?: boolean, reason?: string }
```

---

## 컴포넌트 2: `hybridSearch` FTS5-only degradation (#3)

`hybridSearch` (index.ts:2210-)의 vector 단계를 임베딩 실패에 대해 복원력 있게 만든다.

### 변경

- primary 임베딩 생성(2219) + variant vector 검색 루프(2268-2279)를 try/catch로 감쌈.
- 임베딩 throw 시:
  - `vectorDegraded = true`, `vectorResults = []`
  - FTS5 경로(2281-2364)는 **그대로 실행** -> BM25 매치를 결과 풀에 채움
    - 현재 FTS-only 결과는 `vectorResults`에 distance=2.0으로 push됨 (2351). vector가 비어도 이 경로로 결과가 생성됨.
    - degraded 모드에서는 RRF(k=60) 융합 대신 BM25 rank 순서를 최종 순위로 사용 (vector rank가 없으므로).
  - `useGraph` 그래프 강화 블록(2374+, 2395에서 임베딩 사용)을 **skip**.
- 각 `EnhancedSearchResult`에 additive 필드 `searchMode: 'fts-only'` 부착 (정상 시 미부착 또는 `'hybrid'`).
- `console.error`로 degradation 경고 로깅.
- 벡터/FTS 둘 다 결과 0이면 기존대로 빈 배열 반환.

### 호출자 영향

- 반환 타입은 array 유지 = 기존 호출자 비파괴.
- degraded 플래그는 결과 항목의 `searchMode` 필드로 노출 (MCP JSON 응답에 자연 포함). 호출 측은 품질 저하를 인지 가능.

---

## 테스트 전략 (TDD)

현재 테스트 = `test/chunk-invariants.test.mjs` (`chunkText` 순수함수 6케이스)뿐. DB-backed 테스트 하네스를 신설한다 (temp 파일 DB 또는 `:memory:` + 마이그레이션 적용 후 사용).

각 변경은 RED -> GREEN 순으로:

- **#1 원자성**: `generateEmbedding`이 throw하도록 모킹/강제 -> `syncDocumentFromFile` 실패 후 기존 doc/chunk_metadata/chunks(vec)가 변경 전과 동일함을 assert (부분 상태 없음).
- **#2 dedup**:
  - 동일 content 재sync -> 재임베딩 호출 0회 (spy) + `skipped: true`
  - content 변경 -> 정상 재sync (skipped 아님)
  - 부분 상태(임베딩 누락) -> 해시 일치해도 skip 안 함
- **#3 degradation**: 모델 미초기화 상태에서 `hybridSearch` -> throw 대신 FTS5 결과 + `searchMode: 'fts-only'` 반환.

`package.json` `prepublishOnly` 게이트에 신규 테스트 포함.

## 검증 포인트 (구현 중 확정)

- vec0 가상 테이블 INSERT가 동일 `db.transaction` 블록 내에서 정상 동작하는지 (마이그레이션들이 이미 db.transaction 사용 = 가능성 높음, #1 테스트로 확정).
- `searchMode` additive 필드가 `EnhancedSearchResult` 타입 + MCP 응답에서 호출자에게 자연 노출되는지.

## 버전 / 배포

- minor bump 권장 (v3.5.0): 동작 추가(degradation, dedup, skipped 필드)이며 기존 동작 비파괴.
- README의 syncDocumentFromFile / hybridSearch 항목 갱신.
- **npm publish + GitHub push는 별도 사용자 승인** (외부 배포 = outward-facing).
- deployed 18개 프로젝트는 `/mcp` 재연결 시 자동 노출 (선제 cascade 불필요).

## 영향 받는 파일

- `index.ts`: `syncDocumentFromFile` 재구성 (#1+#2), `hybridSearch` degradation (#3), 반환 타입/`EnhancedSearchResult` additive 필드.
- `test/` (신규): DB-backed 테스트 하네스 + 3개 테스트 그룹.
- `package.json`: 신규 테스트를 prepublishOnly에 연결, version bump.
- `README.md`: 변경 동작 반영.
