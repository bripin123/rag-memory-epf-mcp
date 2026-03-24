# Phase 2: Core Features — rag-memory-epf-mcp v1.7.0

## Why
- hybridSearch가 벡터+그래프만 사용, 키워드 정확 매칭 불가 (FTS5 없음)
- DB 백업/복원 방법 없음 — DB 손상 시 데이터 영구 손실
- embedAllEntities가 순차 처리 — 대량 entity 시 수 분 소요
- better-sqlite3 11.9.1 → 12.8.0 (SQLite 3.49→3.51.3, 쿼리 최적화)
- 타임스탬프가 있지만 시간 범위 필터 없음

## What
1. FTS5 전문 검색 + RRF 하이브리드 통합
2. Export/Import (JSON 백업/복원)
3. Batch embedding (32개씩 병렬)
4. better-sqlite3 12.x 업그레이드
5. Temporal 쿼리 (since/until 파라미터)

## Risk
- FTS5: external content table 트리거 관리 복잡도 증가
- better-sqlite3 12.x: Node 18 드롭 (현재 Node 24 사용, 영향 없음)
- Export/Import: 대용량 DB 시 메모리 사용량 주의
