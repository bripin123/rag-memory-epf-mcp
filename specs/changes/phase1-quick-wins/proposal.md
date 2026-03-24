# Phase 1: Quick Wins — rag-memory-epf-mcp v1.7.0

## Why
- SQLite 기본 설정(DELETE journal)은 읽기/쓰기 동시성과 성능이 낮음
- vec0 가상 테이블의 `db.exec` template literal 패턴에 rowid 유효성 검증 없음
- entityType, relationType 등 자주 조회되는 컬럼에 인덱스 누락
- Relation 업데이트 시 삭제+재생성만 가능, confidence 1.0 고정
- sqlite-vec 0.1.6 → 0.1.7 (DELETE 공간 회수, KNN 거리 제약조건)

## What
1. SQLite PRAGMA 최적화 (WAL, cache, mmap 등 7개)
2. vec0 rowid 유효성 검증 헬퍼 함수 추가
3. Migration 6: 누락 인덱스 추가
4. `updateRelations` 메서드 + MCP 도구 추가
5. sqlite-vec 0.1.7 업그레이드

## Impact
- 쓰기 성능 2-5x 향상 (WAL)
- 동시 읽기/쓰기 가능
- SQL injection 안전성 강화
- Relation confidence 가변 지원
- DELETE 시 벡터 공간 회수 (sqlite-vec 0.1.7)

## Risk
- WAL 모드: WAL 파일 크기 증가 가능 (주기적 checkpoint로 관리)
- sqlite-vec 0.1.7: 마이너 업그레이드, API 변경 없음
- PRAGMA foreign_keys = ON: 기존 데이터에 고아 참조 있으면 영향 가능
