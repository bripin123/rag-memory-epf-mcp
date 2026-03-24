# Phase 3: MCP SDK Upgrade — Tasks

## Tasks
- [x] Task 3.1: @modelcontextprotocol/sdk ^1.27.1 업그레이드 (package.json)
- [x] Task 3.2: import 경로 및 API 호환성 수정 (TS2589 타입 에러 해결)
- [x] Task 3.3: Tool Annotations 적용 — 26개 도구에 readOnlyHint/destructiveHint/idempotentHint
- [x] Task 3.4: SIGTERM graceful shutdown + ONNX mutex crash 방지
- [x] Task 3.5: 빌드 검증 (tsc) — PASS
- [x] Task 3.6: 런타임 테스트 — 26 tools, migration 7, cleanup 정상

## Recent Changes
### 2026-03-24
- **COMPLETED**: Task 3.1 — MCP SDK 1.0.1 → ^1.27.1 (프로토콜 2025-11-25, 보안 패치 포함)
- **COMPLETED**: Task 3.2 — CallToolRequestSchema 핸들러 타입 수정 (any assertion)
- **COMPLETED**: Task 3.3 — ToolAnnotations 인터페이스 + 26개 도구 분류 (read:9, destructive:5, idempotent:10, default:2)
- **COMPLETED**: Task 3.4 — SIGTERM 핸들러 + process.on('exit') + try-catch cleanup
- **COMPLETED**: Task 3.5-3.6 — tsc 빌드 + 런타임 검증 통과
