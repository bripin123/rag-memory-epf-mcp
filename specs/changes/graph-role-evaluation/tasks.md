# graph-role-evaluation — Tasks (v2 · advisor r4 반영 · DAG 수정 · 2단계)

> 상세 실행 플랜(bite-sized · 코드 포함) = `docs/superpowers/plans/2026-08-17-graph-role-evaluation-stage1.md` (Stage 1). **Stage 2 플랜은 Stage 1 의 `suite/POWER.md`(pilot 분산 → holdout N)가 나온 뒤 쓴다** — 그 수치 없이는 Stage 2 의 표본 크기·판정 예산을 적을 수 없다(placeholder 금지).
> 실행 순서(R6 · r4 blocking ③): `suite freeze → snapshot → controls → run-candidates + run-final(모든 조건) → pool → judging → qrel freeze → run-upstream → report → decision → 후속 change 개설`.
> 상태 표기: `[ ]` 미착수 · `[x]` 완료.

## Stage 1 — 계측기 + pilot(dev) + 검정력 산정

- [ ] **T1 제품 seam + differential parity** — (a) 추출 **전**에 `test/fixtures/graph-context/` stub 임베딩 픽스처 DB 빌더 + golden 기록 스크립트로 `test/fixtures/graph-context-golden.json` 생성·commit (b) `index.ts` 에서 seed/연결 블록(`:3654~3730`)을 `explainGraphContext(query)` 로 추출(status 3분기 보존 · edge_id/type/direction/confidence · 결정적 정렬) · hybridSearch 가 호출 (c) `test/graph-context-explain.test.mjs`(R2 시나리오 4 + golden byte 비교 9 케이스) + `package.json` `verify:engine` 배선.
  완료 기준: golden 9 케이스 byte 동일 · `search-graph-default.test.mjs`·`search-contracts.test.mjs` GREEN · `npm test` EXIT 0(파이프 없이). 검증 = `npm test > log 2>&1; echo EXIT:$?`.
- [ ] **T2 harness 기반** — `eval/graph-role/{lib/db.mjs, lib/freeze.mjs, lib/rrf.mjs, snapshot.mjs, thresholds.json, .gitignore, README.md}`. `db.mjs` = 사본만(원본 3경로 거부 exit 4) · SUMMARIES=off 강제 · gate.start→reconciliation→ready · 폴백 stderr 카운트. `snapshot.mjs` = 3 corpus online backup → `dbs/<corpus>.db` + `snapshot.json`. `thresholds.json` = MCID 3종 · δ · SLO · upstream 게이트 · 판정 예산(proposal D8 값) — **holdout 전 동결 대상**.
  완료 기준: 3 사본 + snapshot.json(sha256·bytes·source·taken_at·엔진 commit) · 원본 mtime 무변 · pure 테스트(`test/eval-graph-role-libs.test.mjs`) freeze/refuse/RRF GREEN.
- [ ] **T3 suite 프로토콜·도구·pilot 작성·1차 동결** — `suite/PROTOCOL.md`(부류 · qrel 단위 · **source-grounded 규칙**: 작성자는 documents.content + entities.name 만 · relationships/chunk_entities 금지 · seed 후보 = 정규 이름 literal 문서 수 ≥ 3 · M = 두 문서를 잇는 공통 entity · family · dev/holdout · 동결) · `make-known-item.mjs`(K 60/corpus · document 당 1 · dev 30 / holdout 30 document 분리) · `list-seeds.mjs`(텍스트 기준 seed 후보 + 문서 제목 · **degree·연결 대상 미표시**) · `author-context.mjs`(질의 작성용 문서 본문 발췌 · 정규 이름 목록) · A 30 + M 30 / corpus(dev) 를 AI 가 프로토콜대로 작성 · `freeze.mjs --validate`(스키마 · leakage · family) · `FREEZE.md` + commit · `extract-observed.mjs` → `suite/observed.<corpus>.jsonl`.
  완료 기준: 3 corpus × (K 60 + A 30 + M 30) 검증 통과 · FREEZE 해시 = 파일 · commit 해시 · `out/` 비어 있음(어떤 러너도 이 전에 안 돌았다는 증거) · observed 파일 3개.
- [ ] **T4 대조군 사본** — `lib/controls.mjs`(directed degree-preserving double-edge swap · type-preserving swap · ER) · `make-controls.mjs --corpus <c>` → shuffled-r0..19 · typeshuf-r0..4 · random 사본 26개/corpus + 노드별 (in,out) 검증(실패 exit 6) + mixing 로그.
  완료 기준: R5 시나리오 pure 테스트(합성 그래프 · 노드별 degree 동일 · self-loop 0 · duplicate 0) GREEN · 3 corpus × 26 사본 · 검증 로그.
- [ ] **T5 채널·최종 랭킹 러너** — `lib/stages.mjs`(seam 호출 → chunk link → 채널 9종 at K∈{10,30,100} · chunk-K/document-K · graph-reach · 점수 전파·tie-break · warm/cold ms) · `run-candidates.mjs --corpus <c> --cond <cond>` → `out/candidates.<c>.<cond>.jsonl` · `run-final.mjs --corpus <c> --cond <cond>`(제품 off/on · 고정 pool 재랭킹 · ms) → `out/final.<c>.<cond>.jsonl`. dev 전 조건 실행(real · shuffled-r0..19 · typeshuf-r0..4 · random) — 프로세스 한 번에 하나.
  완료 기준: R3 pure 테스트(예산 · 결정성 · RRF 컷) GREEN · 3 corpus × 26 조건 × 2 러너 산출 · degraded 0 · `unfrozen:false`.
- [ ] **T6 pooling·판정·qrel 동결** — `pool.mjs`(모든 채널×조건 + 최종 top-10 · 깊이 100 증분 · real 만이면 exit 7 · 채널 정보 제거 판정 입력 + 문서 제목·인접 청크) · `suite/JUDGING.md`(판정자 A/B/C · temperature · 순서 seed · 루브릭) · 판정 2회 + 조정 · `judge-merge.mjs`(weighted κ 게이트 0.67 · 불일치 목록 · 등급 decision-grade/provisional) · unpooled 100/corpus missed-relevant · `suite/human-audit.<c>.jsonl` 자리(사용자 audit 50쌍/corpus — 하면 decision-grade) · FREEZE 2차.
  완료 기준: A·M 60/corpus 전부 판정 · κ ≥ 0.67(미달 시 재판정 기록) · 조정 후 불일치 0 · missed-relevant rate · qrels 해시 FREEZE.
- [ ] **T7 upstream 지표 + link audit** — `run-upstream.mjs`(seed recall · edge validity 플래그 · encoded-path coverage · projection recall · hub-degree 조건부 오랭킹률 → `out/upstream.<c>.jsonl`) · `link-audit-sample.mjs`(층화 20×3 · 청크당 ≤15 · provenance name/nonliteral · 정확 mention 질문) · 판정 + `link-audit-merge.mjs`(chunk-cluster CI · prevalence weighting → `out/link-precision.<c>.json`).
  완료 기준: 3 corpus 산출 · provenance 규칙 pure 테스트 GREEN.
- [ ] **T8 통계·보고 + 검정력 산정** — `lib/metrics.mjs`(recall@K doc · MRR · nDCG@10 · hit@k · sign test 정확 이항 · bootstrap 10,000 고정 seed · cluster 지정 · 비열등성 CI · Holm) · `report.mjs`(primary 5 endpoint gatekeeping · corpus별 + stratified macro · n/usable) → `out/report.md` · `power.mjs`(pilot 짝지은 Δ SD·불일치율 → 검정력 0.8 · corpus 별 holdout N · 판정 예산 대비) → `suite/POWER.md` + FREEZE.
  완료 기준: metrics pure 테스트(손계산 fixture) GREEN · report.md · POWER.md(N 표 · 예산 초과 여부) · **Stage 1 결론 = provisional 표시**.

## Stage 2 — holdout 실행 · 결정 · 후속 change 개설 (플랜 = POWER.md 뒤 작성)

- [ ] **T9 holdout suite 작성·동결** — POWER.md 의 N 으로 A/M holdout 작성(family-disjoint · source-grounded) + K holdout 30 · FREEZE(thresholds·POWER 포함) · observed 추출.
- [ ] **T10 holdout 전 조건 실행 → pool → 판정 → qrel 동결** — T5·T6 절차 반복(holdout).
- [ ] **T11 결정 → DECISION.md + 후속 change 개설** — `run-decision.mjs`(동결 검사 → gatekeeping 다섯 갈래 → semantics 축 → provisional 이면 remove 금지) → `DECISION.md` · 같은 commit 에 `specs/changes/<selected>/proposal.md`(acceptance: `mode` · 방향/type/confidence · latency/quality · 재평가 명령) · 프레임워크 tracker receipt 경로 기록 · §227 재현 쿼리 2개 관찰.
  완료 기준: DECISION.md · 갈래 1개(다섯 중) · 후속 change 디렉터리 존재 · receipt 경로 · `npm test` EXIT 0 · commit.
- [ ] **T12 마감** — README 완성 · `out/` 등 commit · 상태 = `evaluation complete`(root repair 는 후속 change).

## Test Plan (Phase 3b)

| 대상 | 경로 | 분류 | 커버 |
|---|---|---|---|
| seam 추출 = 행동 무변(differential parity 9 케이스 + 분기 3) | `test/graph-context-explain.test.mjs` + `test/fixtures/graph-context-golden.json` | [Unit·stub 임베딩 픽스처] | ★★★ |
| useGraph 기본/opt-in 계약 유지 | `test/search-graph-default.test.mjs`(기존) | [Unit] | ★★★ (회귀) |
| freeze 해시·leakage·family · refuse live · RRF · 예산 컷·결정성 · provenance · controls(노드별 degree) · metrics(nDCG·MRR·sign·bootstrap·비열등성·Holm) · κ · power | `test/eval-graph-role-libs.test.mjs` | [Unit·pure] | ★★★ |
| 러너 실행(모델 필요) | `run-candidates.mjs`/`run-final.mjs` 실측(hub dev) | [E2E] | ★ 스모크(형태 · degraded 0) |
| 판정 품질 | κ · 사람 audit · missed-relevant | [Eval] | 보고 지표 |
COVERAGE 목표: 제품 변경분(seam) 100% · harness pure lib 100% · 러너 스모크. Regression Rule: `index.ts` 수정 → T1 golden parity 가 그것이다.

## Definition of Done (Phase 4 — 이 change 의 완료 게이트)

1. suite(pilot + holdout N) 동결 · source-grounded 주석 · observed 분리 · leakage 0 — R1
2. seam differential parity GREEN · `npm test` EXIT 0 · MCP 도구 계약 무변 — R2
3. 채널(9종 · K 10/30/100 · chunk/document 예산) · 최종 랭킹 · upstream · 대조군(replicate 20+5+1) raw JSONL 이 3 corpus 전부 · `unfrozen:false` — R3·R4·R5
4. pool 이 모든 채널×조건 + 최종을 포함(exit 7 미발생) · qrels(κ ≥ 0.67 · 조정 0 · 등급 명시) 2차 동결 · missed-relevant rate — R6·R7
5. `out/report.md` primary 5 endpoint gatekeeping · Holm · CI · n/usable · stratified macro — R8
6. `thresholds.json`·`POWER.md` holdout 전 동결 · `DECISION.md` 갈래 1(다섯 중) · provisional 이면 remove 없음 — R9
7. 러너 격리(SUMMARIES=off · 원본 거부) — R10
8. **후속 SDD change 디렉터리가 같은 commit 에 존재** + tracker receipt 경로 — R11
9. 산출 commit(dbs/ 제외) — R12 · 상태 = `evaluation complete`(≠ root repair complete)

## Plan Consistency Receipt (Phase 4 · 2026-08-17 세션37)

**읽은 문서**: `proposal.md`(v2) · `delta-specs/graph-role-evaluation.spec.md`(v2) · 이 `tasks.md`(v2) · `docs/superpowers/plans/2026-08-17-graph-role-evaluation-stage1.md`(Stage 1 · 8 tasks · 124KB) · `CODE_CONTEXT.md`(엔진) · 프레임워크 spec v2 §2 · advisor r4 원문.
**skip**: `python3 scripts/project_map/cli.py --drift` — 이 repo 에는 `scripts/project_map`·PROJECT_MAP 이 없다(프레임워크 도구) → 해당 없음. CODE_CONTEXT 에 Domain Architecture Map 절이 없어 public 이름 대조는 수동: 새 public 이름 = `RAGKnowledgeGraphManager.explainGraphContext`(MCP 도구 아님 · 도구 목록/스키마 무변 · `test/tool-contracts.test.mjs` 영향 0). CODE_CONTEXT §7 File References 에 seam 한 줄 추가는 T1 구현 시 같이 한다(패턴 변경 아님).

| # | 대조 | 결과 | 조치 |
|---|---|---|---|
| 1 | proposal 목표(What 1~5) ↔ delta R1~R12 | 충돌 없음. What 5 의 "후속 change 를 같은 commit 에 연다" = R11 | — |
| 2 | R1~R12 → task 연결 | R1→T3 · R2→T1 · R3→T5 · R4→T7 · R5→T4 · R6→T5 driver+T6 · R7→T6 · R8→T8 · R9→T2(thresholds)+T8(POWER)+**T11(run-decision, Stage 2)** · R10→T2 · R11→**T11(Stage 2)** · R12→T2/T12. Stage 2 의존분(R9 결정·R11 개설)은 **명시적 defer**(POWER.md 뒤 플랜 작성) | 플랜 §Self-Review 1 에 동일 기재 |
| 3 | 각 task 완료 기준 + 검증 방법 | T1~T12 전부 완료 기준 있음 · 검증 = 테스트/명령/산출 파일 존재. 사람 판정 단계(T6 judging · human audit)는 파일 산출로 검증 | — |
| 4 | delta R2 시그니처 ↔ 플랜 T1 | 플랜은 `explainGraphContext(query, queryVariants?)` — 선택 인자 1개 초과분(hybridSearch 가 변형 재계산을 피함). R2 의 `(query)` 호출 계약은 그대로 성립 | delta R2 에 "선택 인자 `queryVariants?` 허용" 1줄 추가(아래) |
| 5 | proposal D2 "증분 pooling(30 → 31~100 포화 검사)" ↔ 플랜 T6 pool.mjs | v1 플랜은 chunk100 을 한 번에 pooling — **불일치** | 플랜 패치: `tier: top30 | deep` + 포화 규칙(단일 채널만 찾은 relevant 가 있는 질의만 deep 판정) + `pool_truncated` 플래그 |
| 6 | README exit code 목록 ↔ 러너 exit 코드 | 9·10·11·12 누락 — **불일치** | 플랜 T2 README 줄 패치(9 MODEL_NOT_READY · 10 SOURCE_MTIME_CHANGED · 11 JUDGE_INCOMPLETE · 12 ADJUDICATION_PENDING) |
| 7 | placeholder/TBD/TODO | 플랜·tasks·delta 에 0건(grep). FREEZE.md 의 commit 열은 commit 뒤 채우는 값 = 2-commit 절차 명시 | — |
| 8 | 임계값 위치 | thresholds.json(플랜 T2) = proposal D8 값과 동일(MCID 0.05/0.05/0.03 · δ 0.02 · SLO 1000ms · gate .70/.60/.80 · κ .67 · audit 50/20% · 예산 8000) | — |
| 9 | 통계 단위 | delta R8(K=document, A·M=family) ↔ 플랜 report/power(K cluster = family = document_id · A/M cluster = family) 일치 | — |

**판정**: mismatch 2건(#5·#6) 은 플랜 패치로 닫았고 #4 는 delta 1줄 보강. **Receipt 성립 → Phase 5 진입 가능(사용자 확인 후).**

## Deferred / Observations
- KG 청크 = 3/3 corpus 0개(dormant) — `chunk_type` 분포만 기록. 판정은 별도.
- `auto` intent gate = 데이터 축적 후.
- Stage 2 플랜 = POWER.md 뒤(placeholder 대신 시점 명시).
