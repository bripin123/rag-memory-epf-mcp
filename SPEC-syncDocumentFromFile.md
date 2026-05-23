# Spec: `syncDocumentFromFile` MCP tool (option ①)

> 작성 2026-05-23. 목적: /sync 느림(고컨텍스트 세션에서 40~50분)의 근본 원인 제거.
> 원인 진단: 느림은 MCP compute(157 entity·12ms 쓰기)나 언어(Node vs Rust)가 아니라,
> **문서 내용 + 장황한 tool 결과가 LLM 컨텍스트를 경유**해서 매 턴 거대 컨텍스트(예: 72%/724k)를 재처리하기 때문.

## Goal
서버측에서 Document Sync 파이프라인 전체(read file -> store -> chunk -> embed -> link)를
**1콜**로 수행하고 **terse 요약만 반환**하는 MCP tool 하나 추가. 임베딩 모델은 서버 프로세스에
이미 warm 상태(modelInitialized, dist line 99)라 콜드로딩 없음. 현재 동작 대비 무손실(앵커 가드 포함).
content-hash 게이팅(②)·+β deep 분리(③)는 **비포함**.

## Why this is the speed win (compute 아님, context+turn)
- 현재 문서당: LLM이 파일을 컨텍스트로 Read + 5콜(delete/store/chunk/embed/link), 각 콜이 청크 전문 등 큰 payload를 컨텍스트에 반환. 고컨텍스트에서 매 턴 전체 재처리 -> 관측 40분.
- 이 tool: 문서당 1콜, 내용은 서버측에서 읽어 **LLM 컨텍스트 미경유**, 반환은 counts만 -> 컨텍스트 평탄, 턴 5/문서 -> 1/문서.
- 임베딩 compute 자체는 동일(같은 모델·청크). win은 context+turn 수이지 compute 아님.

## Tool
- name: `syncDocumentFromFile`
- args:
  - `path` (string, required): 절대경로. 내용은 서버측에서 읽음.
  - `documentId` (string, required): RAG document id.
  - `metadata` (object, optional): 저장 metadata에 merge. `updated` 미지정 시 오늘(YYYY-MM-DD).
  - `content` (string, optional): override. 주면 파일 대신 이걸 저장(큐레이션 escape hatch). 기본 = 파일 raw.
  - `entityNames` (string[], optional): auto term-match 외 추가로 명시 링크할 entity.
  - `chunkParams` (object, optional): { maxTokens, overlap }. 기본은 현재값과 동일.
- 동작(서버측 순서):
  1. `path`에서 raw 내용 읽기 (또는 `content` override).
  2. (guard) wiki 문서인데 내용에 앵커(`RAG entity:` 또는 entity 이름 literal)가 없으면 `warning` 필드 반환(자동 주입 X, 경고만).
  3. deleteDocuments(documentId) — 옛 청크/임베딩/링크 제거.
  4. storeDocument(documentId, content, {...metadata, updated}).
  5. chunkDocument(documentId, chunkParams).
  6. embedChunks(documentId) — term-match로 entity auto-link 동반.
  7. entityNames 있으면 linkEntitiesToDocument(documentId, entityNames).
- return (terse, 청크 전문/내용 echo 없음):
  `{ documentId, bytes, chunks, embeddedChunks, linkedEntities, warning? }`

## Content 결정: RAW verbatim (권장)
근거: (a) 목적이 "내용을 LLM 컨텍스트로 안 보냄"이라 LLM이 압축할 수도 없음. (b) raw가 hybridSearch
충실도 높음(실제 파일 텍스트 반환). (c) raw/wiki/schema 레이어링과 정합. trade-off: raw = 압축본보다
청크↑ -> 임베딩 시간 약간↑(초 단위, 임베딩은 싼 부분이라 수용). `content` override는 드문 큐레이션용으로 유지.

## Lossless check vs 현재
- store/chunk/embed/link = 동일 메서드 재사용 -> 동작 손실 0.
- embedChunks auto-link = 현재와 동일(청크 텍스트 term-match; raw가 매칭 더 잘됨).
- 앵커 = warning으로 가드(현재는 LLM이 추가하던 것).
- 세션 log / +delta / Recently Completed(컨텍스트 의존) = **불변**, 계속 LLM이 함. 이 tool은 file->DB 기계적 파이프라인만 대체.
- content-hash 게이팅 없음 -> 대상 문서는 매번 완전 재sync -> staleness 도입 안 함.

## Non-goals
- content-hash 게이팅(②) 미포함.
- fast/deep +β 분리(③) = 별도 프로토콜 변경.
- model-version keying = ② 없으면 불필요.

## Implementation
- `src/tools/rag-tools.ts`에 capability/description/schema/definition 패턴으로 tool 추가 + tool-registry + dispatcher 등록.
- 핸들러는 기존 RagKgManager 메서드(storeDocument/chunkDocument/embedChunks/linkEntities)를 순차 호출 + fs로 파일 읽기.
- build: `npm run build` (tsc). test: `npm run test`(chunk invariants) + 신규 수동 테스트: 임시파일->임시DB sync -> chunks>0, embeddedChunks==chunks, return terse 검증.
- backward compatible: additive, 기존 tool 불변.

## Rollout
1. branch `feat/sync-document-from-file`.
2. 구현 + build + 임시 DB 로컬 테스트.
3. terse 반환 + warm 모델 재사용(콜 사이 미재로딩) 확인.
4. version 3.3.6 -> 3.4.0 (신규 기능).
5. **npm publish는 사용자 명시 OK 후에만** (npx @latest로 전 deployed에 영향, npx 캐시 갱신 필요).
6. Part B(별도): RAGMemory `_template` + 3 CLI 어댑터의 /sync Step 5b를 수동 5콜 대신 syncDocumentFromFile 호출로 변경. 프로젝트별 customization 보존(cascade 룰).

## Risk / rollback
- additive tool -> 저위험. 문제 시 /sync는 기존 수동 tool로 fallback(Part B 독립 revert 가능).
- publish가 유일한 outward-facing 단계 -> 명시 OK로 게이트.
