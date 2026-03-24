---
created: 2026-03-24
type: reference
tags:
  - topic/rag-memory
  - topic/mcp
  - topic/upgrade
aliases: [패키지 업그레이드 리뷰, EPF MCP 개선점]
---

# rag-memory-epf-mcp v1.6.0 종합 리뷰

> 2026-03-24 기준. 소스코드 분석 + 의존성 조사 + MCP SDK 변경이력 기반.

---

## P0 — 즉시 수정 (보안/안정성)

| 항목 | 현재 | 개선 | 난이도 |
|------|------|------|--------|
| **MCP SDK** | 1.0.1 (프로토콜 2024-11-05) | 1.27.1 (프로토콜 2025-11-25). **보안 취약점** GHSA-345p-7cg4-v4c7 (CVSS 7.1, 다중 클라이언트 응답 누출) | High |
| **SQL Injection** | `db.exec(\`...${Number(x)}\`)` 패턴 다수 (line 684, 725, 1102, 1278) | Prepared statement로 전환 | Low |
| **SQLite PRAGMA** | 기본값 (DELETE journal, FULL sync) | WAL + NORMAL sync + busy_timeout 5000 + cache_size -32000 + mmap_size 256MB | Low |
| **DB 파일 권한** | OS 기본 (누구나 읽기 가능) | `0600` (owner only) | Low |

### SQLite PRAGMA 권장 설정

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size = -32000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
PRAGMA foreign_keys = ON;
```

---

## P1 — 기능적 핵심 업그레이드

| 항목 | 현재 | 개선 | 난이도 |
|------|------|------|--------|
| **FTS5 전문 검색** | 벡터만. 키워드 정확 매칭 불가 | FTS5 external content table + BM25 + RRF(Reciprocal Rank Fusion)로 3중 하이브리드 (Vector + Graph + FTS5) | Medium |
| **Graph Traversal** | 1-hop만 가능 | `WITH RECURSIVE` CTE로 multi-hop, shortest path, subgraph 추출 | High |
| **Temporal 쿼리** | 타임스탬프 있지만 필터 없음 | `since/until` 파라미터, `getEntityHistory()` | Medium |
| **Relation 업데이트** | 삭제+재생성만 가능. confidence 1.0 고정 | `updateRelations` 도구 + 가변 confidence + metadata | Low |
| **Export/Import** | 없음 | JSON/GraphML 백업/복원. DB 날아가면 현재 복구 불가 | Medium |

### FTS5 통합 방법

```sql
-- External content table (데이터 중복 없음)
CREATE VIRTUAL TABLE entities_fts USING fts5(
  name, observations,
  content='entities', content_rowid='rowid'
);

-- 트리거로 동기화
CREATE TRIGGER entities_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, name, observations)
    VALUES (new.rowid, new.name, new.observations);
END;
```

### 하이브리드 검색 전략 (3중)

1. **Vector** (현재): sqlite-vec 벡터 유사도
2. **Graph** (현재): entity relation 기반 re-ranking
3. **FTS5** (추가): BM25 키워드 매칭
4. **결합**: Reciprocal Rank Fusion (RRF)으로 3개 점수 통합

---

## P2 — 성능/품질 개선

| 항목 | 현재 | 개선 | 난이도 |
|------|------|------|--------|
| **better-sqlite3** | 11.9.1 (SQLite 3.49) | 12.8.0 (SQLite 3.51.3). 쿼리 플래너 최적화, LEFT JOIN 가상 테이블 개선. API 변경 없음. Node 18 드롭 (영향 없음) | Low |
| **sqlite-vec** | 0.1.6 | 0.1.7. DELETE 공간 회수, KNN 거리 제약조건(페이지네이션), 버그 수정 | Low |
| **zod** | 3.x | 4.x (2~7배 빠름). MCP SDK 1.23.0+에서 zod v4 지원 | Low |
| **Batch embedding** | 순차 처리 (1개씩) | `Promise.all` batch (32개씩). 1000+ entity 시 수 분 → 수십 초 | Low |
| **DB 인덱스** | entityType, relationType 인덱스 없음 | 4개 인덱스 추가 | Low |
| **임베딩 LRU 캐시** | 매번 재생성 | `embedding_cache` 테이블 (input hash → vector). 변경 안 된 entity 재임베딩 방지 | Medium |
| **readGraph 페이지네이션** | 전체 반환 (O(N+R)) | limit/offset 파라미터 | Low |
| **hybridSearch 과다 조회** | `limit * 3` 고정 | `limit + 20`으로 최적화 | Low |

### 추가할 DB 인덱스

```sql
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entityType);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity);
CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relationType);
CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entityName);
CREATE INDEX IF NOT EXISTS idx_chunk_metadata_chunk_id ON chunk_metadata(chunk_id);
```

### Batch Embedding 개선

```javascript
// Before: 순차 (느림)
for (const entity of entities) {
    await this.embedEntity(entity.id);
}

// After: 배치 (32개씩 병렬)
const batchSize = 32;
for (let i = 0; i < entities.length; i += batchSize) {
    const batch = entities.slice(i, i + batchSize);
    await Promise.all(batch.map(e => this.embedEntity(e.id)));
}
```

---

## P3 — MCP SDK 업그레이드로 얻는 것

> 1.0.1 → 1.27.1: 프로토콜 2세대 뒤처짐. 약 70개 릴리스.

| SDK 버전 | 새 기능 | 활용처 |
|----------|---------|--------|
| **1.3.0** | `server.tool()` Express-like API | 코드 단순화 |
| **1.11.0** | Tool Annotations (`readOnlyHint`, `destructiveHint`) | `searchNodes`=읽기전용, `deleteEntities`=파괴적 표시 |
| **1.11.5** | Tool Result `content` 필수 | 호환성 (없으면 깨짐) |
| **1.13.0** | Tool `title` 필드, Elicitation | 사용자에게 확인 요청 가능 |
| **1.22.0** | Zod 기반 input/output 스키마 | 타입 안전성 |
| **1.23.0** | Zod v4 지원 | 성능 |
| **1.24.0** | Tasks (비동기 작업 추적) | `embedAllEntities` 같은 장시간 작업 진행률 보고 |
| **1.25.0** | 엄격한 스키마 검증 | 비표준 필드 거부 — 현재 코드 호환성 확인 필요 |
| **1.26.0** | **다중 클라이언트 보안 수정** | **필수** (CVSS 7.1) |

### 주요 Breaking Changes

- **1.10.0**: Streamable HTTP가 SSE 대체 (하위 호환 있음)
- **1.11.0**: 프로토콜 버전 2025-03-26
- **1.11.5**: Tool Result에 `content` 필드 필수
- **1.24.0**: 프로토콜 버전 2025-11-25, Tasks primitive 도입
- **1.25.0**: 비표준 필드 거부 (엄격 검증). 커스텀 속성 있으면 깨짐

---

## P4 — 코드 품질

| 항목 | 위치 | 개선 |
|------|------|------|
| CJK `.toLowerCase()` | line 1122-1140 | 한국어/아랍어에 `.toLowerCase()` 무의미. CJK는 원문 비교 |
| Observation 중복 판정 | line 139-155 | 날짜 strip 후 비교 → 날짜 변경 추적 불가 |
| Graceful shutdown | line 1917-1920 | SIGINT만 처리, SIGTERM 미처리 |
| 모델 하드코딩 | line 56 | 환경변수로 모델 선택 가능하게 |
| graphology | 없음 | centrality, community detection 등 그래프 알고리즘 |
| Entity Aliases | 미지원 | 대체 이름, 번역명 지원 |
| 모니터링 | 없음 | 도구별 호출 횟수, 응답 시간, 에러율 |

---

## 실행 순서 제안

```
Phase 1 (Quick Wins, 1-2일)
├── PRAGMA 최적화 (WAL, cache, mmap)
├── SQL injection → prepared statement
├── DB 인덱스 4-7개 추가
├── Relation update 도구
└── sqlite-vec 0.1.7

Phase 2 (Core Features, 3-5일)
├── FTS5 + RRF 하이브리드
├── Export/Import (JSON 백업)
├── Batch embedding
├── better-sqlite3 12.x
└── Temporal 쿼리 (since/until)

Phase 3 (SDK Upgrade, 3-5일)
├── MCP SDK 1.27.1
├── Tool Annotations 적용
├── Tasks (비동기 작업)
├── zod 4.x
└── 엄격한 스키마 호환성 검증

Phase 4 (Advanced, 1-2주)
├── Multi-hop Graph Traversal
├── graphology 통합
├── 임베딩 LRU 캐시
├── 모델 환경변수화
└── 모니터링/메트릭
```

---

## 참고 자료

- [MCP SDK Releases](https://github.com/modelcontextprotocol/typescript-sdk/releases)
- [MCP Security Advisory GHSA-345p-7cg4-v4c7](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-345p-7cg4-v4c7)
- [better-sqlite3 v12 Releases](https://github.com/WiseLibs/better-sqlite3/releases)
- [sqlite-vec Hybrid Search](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html)
- [SQLite Recommended PRAGMAs](https://highperformancesqlite.com/articles/sqlite-recommended-pragmas)
- [SQLite FTS5 Documentation](https://www.sqlite.org/fts5.html)
- [SQLite WAL Mode](https://www.sqlite.org/wal.html)
