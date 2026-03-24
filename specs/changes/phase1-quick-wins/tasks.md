# Phase 1: Quick Wins — Tasks

## Tasks
- [x] Task 1.1: SQLite PRAGMA 최적화 (index.ts initialize())
- [x] Task 1.2: vec0 rowid 유효성 검증 헬퍼 함수 (index.ts)
- [x] Task 1.3: Migration 6 — 누락 인덱스 추가 (migrations.ts)
- [x] Task 1.4: `updateRelations` 메서드 (index.ts)
- [x] Task 1.5: `updateRelations` MCP 도구 정의 (knowledge-graph-tools.ts)
- [x] Task 1.6: `updateRelations` 핸들러 등록 (index.ts switch)
- [x] Task 1.7: sqlite-vec 0.1.7 + package.json v1.7.0
- [x] Task 1.8: 빌드 검증 (tsc) — PASS

## Recent Changes
### 2026-03-24
- **COMPLETED**: Task 1.1 — PRAGMA 7개 추가 (WAL, NORMAL sync, busy_timeout, cache_size, temp_store, mmap_size, foreign_keys)
- **COMPLETED**: Task 1.2 — `safeRowid()` 헬퍼 함수 추가, 4곳 db.exec + 2곳 INSERT에 적용
- **COMPLETED**: Task 1.3 — Migration 6: idx_entities_type, idx_relationships_type, idx_chunk_entities_chunk, idx_chunk_metadata_chunk_id
- **COMPLETED**: Task 1.4-1.6 — `updateRelations` 메서드 + 도구 + 핸들러 (confidence 가변, metadata 지원)
- **COMPLETED**: Task 1.7 — sqlite-vec ^0.1.7, package version 1.7.0
- **COMPLETED**: Task 1.8 — tsc 빌드 성공
