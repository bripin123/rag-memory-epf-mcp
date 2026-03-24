# Phase 4: Advanced — rag-memory-epf-mcp v1.9.0

## Why
- Graph traversal이 1-hop만 가능 — "이 entity와 2단계 이상 연결된 것" 조회 불가
- 임베딩 재생성 시 변경 안 된 entity도 다시 계산 — 불필요한 compute 낭비
- 모델이 하드코딩 — 다른 임베딩 모델 사용 불가
- 그래프 분석 알고리즘 없음 (centrality, community 등)

## What
1. Multi-hop Graph Traversal (WITH RECURSIVE CTE) + getNeighbors 도구
2. 임베딩 LRU 캐시 (input hash → 재사용)
3. 모델 환경변수화 (EMBEDDING_MODEL)
4. graphology 통합 (centrality, community detection)
5. 모니터링 기본 (도구별 호출 횟수, 타이밍)

## Risk
- graphology: 새 의존성 추가, 번들 크기 증가
- 모델 환경변수: 차원 불일치 시 DB 마이그레이션 필요
- WITH RECURSIVE: 순환 그래프에서 무한 루프 방지 필요
