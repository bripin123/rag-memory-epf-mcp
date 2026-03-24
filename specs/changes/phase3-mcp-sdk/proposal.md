# Phase 3: MCP SDK Upgrade — 1.0.1 → 1.27.1

## Why
- 프로토콜 2세대 뒤처짐 (2024-11-05 → 2025-11-25)
- 보안 취약점 GHSA-345p-7cg4-v4c7 (CVSS 7.1, 다중 클라이언트 응답 누출)
- Tool Annotations, Tasks, Elicitation 등 새 기능 사용 불가
- 1.25.0부터 엄격한 스키마 검증 — 비표준 필드 거부

## What
1. @modelcontextprotocol/sdk ^1.27.1 업그레이드
2. Tool Result `content` 필드 필수화 대응 (1.11.5)
3. Tool Annotations 적용 (readOnlyHint, destructiveHint)
4. SIGTERM graceful shutdown 추가
5. zod ^4.x 업그레이드 (MCP SDK 1.23.0+ 호환)
6. 빌드 + 런타임 검증

## Breaking Changes to Handle
- 1.11.5: Tool Result에 content 필드 필수
- 1.25.0: 비표준 필드/속성 거부 (엄격 검증)
- 1.24.0: 프로토콜 버전 2025-11-25
- API import 경로 변경 가능성

## Risk
- 별도 브랜치에서 작업, main은 v1.7.0 안정 유지
- 검증 후 merge + publish (v1.8.0)
