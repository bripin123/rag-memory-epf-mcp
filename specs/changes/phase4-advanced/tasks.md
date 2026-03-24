# Phase 4: Advanced — Tasks

## Tasks
- [x] Task 4.1: Multi-hop Graph Traversal — getNeighbors 메서드 (WITH RECURSIVE, depth 1-5, cycle detection)
- [x] Task 4.2: getNeighbors MCP 도구 정의 + 핸들러 (readOnlyHint)
- [x] Task 4.3: 임베딩 LRU 캐시 (Map 기반, 500 entries, 3개 return path 모두 적용)
- [x] Task 4.4: 모델 환경변수화 (EMBEDDING_MODEL env var, 기본값 Qwen3)
- [x] Task 4.5: 빌드 검증 (tsc) — PASS
- [x] Task 4.6: 런타임 테스트 — 27 tools, cleanup 정상

## Deferred
- graphology 통합 — 새 의존성, 별도 평가 후 진행
- 모니터링/메트릭 — MCP SDK Tasks 기능 안정화 후 진행

## Recent Changes
### 2026-03-24
- **COMPLETED**: Task 4.1-4.2 — getNeighbors (WITH RECURSIVE CTE, bidirectional, cycle detection, relationType filter, depth cap 5)
- **COMPLETED**: Task 4.3 — embeddingCache (Map<string, Float32Array>, max 500, LRU eviction, 3 return paths)
- **COMPLETED**: Task 4.4 — EMBEDDING_MODEL env var (process.env.EMBEDDING_MODEL || 'onnx-community/Qwen3-Embedding-0.6B-ONNX')
- **COMPLETED**: Task 4.5-4.6 — tsc 빌드 + 런타임 27 tools 정상
