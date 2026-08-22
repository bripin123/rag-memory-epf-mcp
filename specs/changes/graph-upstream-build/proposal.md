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
2. **정규화·해소(canonicalization)** — 같은 것을 가리키는 표면형을 어떻게 합치는가.
   ⚠ **초안은 여기에 우리 `nonliteral` provenance 를 예로 들었는데 그건 오독이다** — `provenanceOf` 의 `nonliteral` 은
   «entity 이름이 그 청크 본문에 문자열로 없다» 는 뜻이지 표면형 변이가 아니다(2026-08-22 코드 확인).
3. **관계 타입 체계** — 자유 텍스트 술어인가 고정 어휘인가. 방향은 어떻게 정하고 confidence 는 어디서 오는가.
4. **인덱스 구조** — 커뮤니티 요약 / 계층 / dual-level 회수 중 우리 SQLite + vec0 구조에 실제로 이식 가능한 것.
5. **회수에서의 역할** — 후보 생성인가 재랭킹인가 traversal 도구인가. (이 change 의 acceptance 1번과 직결)
6. **평가** — 그 계보들이 자기 구축 품질을 무엇으로 재는가. 우리 `edge validity` / `link precision` 과 대응되는가.

## What

> Phase 0 조사 완료(2026-08-22). 정본 = 프레임워크 hub `wiki/graphrag-lineage-survey-2026-08.md`
> (계보 6종 × 6질문 · 가감 판정 **16건** · 우리 corpus 실측). `[조사]` = 남의 실측, `[우리]` = 우리 DB 에서 잰 것.
> **이 절은 D41 advisor(codex gpt-5.6-sol · cross-vendor) 1라운드를 거쳤다** — 초안 판정 **NO-GO**, blocking 4건.
> 원문 = hub `raw/advisor/2026-08-22-graph-upstream-what/r1-codex.md`. 아래는 그 지적을 반영한 판이다.

### 🔴 범위 판정 — 이 change 는 현재 자기 Acceptance 를 통과할 수 없다 (사용자 결정 필요)

**사실**: Acceptance 4 의 `edge validity` 는 **`relationships` 테이블 행에서만** 계산된다
(`eval/graph-role/run-upstream.mjs`). 그런데 아래 W1 은 `chunk_entities` 를 고치고 W2 는 그것을 읽을 뿐이다 —
**둘 다 edge validity 를 한 행도 못 움직인다.** 따라서 *"가장 싼 길"* 로 적었던 W1+W2 는 이 change 의
합격 기준을 **원리적으로** 통과하지 못한다.

`[advisor 실측]` 공기(共起)로 때우는 것도 안 된다: UAP 스냅샷에서 required 끝점 쌍 62개 중 **한 청크라도 공유하는 것이 45개**다.
따라서 «기존 관계 ∪ 모든 동일-청크 쌍» 의 상한이 **45/62 = 72.6%** 이고, 문장 범위 공기는 그것의 진부분집합이다.
**모든 공기를 유효 관계로 쳐 주는 비현실적 가정 아래에서도 0.80 게이트에 못 닿는다.**

**선택지와 비용**:

| | 무엇을 하나 | 비용 | 결론 등급 |
|---|---|---|---|
| **① 분리 (내 판정)** | W1+W2 를 **별도의 회수 실험 change** 로 떼고, `graph-upstream-build` 는 **출처 근거 관계 빌더(W3)** 를 본체로 남긴다 | 실험은 색인 토큰 0 · 관계 빌더는 별건으로 미룸 | 실험은 `experiment` · 이 change 는 **열린 채로 정직** |
| ② 관계 빌더를 이번에 넣는다 | W3 를 LLM 추출 포함 본체로 승격 | **판정 #6 이 보류한 그것** — 수만~수십만 호출 급 | 통과하면 `root repair` 후보 |
| ③ edge validity 게이트를 낮춘다 | — | 0 | 🔴 **기각.** advisor 원문: *"Do not weaken edge validity and still call it root repair."* 실패의 이름을 성공으로 바꾸는 것이다 |

**내 판정 = ①.** 근거: W1+W2 는 싸고(색인 토큰 0) 그 자체로 값을 하며, 관계 빌더는 조사에서 **이미 «보류»로 판정된 것**이라
그것을 슬쩍 본체로 들이는 것은 조사 결론을 뒤집는 일이다. 그리고 W1+W2 를 이 change 안에 두면
**«root repair 완료»로 오독될 자리**가 생긴다. ⚠ **범위 변경은 사용자 결정이다** — 아래 W1~W5 는 ① 을 가정하고 쓰였고,
②를 고르면 W3 가 본체로 올라오면서 Acceptance 2·4 개정이 함께 필요하다.

### W0. 전제 정정 — 이 change 는 «개선»이 아니라 «신설»이다 (advisor 보호 항목)

`[우리]` **우리 엔진의 문서 적재 경로에는 관계를 뽑는 단계가 없다.** `createRelations` 를 부르는 곳은 MCP 도구
핸들러와 테스트뿐이고, 적재가 하는 일은 `autoLinkEntities` 의 **청크↔entity 링크**(`chunk_entities`) 생성이다.
따라서 Why 절의 `edge validity 8~19%` 는 **추출기의 결함이 아니라 추출기의 부재**이고, KG 의 edge 는
**세션 서사에 대한 수작업 진술**이지 문서 본문에서 유도된 것이 아니다. 즉 edge 와 청크는 **같은 근거 위에 서 있지 않다.**

### W1. 링크 층 — 원인이 실측으로 바뀌었다 (링커 튜닝이 아니다)

`[우리]` 실측 (2026-08-22 · hub 현행 스냅샷 · 청크 **2,844** · entity **593** · 링크 **65,632**):

| 잰 것 | 값 |
|---|---|
| 링크 0 청크 | **870 / 2,844 = 30.6%** (세션42 의 863/2,827 = 30.5% 와 정합) |
| 그 분포 | `wiki-gotchas` 139/299 = **46.5%** · `wiki-project-context` 71/139 = **51.1%** — **SSOT 두 파일의 절반** |
| 청크당 링크 | 평균 23 · 중앙값 8 · 최대 170 (상위 10 entity 가 전체의 11.1% · `AI Project Lifecycle Framework` 단독 1,613) |
| 문서 내 위치 효과 | 첫 청크 평균 32.6 → 6번째 이후 21.4 (링크0 비율 27.5% → 32.7%) = **완만한 기울기이지 절벽이 아니다** |

🔴 **원인 진단 (이번에 잰 것 · 초안의 W1-a 를 폐기시켰다)**: 링크 0 청크 870개 중 **알려진 entity 이름이 본문에
문자열로 들어 있는 것은 3개(0.3%)** 다. 대조군 = 링크 있는 청크 400표본 중 **239개(59.8%)** 가 포함(검사기 작동 증명).
**즉 링커가 놓친 것이 아니라 붙일 것이 없다.** 우리 entity 이름은 **길이 중앙값 41자의 서술문**(20자 이하 5.6%)인
«세션 지식 레코드»라, 문서 본문 산문에 그대로 나타나지 않는다. **entity 어휘와 문서 어휘가 서로 다른 어휘다** —
W0 이 edge 에서 발견한 «근거가 다르다»가 **노드 층에서도 성립한다.**

→ **따라서 `autoLinkEntities` 의 매칭 규칙을 조이거나 푸는 것으로는 30.6% 가 줄지 않는다.** 남는 길은 둘이고
둘 다 이번 회차의 결정 대상이다: **(a) 문서 텍스트에서 entity 를 뽑아 어휘를 맞춘다**(= W3-d, 신설 경로)
**(b) 어휘가 아니라 임베딩으로 잇는다**(**신설 경로**). 🔴 **초안의 «현행 nonliteral 경로의 확장 · 링크 있는 청크의 약 40%가 이미 이 경로» 는 틀렸다** — 2026-08-22 코드 확인(`index.ts:2743` `autoLinkEntities`): 링크 생성 경로는 셋이고 **전부 문자열 매칭**이며 임베딩은 한 줄도 안 쓴다. 전수 실측 = 링크 **65,935** 중 이름이 청크에 있음 **1,434(2.2%)** · observations 에서 뽑은 파일명 alias **60,427(91.6%)** · 나머지(범위 교차 등) **3,563(5.4%)** · **임베딩 0**. 즉 (b) 는 확장이 아니라 **없던 것을 만드는 일**이고, 그만큼 기대값도 비용도 다시 세야 한다(임베딩은 이미 전량 존재 — 청크 2,874/2,874 · entity 600/600 — 이라 추가 LLM 호출 0).

- **W1-a 링크 커버리지** — 목표는 «링커 튜닝»이 아니라 **어휘 정합**이다. 위 (a)/(b) 를 각각 재고 고른다.
  ⚠ **커버리지를 올리면 정밀도가 내려간다** — 그 트레이드오프를 한 표에 같이 적지 않으면 개선으로 오독된다.
- **W1-b 허브 하향가중** `[조사 #5]` — SPRIG 의 degree 하향가중 `p` · 질의 entity `df(e)^-q`.
  ⚠ **`p=0.5` · `q=1.0` 은 설정값이 아니라 «등록된 탐색 범위»다** — 3 corpus 스윕으로 정하고 dev 에서 고른 뒤 동결한다.
  논문이 자백한 비용(gold 언급의 1~2% 를 함께 자른다)도 같이 들여온다.
  🔴 **advisor 지적**: W1-b 가 자르는 허브가 **어떤 질의에서는 유일한 경로**다 — `hub-M-24` 의 현행 최단 이분 경로가
  `AI Project Lifecycle Framework` 를 지난다. 허브 억제와 W3 의 직접 관계 신설은 **함께 가야** 하고, 따로 하면 경로만 잃는다.
- **W1-c 연결성** — 🔴 **초안의 «K-NN 무조건 강제»는 근거가 반증됐다.** `[advisor 실측]` 고립 노드를 뺀 이분 그래프의
  연결 성분은 **hub 1 · uap 1 · hal 3** 이다 = **파편화돼 있지 않다.** 우리 문제는 파편화가 아니라 **고립(차수 0)** 이고,
  그건 커버리지 문제다. K-NN 은 도입하더라도 **별도 엣지 종류로 격리**하고 **edge validity 계산에서 제외**한다
  (안 그러면 합성 경로가 게이트를 스스로 만족시킨다 — 동결 suite 가 `type:any`·`direction:any` 라 특히 위험).
- **W1-d 링크 정밀도 기준선** — Stage 1 의 **링크 가중 0.113 / 0.273 / 0.347** 을 쓴다.
  증거 블록의 0.237/0.465/0.475 는 **단위 혼합이라 known-invalid**(advisor 보호 항목).

### W2. 회수 경로 — 이분 그래프 위 PPR 을 «후보 생성»으로 (**실험이지 확정 위상이 아니다**)

`[조사 #1 · #2 · #4b — 채택 1순위]` 단, 🔴 **advisor 지적 수용**: 가산 재랭킹이 3/3 에서 해로웠다는 사실은
*"재랭킹이 나쁘다"* 를 증명하지 그 자리를 **PPR 후보 생성이 채운다**를 증명하지 않는다. Stage 1 은
upstream-first 로 단락돼 **후보 생성 갈래를 아예 평가하지 않았다**(DECISION §1). 따라서 W2 는 **가설**이다.

- **W2-a PPR 후보 생성 (버전 붙은 baseline 실험)** — `chunk_entities` 위에서 Personalized PageRank 로 **후보를 만든다.**
  ⚠ **이것을 제품 위상으로 확정하지 않는다.** W3 이후 **엣지 계열별 ablation**(mention / 추출 관계 / 공기 / 의미)을
  돌려 **우리 결과로** 위상을 정한다.
- **W2-b 시드 정의 (미정 — 먼저 정해야 할 것)** — 🔴 초안이 *"시드 = 벡터/FTS(RRF) 결과"* 라고만 적어 **시드 모델이 미정**이었다.
  세 형태가 서로 다른 결과를 낸다: ① 청크를 텔레포트 시드로 (링크 0 청크도 **직접 반환은 된다**)
  ② 시드 청크를 인접 entity 로 바꾸고 버린다 (링크 0 청크가 사라진다) ③ 질의에서 뽑은 entity 를 시드로.
  **텔레포트 정의역 · 시드 통과(passthrough) · dangling 노드 처리 · 융합 규칙**을 코드 전에 못 박는다.
- **W2-c 어휘 폴백** `[조사 #15]` — ⚠ **초안의 «필수»는 남의 수치로 선언한 것이었다.** 남의 데이터에서
  entity 0 질의가 6.7~7.5% 이고 BM25 폴백이 0.464→0.500 회복했다는 것이지, **우리 비율은 안 쟀다.**
  → **우리 zero-seed 율과 폴백 Δ 를 corpus 별로 먼저 재고** 필수 여부를 판정한다.
- **W2-d 파라미터** `[조사]` — 우리 2,844 청크는 2Wiki 6,119 · HotpotQA 9,811 과 **같은 급**이다.
  시드 `k` 는 **등록된 탐색 범위(3~10)** 로 두고 밀도·편중이 다르므로 corpus 크기만으로 정하지 않는다.

### W3. 관계(edge) 층 — 여기가 본체이고, 아직 «규격»이 아니다

🔴 **advisor blocking 2**: 이 절은 자신을 «관계 층»이라 부르면서 **텍스트에서 `(source, predicate, target,
direction, confidence, evidence)` 를 어떻게 얻는지를 정의하지 않는다.** 그것이 W0 이 지목한 부재 그 자체다.
구체 실패 = `hub-M-24` (`wiki/deck-authoring-traps.md → 2026-07-18-portable-bootstrap-design.md`) — required 인데
현재 부재이고 **두 끝점이 한 청크도 공유하지 않는다.** 문장 공기로 못 만들고, 의미 유사도는 그 «주장된 관계»가 아니며,
`extractTermsFromText` 는 술어를 주지 않는다.

착공 전 못 박을 것(= 이 절이 규격이 되려면 필요한 항목):
**추출 단위 · 청크 넘는 근거 창(window) · entity 해소 · 술어 어휘 · 방향 규칙 · confidence 캘리브레이션 ·
근거 스팬(evidence span) · 기각 경로 · 관계 단위 정밀도/재현율 감사.**
⚠ **suite 의 정답을 추출 입력으로 쓰지 않는다**(그러면 게이트가 자기 자신을 채점한다).

- **W3-a 방향 · type · confidence 규약** `[조사 #12 — 베낄 답이 없음]` — 서베이가 이 축을 **안 다룬다고 명시**했다.
  우리가 정의한다. Acceptance 2 그 자체. ⚠ 단위 테스트만으로 만족될 수 있으므로 **동결된 typed/directed 케이스 +
  독립 관계 정밀도 감사**를 함께 요구한다(advisor 10).
- **W3-b 문장 범위 공기 엣지** `[조사 #4 — 개작]` — **문장 안에서 공기**할 때만. 청크 범위로 넓히면
  링크 정밀도(0.113~0.347) 그대로 무관 링크를 관계로 승격시킨다. **별도 엣지 종류로 격리**(advisor 보호 항목).
  ⚠ 이것은 **보조 신호이지 관계 추출이 아니다** — 위 72.6% 상한이 그 한계다.
- **W3-c 의미 하이퍼엣지** `[조사 #14 — 채택]` — entity 임베딩 593개가 이미 있다(coverage 100%).
  ⚠ **EHRAG 의 `D=100` 을 그대로 가져오지 않는다** — 원문 미열람이고 임베딩 공간·거리 단위가 우리와 같다는 보장이 없다.
  **우리 임베딩 거리 단위로 튜닝**한다.
- **W3-d 경량 추출기** `[조사 #3 — 개작]` — 원문 정규식은 **대문자 영어 전용**이라 한국어에 못 쓴다.
  `extractTermsFromText` 를 분모로 재정의한다. **W1 의 어휘 정합 (a) 경로가 여기로 들어온다.**

### W4. 계약과 계측

- **W4-a 호출 계약 — 직교 필드로 가른다** 🔴 **advisor blocking 4**: 초안은 `mode` 하나에
  `candidate-generation | re-rank` 와 `known-item | explore` 라는 **서로 다른 두 축**을 얹었고,
  Acceptance 4 는 회귀 쿼리를 `useGraph:true`(= legacy re-ranker)로 돌린다 → **W2 를 한 번도 안 건드리고
  합격/불합격이 날 수 있다.** 규격: **`intent: known-item | explore`** 와
  **`graphRole: off | candidate-generation | legacy-rerank`** 로 나누고, `useGraph:true` 는
  `legacy-rerank` 의 **deprecated alias** 로 남긴다. Acceptance 는 **정확히 어느 호출인지**를 지명해야 하고,
  기본값·containment 불변은 **별도 회귀 테스트**로 증명한다.
- **W4-b 단계별 계측** `[조사 #11 — 채택]` — 구축 / 검증 / 사용을 따로 잰다(advisor 보호 항목).
  *우리가 «추출 단계 자체가 없음»을 Stage 1 끝에서야 본 것이 이 구조의 부재 때문이다.*
- **W4-c 참조 그래프 합성** `[조사 #10 — 채택, 평가축]` — `expected_paths` 가 수작업이라 holdout 확장을 막고 있다.
  ⚠ 그 방법의 자백도 같이: **부정 · 구조 중심이라 의미 정합성에 둔하다.**

### W5. 그래프 신원 · 세대 · 롤백 (초안에 통째로 빠져 있었다)

🔴 **advisor 9**: `relationships` 는 **수작업 세션 엣지와 앞으로 생길 파생 엣지를 한 테이블에 섞는다.**
소유(generation·출처 문서)가 없으면 매일 바뀌는 corpus 에서 *"무엇을 지우고 무엇을 다시 만드나"* 를 답할 수 없고,
재빌드가 중간에 죽으면 **절반은 옛 그래프, 절반은 새 그래프**가 된다. DB 전체 스냅샷 해시는 **추출기 코드·프롬프트·
모델·파라미터를 식별하지 못한다** — 실제로 Phase 0 이 인용한 `2,827/589/65,062` 가 지금 `2,844/593/65,632` 다.

- **`graph_build_id` 매니페스트** = corpus 스냅샷 해시 + 빌더 커밋 + 설정 + 모델/프롬프트 버전 + 청킹 서명 +
  엣지/링크 정규 해시 + 카운트.
- 엣지마다 **계열(family) · 근거 문서·스팬 · 추출기 버전 · generation id**.
- **shadow generation 으로 만들고 → 검증 → 원자적 활성화 → 직전 세대 보존(롤백)**. 문서 갱신 시 삭제·재빌드 의미론을 정의.

### 요구되는 Acceptance 개정 (이 절이 지목만 하고, 개정은 범위 판정 뒤에)

🔴 **advisor 8**: 현행 Acceptance 는 **W1·W2 가 하겠다는 것을 재지 않는다** — 이름 정밀도는 이미 0.99~1.00 으로
통과 상태이고, 링크 커버리지·가중 정밀도·허브 집중도·새 후보 채널의 **양(+)의 효능 기준**이 없다.
그래서 **아무 일도 안 하는 PPR 구현이 «K 회귀 없음»만으로 통과**할 수 있다.
→ corpus 별 **동결 목표치**(링크 커버리지 · 가중 정밀도 + CI · 허브 점유율 · 후보 Δrecall@30 또는 사전 등록된
graph-required 종점)와 **변경 전 그래프 대비 ablation** 을 넣는다. 비열등만으로는 부족하다.

### 착공 전 선행 수리 (2026-08-22 완료 · 커밋 `a4e9ab6`)

재평가가 딛고 서는 것이라 구축보다 먼저 닫았다: ① §9 재평가 명령이 `extract-observed.mjs` 를 안 불러
**새 그래프가 아니라 Stage 1 관측을 다시 잴** 뻔했다(런북 줄 + `run-upstream` 의 스냅샷 신원 게이트 exit 16)
② `snapshot.mjs` 가 라이브 DB 를 read-write 로 열었다(`-shm` 있으면 `-readonly`, 없으면 기록된 폴백)
③ 링크 감사 **판정자 눈가림 파손**(`provenance` 를 판정 파일에서 분리해 key 파일로).

### 큰 축 (원안 대비 정정)

- **구축(build)** 축 = 추출 · 정규화 · 관계 타입 · confidence → **W3. 이것이 본체다.**
- **링크 품질(link)** 축 = 청크↔entity 링크 → W1. D8 이 예시한 `entity-link-quality` 가 여기.
- **회수(retrieval)** 축 → W2. 🔴 **초안은 W2 를 «구축과 독립»이라 했으나 정정한다** — 발생 그래프 실험으로서만
  독립이고, 이 change 를 열게 만든 **graph-required 질의에 대해서는 독립이 아니다**(W3 이 만든 관계가
  W2 의 위상에 들어오지 않는다). 랭킹 공식의 재판정은 재평가(§Acceptance 4)로 넘긴다.

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
