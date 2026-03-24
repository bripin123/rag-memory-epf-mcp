# Phase 2: Core Features — Tasks

## Tasks
- [x] Task 2.1: FTS5 테이블 생성 (Migration 7)
- [x] Task 2.2: FTS5 동기화 트리거 (Migration 7)
- [x] Task 2.3: hybridSearch에 FTS5 + RRF 통합
- [x] Task 2.4: Export 메서드 + MCP 도구 (exportGraph)
- [x] Task 2.5: Import 메서드 + MCP 도구 (importGraph)
- [x] Task 2.6: Batch embedding 개선 (embedAllEntities) — 32개씩 병렬
- [x] Task 2.7: better-sqlite3 12.x 업그레이드
- [x] Task 2.8: Temporal 쿼리 — searchNodes에 since/until 파라미터
- [x] Task 2.9: 빌드 검증 (tsc) — PASS

## Recent Changes
### 2026-03-24
- **COMPLETED**: Task 2.1-2.2 — Migration 7: entities_fts + chunks_fts (FTS5) + 6 triggers
- **COMPLETED**: Task 2.3 — hybridSearch에 FTS5 BM25 + RRF(k=60) 통합, fts_boost 추가
- **COMPLETED**: Task 2.4-2.5 — exportGraph (full dump) + importGraph (merge/replace 지원)
- **COMPLETED**: Task 2.6 — embedAllEntities batch 32개 Promise.all 병렬 처리
- **COMPLETED**: Task 2.7 — better-sqlite3 11.9.1 → ^12.8.0 (SQLite 3.51.3)
- **COMPLETED**: Task 2.8 — searchNodes에 since/until ISO8601 필터 파라미터
- **COMPLETED**: Task 2.9 — tsc 빌드 성공
