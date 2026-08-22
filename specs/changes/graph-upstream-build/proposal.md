# graph-upstream-build — Proposal

> **이 change 는 `graph-role-evaluation` 의 결정에서 나왔다.** 상위 판정 = `eval/graph-role/DECISION.md`
> (갈래 **① upstream-first** · 등급 `provisional` · 정답원 `authored`).
> D8 결정표는 갈래 ① 의 후속을 `entity-link-quality`(또는 seed 매칭 수리) 로 예시했다. 실측된 미달 성분은
> **링크 정밀도가 아니라 edge 커버리지**라서 후속은 링크 품질보다 넓은 **그래프 구축(build) 개선**이고,
> 링크 품질 수리는 그 안의 한 축으로 들어간다.
>
> 아래 **증거 블록만** `eval/graph-role/run-decision.mjs` 가 결정 실행 시점의 실측으로 자동 갱신한다.
> 나머지 절은 사람이 쓴다.

## Why — 랭킹 공식 이전에 탐색할 그래프가 없다

Stage 1 평가(3 corpus · 질의 180 · 대조군 26 사본/corpus)가 낸 상단 사실은 둘이다.

1. **seed 는 들어온다** — 질의가 가리키는 entity 를 검색이 찾는다(93~95%, 게이트 ≥70% 통과).
2. **다리가 없다** — 소스 텍스트가 진술하는 관계(기대 edge)가 KG 에 **대부분 존재하지 않는다**(8~19%, 게이트 ≥80% 미달).

그래서 `graph_boost` 를 어떻게 계산하든, 재랭킹을 어떻게 게이팅하든 **연결이 없는 그래프 위에서 돈다**.
같은 회차의 제품 지표가 그것과 일관된다: K 안전성(known-item) **FAIL 3/3**, 후보 채널 Δrecall@30 은 MCID
미달 3/3, 재랭킹 ΔnDCG@10 도 MCID 미달 3/3. 반면 semantics 축(real vs degree-preserving null)은 **PASS 3/3**
— *"그래프에 신호는 있는데 제품 이득으로 안 온다"* 가 아니라 **"연결 자체가 거의 없다"** 가 이 회차의 진단이다.

<!-- run-decision:evidence:start -->

> 이 블록은 `eval/graph-role/run-decision.mjs` 가 결정 시점의 실측으로 다시 씁니다(2026-08-22T04:27:30.722Z). 손으로 고치지 마세요 — 바깥 절은 사람이 씁니다.

| corpus | seed recall (≥0.7) | edge validity (≥0.8) | link precision · name (≥0.6) | link precision · weighted [95% CI] |
|---|---|---|---|---|
| hub | 57/60 = **95.0%** | 12/62 = **19.4%** | 1.000 (n=14) | 0.237 [0.185, 0.289] |
| uap | 56/60 = **93.3%** | 11/62 = **17.7%** | 1.000 (n=93) | 0.465 [0.370, 0.567] |
| hal | 56/60 = **93.3%** | 5/65 = **7.7%** | 0.989 (n=88) | 0.475 [0.398, 0.549] |

- 정답원 = `authored`(suite 자체 정답) · 등급 `provisional` · 근거 파일 = `eval/graph-role/out/upstream.<c>.jsonl` · `eval/graph-role/out/link-precision.<c>.json` · `eval/graph-role/out/report.md` · 판정 = `eval/graph-role/DECISION.md`
- required edge 중 KG 부재: hub 50 · uap 51 · hal 60

<!-- run-decision:evidence:end -->

## Phase 0 (필수 · 게이트) — Graph-RAG 구축 계보 외부 조사

🔴 **사용자 요구 (2026-08-20, 원문 그대로)**: ***"구축개선 할때 graph rag을 확실히 조사해서 구축하자"***

**이것은 권고가 아니라 착수 게이트다. 조사 산출물 없이 구축 코드를 쓰지 않는다.**

- 최소 대상 계보 = **Microsoft GraphRAG · LightRAG · HippoRAG**. 그 외(예: 커뮤니티 요약 계열, PropertyGraph
  인덱스 계열, 시간축을 다루는 계열)는 조사 중 발견하는 대로 추가한다.
- 각 아이디어마다 **채택 / 개작 / 기각 / 보류** 판정을 근거와 함께 남긴다
  (`docs/protocols/cognitive-model-protocol.md` §3 가감 판정 형식).
- **외부 조사물은 재료지 정답이 아니다** — 우리 실측(위 증거 블록 · `eval/graph-role/out/report.md`)에
  접붙인 분량은 `[우리]` 로 갈라 표기한다.
- 조사 산출물의 자리: 이 change 의 `research.md`(또는 프레임워크 hub 의 `wiki/` 페이지) + 그 요약을 이 proposal 의
  `## What` 에 반영. 조사에서 나온 설계 선택지는 **advisor(D41) 를 거친 뒤** 확정한다.

조사에서 최소한 답해야 하는 질문:

1. **추출(extraction)** — 무엇을 entity 로, 무엇을 relation 으로 만드는가. LLM 추출인가 규칙인가 혼합인가.
   비용·재현성·오염(무관 링크) 특성은?
2. **정규화·해소(canonicalization)** — 같은 것을 가리키는 표면형을 어떻게 합치는가. 우리 `nonliteral`
   provenance 가 여기에 해당한다.
3. **관계 타입 체계** — 자유 텍스트 술어인가 고정 어휘인가. 방향은 어떻게 정하고 confidence 는 어디서 오는가.
4. **인덱스 구조** — 커뮤니티 요약 / 계층 / dual-level 회수 중 우리 SQLite + vec0 구조에 실제로 이식 가능한 것.
5. **회수에서의 역할** — 후보 생성인가 재랭킹인가 traversal 도구인가. (이 change 의 acceptance 1번과 직결)
6. **평가** — 그 계보들이 자기 구축 품질을 무엇으로 재는가. 우리 `edge validity` / `link precision` 과 대응되는가.

## What

(Phase 0 조사 뒤에 채운다 — 지금 적으면 조사가 결론을 따라간다.)

큰 축만 미리 못 박아 둔다:

- **구축(build)** 축 = 추출·정규화·관계 타입·confidence. 여기가 이 change 의 본체다.
- **링크 품질(link)** 축 = 청크↔entity 링크의 정밀도. D8 이 예시한 `entity-link-quality` 가 이 안으로 들어온다.
- **회수(retrieval)** 축 = 구축이 고쳐진 다음에야 의미가 있다. 이 change 는 **회수 계약(`mode`)을 정의만 하고**,
  랭킹 공식의 재판정은 재평가(§Acceptance 4)로 넘긴다.

## Non-goals

- `graph_boost` 계산식 자체의 재설계 — 연결이 생긴 뒤에 다시 잰다.
- v5.3.0 `useGraph` opt-in containment 의 해제 — 재평가가 통과하기 전에는 유지한다.
- Stage 2 holdout 실행 — 이 change 가 출하된 **뒤에** 도는 것이 재평가다.

## Acceptance

1. **명시적 검색 `mode`** — graph 가 회수에서 하는 일이 호출 계약에 박혀 있다:
   `candidate-generation`(후보를 만든다) 인가 `re-rank`(만들어진 후보를 다시 세운다) 인가. 기본값과
   `mode: known-item | explore` 의 대응이 문서·도구 스키마·테스트에 같은 값으로 있어야 한다.
2. **edge 방향 · type · confidence** — 저장·조회·점수 반영에서 셋이 각각 어떻게 취급되는지가 정의되고
   테스트로 고정된다(방향 무시/준수, type 필터, confidence 하한). Stage 1 suite 는 전 hop 이 `any` 였다
   (`eval/graph-role/suite/FREEZE.md` note 1) — 이 change 는 그 축에 신호를 만드는 쪽이다.
3. **latency / quality 예산** — warm p95 SLO(현행 `thresholds.json.latency_slo_ms.warm_p95_max` = 1,000 ms)를
   넘지 않고, known-item 안전성(K Δhit@5 one-sided 하한 > −δ)이 **회귀하지 않는다**. 구축 비용(인덱싱 시간·
   토큰)도 같은 표에 적는다.
4. **재평가 명령** — Stage 1 하네스를 그대로 다시 돌려 판정한다. 명령 원문 = `eval/graph-role/DECISION.md` §9.
   통과 기준 = ① upstream 게이트 3 성분(seed recall ≥ 0.70 · link precision(name) ≥ 0.60 · edge validity ≥ 0.80)
   전 corpus 통과 ② K 안전성 비열등 ③ §227 재현 쿼리 2개가 `useGraph: true` 로도 정답 top-1
   (`docs/superpowers/specs/2026-08-17-graph-role-redesign-design.md` §2).

## Risks

- **LLM 추출은 비용과 비결정성을 함께 들여온다** — 재현 가능한 시드·모델 고정·산출 해시가 없으면 다음 평가가
  같은 그래프를 재지 못한다.
- **링크를 늘리면 `graph_boost` 의 오염도 늘어난다** — 링크 수에 붙는 boost 는 무관 링크를 그대로 이득으로
  바꾼다(hub 세션36 실측: 새 문서 chunk_0 에 무관 Gotcha 링크 55개). 구축 개선이 회수 악화로 나올 수 있다.
- **corpus 셋이 살아 있다** — hub 는 매일 바뀐다. 재평가는 새 스냅샷 위에서 돌고, 그러면 Stage 1 숫자와
  직접 비교되지 않는다(같은 suite·같은 정답원으로 다시 재는 것이 비교의 단위다).

## Contract

이 change 는 다음이 모두 있을 때 끝난다: (1) Phase 0 조사 산출물 + 계보별 채택/개작/기각 판정 (2) 구축 파이프라인
변경 + 테스트 (3) 재평가 실행 결과가 위 Acceptance 4 의 세 기준을 통과 (4) `eval/graph-role/DECISION.md` 를
갱신하는 후속 결정 실행 (5) 프레임워크 tracker(`decisions/current-focus.md` ② · 설계 spec §2) 갱신.
**여기까지 와야 `root repair complete` 다** — `evaluation complete` 는 이미 났다.

## References

- 결정: `eval/graph-role/DECISION.md`
- 상위 change: `specs/changes/graph-role-evaluation/{proposal.md, tasks.md, delta-specs/}`
- 측정: `eval/graph-role/out/report.md` · `out/upstream.<c>.jsonl` · `out/link-precision.<c>.json` · `suite/FREEZE.md`
- 설계 spec(프레임워크 hub): `docs/superpowers/specs/2026-08-17-graph-role-redesign-design.md` §2
