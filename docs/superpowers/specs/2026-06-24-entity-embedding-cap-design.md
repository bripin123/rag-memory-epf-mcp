# Entity Embedding Text Cap — Design

> Date: 2026-06-24
> Status: Approved (design)
> Scope: rag-memory-epf-mcp engine (`index.ts`)
> Advisor: cross-model (codex / gpt-5.5 high, read-only) — 1 session, 3 rounds

## 1. 문제 (Problem)

`/sync` 프로토콜이 세션 종료 시 `addObservations`로 entity에 observation을 누적한다. 특히 단일 `PROJECT` entity가 Status/Gotcha observation을 세션마다 append하며 무한히 커진다. 사용자 보고: **`addObservations`가 /sync에서 너무 느리다.**

## 2. 진단 (Diagnosis, 코드 근거)

호출 경로:
- `addObservations` (index.ts:378): entity 배열을 **순차** 순회. `newObservations.length > 0`인 entity만(401행 gate) `await this.embedEntity(entityId)` 호출(410행).
- `embedEntity` (index.ts:1053): `generateEntityEmbeddingText`로 임베딩 텍스트를 만들고 `generateEmbedding`(1518행, bge-m3 1024-dim **로컬 모델 추론**) 실행 후 벡터 교체.
- `generateEntityEmbeddingText` (index.ts:896): entity의 **모든** non-metadata observation을 `. `로 concat (`${type}: ${name}. ${allObservations}`).

병목 축 분리 (advisor 검증):

| 축 | 판정 |
|----|------|
| AXIS 1 (추론 횟수) | **주 문제 아님.** `addObservations`는 이미 변경된 entity만 임베딩(401 gate). clean /sync = 소수 추론. |
| AXIS 2 (단일 추론 길이) | **구조적 병목.** observation이 누적될수록 임베딩 텍스트가 길어지고, bge-m3 추론 비용이 입력 길이에 비례(`model_max_length: 8192`). `PROJECT`는 매 sync마다 긴 텍스트 1회 추론. |

**숨은 버그 (silent truncation)**: transformers.js가 `padding: true, truncation: true`로 8192 토큰에서 자른다. observation은 끝에 append되므로, 한계 초과 후에는 **최신 sync 사실이 임베딩에서 조용히 잘려나가** semantic search(`searchNodes`/`hybridSearch`)에 반영되지 않는다. 즉 비용은 내면서 최신성을 잃는다.

## 3. Advisor 의론 요약 (codex / gpt-5.5 high)

- 옵션 A 원안(`skipEmbed` → `embedAllEntities`)은 `embedAllEntities`가 현재 **전체 entity 재임베딩**(index.ts:1111, skip-current 로직 없음)이라 오히려 악화 → 폐기.
- cap 방식 3안 중 (c) 토큰 budget은 tokenizer 비용 실측(한국어 ~0.7s, 영어 ~3.1s, 8192토큰 ~7.3s)으로 첫 패치에서 강등. **(b) char budget** 채택: tokenizer 없이 길이 비례, 보수적 budget으로 8192 토큰 ceiling 아래 안전 마진. 한국어 ~1.8 char/token 실측 → 12,000자 ≈ 6,600 토큰.
- 모든 cap은 newest-wins이며 오래된 observation을 entity 벡터에서 drop한다. `PROJECT`는 "현재 연속성 상태"를 대표해야 하므로 defensible(오래된 history는 RAG document chunk + 날짜별 entity가 보존 = 본 프레임워크 메모리 계층 설계와 정합). 단 **identity(type+name)는 budget 밖에 유지.**

## 4. 설계 (Design)

### 4.1 변경 대상 (주 수정, 최소 변경)

**(1) `generateEntityEmbeddingText` (index.ts:896) — char budget cap**

- `type` + `name`은 budget 밖에 항상 prepend (entity identity 보존).
- non-metadata observation 필터는 기존 그대로 유지(`Source:`/`Created:`/`Type:`/`Tags:`/`Content length:` 제외).
- observation을 **최신부터 역순**으로 char budget(`ENTITY_EMBED_OBS_CHAR_BUDGET`, 기본 `12000`) 안에서 누적. budget 초과 직전 중단. 선택된 obs는 원래(시간순) 순서로 복원해 join.
- 가장 최신 obs 하나가 단독으로 budget을 초과하면 그것만 잘라(`slice(0, available)`) 포함(빈 임베딩 방지).
- env 미설정 시 기본 12000, 하한 1000(`Math.max`).

행동 동치성: budget 미만 entity(대부분의 작은 entity)는 모든 obs 포함 = **기존과 동일한 임베딩 텍스트**. budget 초과 entity(`PROJECT` 등)만 최신 우선으로 cap.

**(2) `embedEntity` (index.ts:1053) — instrumentation**

- 임베딩 직전/직후 `console.error`(stderr, MCP stdio 무영향 — 기존 409행도 동일 패턴)로 1줄 로그: `entityName`, pre-cap 총 char(필터 후 전체 obs 길이 합), post-cap char(실제 임베딩 텍스트 길이), 선택된 obs 수 / 전체 obs 수, embed 소요 ms.
- truncation 발생(post-cap < pre-cap) 시 명시 표시(🔒 같은 마커).

### 4.2 스코프 제외 (별도·후순위 spec)

- targeted `embedAllEntities({entityNames, onlyChanged})` + `addObservations`의 `skipEmbed` 옵션: AXIS 1이 주 문제가 아니므로 이번 스코프 제외. 213-entity 전체 재임베딩 footgun 제거는 별도 작업.

### 4.3 데이터 흐름

`addObservations` → (변경 entity) `embedEntity` → `generateEntityEmbeddingText`(이제 cap 적용) → `generateEmbedding`(짧아진 텍스트 = 빠른 추론). API 시그니처·도구 스키마 무변경.

## 5. 호환성 / 마이그레이션

- **API 무변경**: 도구 스키마(`knowledge-graph-tools.ts`)·dispatch(index.ts:3167) 불변 → 3 CLI(Claude Code / Codex / agy) 무영향.
- **기존 임베딩**: cap 적용 후에도 DB의 기존 벡터는 그대로. 다음 obs 추가 시 자연 재임베딩되며 cap 적용. 즉시 적용을 원하면 배포 프로젝트에서 `embedAllEntities` 1회(일회성).
- **배포**: npm publish → deployed 프로젝트는 npx @latest 재연결로 자동 노출(기존 관례).
- **하위호환**: env var 미설정 환경은 기본 12000 적용. 작은 entity는 동작 불변이라 회귀 위험 낮음.

## 6. 테스트 (TDD)

테스트 하네스 = node test runner(`test/*.test.mjs`, `npm run verify:engine`). `generateEntityEmbeddingText`는 현재 private. 테스트 접근법은 plan에서 확정(런타임 JS에서 private 접근 가능 = 기존 엔진 테스트 패턴, 또는 임베딩 텍스트를 관찰 가능한 seam으로 노출). 케이스:

1. **budget 미만**: 모든 obs 포함, 기존과 동일 텍스트(회귀 방지).
2. **budget 초과**: 최신 obs 우선 포함, 오래된 obs 제외, 결과 길이 ≤ budget(+identity).
3. **단일 거대 obs**: 최신 obs 하나가 budget 초과 시 잘려 포함(비어있지 않음).
4. **메타 obs 필터**: `Source:`/`Created:` 등 제외 유지.
5. **identity 보존**: `type: name.` 접두가 항상 존재(budget과 무관).
6. **한국어 char**: 한국어 혼합 obs에서 budget 경계 동작 정상.
7. **env override**: `ENTITY_EMBED_OBS_CHAR_BUDGET` 반영, 하한 1000.

기존 테스트(`verify:invariants` + `verify:engine`) 회귀 0 확인.

## 7. 리스크 / 트레이드오프

- **Semantic recall 희생**: 오래된 `PROJECT` observation이 entity 벡터에서 빠짐. 완화 = 본 프레임워크는 오래된 history를 logs/ RAG document chunk + 날짜별 entity로 보존(age-out 손실 0 설계). entity 벡터는 "현재 상태 surface"로 의도.
- **char↔token 근사 오차**: 영어는 token window를 덜 쓰고 한국어는 더 씀. 보수적 12000자 기본으로 8192 ceiling 아래 마진 확보. instrumentation 로그로 실측 후 token budget(c) 재방문 여부 판단.
- **기본값 적정성**: 12000자가 `PROJECT` 실제 규모 대비 적정한지 plan/구현 단계에서 실측 확인.
