# graph-role-evaluation — hybridSearch 에서 graph 의 역할을 *측정으로* 정하는 evaluation/decision change (v2 · advisor r4 반영)

> 종류: **evaluation/decision change** (구현 change 가 아니다). 산출물 = **동결된 판정 suite · 단계별 계측 · 대조군 · 검정력 있는 결정표 → `DECISION.md` + 선택된 후속 SDD change 의 실제 개설**.
> 설계 spec(SSOT) = 프레임워크 repo `docs/superpowers/specs/2026-08-17-graph-role-redesign-design.md` v2 §2 (변경 B).
> advisor: r3(2026-08-17 세션36) = *"evaluation/decision change 를 먼저 열어 결과가 구현 change 의 형태를 정하게 하라"* · **r4(2026-08-17 세션37, codex gpt-5.6-sol high) = REVISE** — v1 은 *"작은 pilot 결과를 반드시 네 갈래 중 하나로 밀어 넣는 장치"* 였다. blocking 9 = ① source-grounded 주석과 `observed_path` 분리 · 구조화 edge ② judge 품질 게이트·weighted κ·필수 human audit·pool 포화 ③ 모든 run 이 pool 에 기여하도록 DAG 수정 ④ latency SLO·정식 K 비열등성·dev 기반 검정력/N 동결 ⑤ `inconclusive` 갈래 · remove 는 futility 증거 때만 ⑥ M 용 bounded 2-hop·채널 분리·전파/중복/tie/문서 예산 ⑦ shuffle replicate·노드별 degree 보존 ⑧ seam 의 degraded/fallback 모순 해소 + differential parity ⑨ DoD 에 후속 change 실제 개설 + tracker receipt. 원문 = 프레임워크 repo `raw/advisor/2026-08-17-ranking-root-fix/r4-codex-last.md`. **v2 는 이 아홉을 전부 반영한다**(항목별 위치는 아래 D 번호에 `[r4-Bn]` 로 표시).
> 상태 전제: A(`useGraph` 기본 opt-in, v5.3.0)는 **containment** 다. 이 change 가 열려 있는 동안 ②는 종료되지 않으며, **`evaluation complete` 와 `root repair complete` 는 다른 상태**다.

## Why

- 가산 `graph_boost`(0.5^i 감쇠 · cap 0.4)가 known-item 회수를 해친다는 것은 3/3 corpus 에서 확정됐다(self-retrieval usable 120/117/120, `SUMMARIES=off`, 나빠짐/좋아짐 46/3 · 49/2 · 52/0, top-10 완전소실 106, sign test p<7e-11 — 세션35 §234).
- **"graph 를 어떻게 써야 하는가"는 아직 측정된 적이 없다.** 지금까지의 표본은 전부 known-item(exact-chunk oracle)이고, graph 가 값을 낼 수 있는 과제(associative exploration · multi-hop/bridge)에는 **판정 suite 자체가 없다.** 이 상태에서 후보 생성이든 gate 든 구현하면 근거 없는 설계가 된다(r2·r3).
- 현재 구현의 graph 는 후보를 만들지 않고 vector/FTS 풀만 재정렬한다(`index.ts:3535·3568` 후보 → `:3654~3730` seed/연결 확장 → `:3767~` boost). 관계 확장은 방향·type·confidence 를 쓰지 않는 사실상 undirected 1-hop(`:3689~3703`). `chunk_entities` 는 이름 literal + observation 파일명 alias 로 전 entity 를 순회하며 만들어진다(`:2740~2800`) — 링크 밀도 hub 중앙값 18 · p90 84 · max 162. **이 사슬(query→seed→edge→chunk link→candidate)의 어느 단계가 실패하는지 모른다.**

## What (이 change 가 만드는 것)

1. **판정 suite** — 과제 3 부류(known-item `K` · associative `A` · multi-hop/bridge `M`) × 3 corpus(hub·uap·hal) · qrel 단위 고정(K = chunk / A·M = document graded 0·1·2) · **source-grounded 주석**(`expected_entities` · 구조화 `expected_paths`) 과 동결 뒤 KG 에서 뽑는 `observed_paths` 를 **분리** · family 단위 dev/holdout · 결과 확인 전 동결. 작성 프로토콜 포함.
2. **단계별 계측기** — 한 질의에 대해 seed(질의 벡터 매칭) → 1-hop/2-hop 연결(방향·type·confidence·edge_id) → chunk link → 채널별 후보(vector · fts · graph-seed · graph-n1 · graph-n2 · graph-reach · graph-vec · rrf2 · rrf3)를 **같은 후보 예산(chunk-K 와 unique-document-K 둘 다)** 에서 뽑고 최종 랭킹(제품 `useGraph` off/on · 고정 pool 재랭킹)까지 per-query JSONL. 제품 코드에는 **행동 무변의 진단 seam 하나**(`explainGraphContext`, differential parity 로 증명)만.
3. **upstream 지표** — seed recall(허용 seed 집합 기준) · edge validity(구조화 expected edge 의 존재/방향/type) · encoded-path coverage · projection recall · link precision(정확한 mention 여부 · 층화 · provenance name/nonliteral · chunk-cluster CI) · **hub degree 조건부 오랭킹률**.
4. **대조군** — degree-preserving shuffle **replicate 20**(노드별 (in,out) 정확 보존 · type-preserving 변형 포함) + same-|E| random. 실제 edge 는 **shuffle null 분포**와 비교한다.
5. **검정력 있는 결정표 → `DECISION.md`** — MCID·허용 손실 δ·latency SLO 를 먼저 박고, dev pilot 의 분산으로 holdout N 을 산정·동결한 뒤 holdout 에서 **다섯 갈래**(upstream-first / candidate-generation+RRF / gated-rerank / remove-from-ranking / **inconclusive→expand-evaluation**)를 gatekeeping 순서로 판정. **remove 는 futility(equivalence) 증거가 있을 때만.** 그리고 **선택된 후속 SDD change 를 같은 commit 에 실제로 연다.**

## Not in scope (같은 표에)

| 항목 | 어디로 | 왜 |
|---|---|---|
| scorer/랭킹 코드 변경 | 후속 구현 change(이 change 가 **연다**) | 결정표가 형태를 정한 뒤 |
| 요약 경로(`relevanceScore` 쿼리 무관 가산 · 142초) | 별도 incident C (spec §2.5) | r3·r4: A/B 에 섞지 않는다. 이 change 의 모든 측정은 `RAG_MEMORY_SEARCH_SUMMARIES=off` 강제 |
| 링크 품질 수리 | 별도 change `entity-link-quality`(upstream-first 갈래면 이 change 가 연다) | 여기서는 **측정만** |
| KG 청크(entity/relationship chunk) | 관찰 항목(`chunk_type` 분포 기록) | 3/3 corpus 0개 = dormant. 판정은 결정표 밖(r4 non-blocking 4) |
| `auto` intent gate | 데이터가 쌓인 뒤 | 초기 계약은 명시적 `mode` |

## Scope Challenge (Phase 2c)

| # | 체크 | 판정 |
|---|---|---|
| 1 | 코드 재사용 | 프로브 v2 의 부팅 순서(gate.start → reconciliation → ready · 폴백 stderr 카운트 · rowid 표본)와 점수 성분 역산을 `eval/graph-role/lib/` 로 이식. seed/연결 SQL 은 복사하지 않고 제품 seam 을 부른다(r4 Q5: SQL 복사보다 seam 이 우세 — 계측기가 제품과 다른 것을 재는 사고를 구조적으로 막는다). 2-hop 은 harness 측 SQL(제품에 없는 경로 = 가설이지 제품이 아니다 · 라벨 분리) |
| 2 | 최소 범위 | 제품 코드 변경 = seam 1건(행동 무변 · differential parity 로 증명). 채널·대조군·판정·통계는 전부 harness. 릴리스 없음 |
| 3 | 복잡도 냄새 | 새 파일 ~16(harness lib 6 · runner 6 · suite/protocol/judging · README · 테스트 2) — 8개+ 이지만 **한 디렉터리 `eval/graph-role/`** 이고 제품 모듈은 1곳. 링크 품질 수리·후속 구현은 별도 change |
| 4 | 프레임워크 내장 | 없음. 통계는 stdlib(정확 이항 · 부트스트랩 · permutation) — 의존성 추가 없음 |
| 5 | 테스트 목표 | seam = differential parity matrix(추출 전 golden vs 후) 100% · harness pure lib(freeze · controls · metrics · RRF · 예산 · provenance · κ · power) 100% · 러너 = 스모크 |

## 설계 결정 v2 (번호는 spec §2.3 순서와 대응 · `[r4-Bn]` = 반영한 blocking)

**D1 과제 분류 · qrel 단위** — `K` known-item: 단위 chunk, self-retrieval oracle(프로브 v2 규칙: len≥200 · 본문 60~240자 발췌 = 질의), **한 document 에서 최대 1 질의**(document leakage 차단 `[r4-Q6]`) · dev/holdout 은 document 단위로 분리. `A` associative: 단위 **document**, graded 0/1/2. `M` multi-hop/bridge: 단위 document. **"graph-required" 의 정의 = 질문의 형태**(탐색·다리)이지 "graph 가 이기는 질의"가 아니다.

**D2 source-grounded 주석 · gold 의 독립성 `[r4-B1]`** — A·M 질의는 **문서 원문에서** 작성한다. 작성자는 `documents.content` 와 `entities.name` 목록(정규 이름 사용 목적)만 본다 — `relationships`·`chunk_entities` 는 **보지 않는다.** seed 후보 선정도 graph degree 가 아니라 **텍스트 기준**(정규 이름이 literal 로 나오는 문서 수 ≥ 3, 층화 무작위). 각 질의 행:
`{id, class, split, family, text, expected_entities:[정규 이름], expected_paths:[[{from,to,type|"any",direction:"out"|"in"|"any",required:bool}]], seed_candidates:[허용 seed 집합], source_docs:[작성에 읽은 doc id], author_mode:"source-grounded"|"kg-informed", notes}`.
M 은 **두 문서를 잇는 공통 entity** 로 만든다(doc1 이 A·B 를, doc2 가 B·C 를 본문에 언급 → 다리 질문 · `expected_paths=[[A→B],[B→C]]` type/direction 은 원문이 말하는 대로, 모르면 `any`). `family` = seed 또는 target document 키(같은 family 는 같은 split · bootstrap cluster). **동결 뒤** 스크립트가 KG 에서 `observed_paths`(존재 edge · type · direction · edge_id)를 뽑아 **별도 파일**에 둔다 — 그래서 edge validity 는 자명하지 않다(원문이 말한 관계가 KG 에 있는가). `kg-informed` 로 작성한 질의(있다면)는 edge validity gold 가 아니라 **encoded-path coverage** 로 강등해 따로 집계한다.
gold = **모든 채널 × 조건(real · shuffled rep0 · random) + 최종 랭킹**의 pooling(TREC 방식 · 깊이 100 · 증분: 상위 30 먼저, 31~100 은 포화 검사) → chunk 단위 판정(질의 + 문서 제목 + 후보 청크 + 인접 청크) → document grade = max(chunk grade) → **unpooled 무작위 (query, doc) 표본 100/corpus** 로 missed-relevant rate 측정 `[r4-B3]`.

**D3 동결·split·검정력 `[r4-B4]`** — 질의·부류·family·주석은 어떤 검색도 돌리기 전에 `suite/queries.<corpus>.jsonl` 로 쓰고 sha256 을 `suite/FREEZE.md` 에 기록 + commit. 러너는 해시 불일치 시 거부(`--unfrozen` 명시 시만 실행 + 산출에 `unfrozen:true`). **2단계**: (Stage 1 · dev pilot) K 60 · A 30 · M 30 / corpus → 짝지은 Δ의 SD·불일치율(discordance) 실측 → `suite/POWER.md` 에 **holdout N 산정(검정력 ≥ 0.8 · α 0.05 · MCID 기준 · corpus 별)** 과 판정 예산(최대 판정 건수) 을 동결 → (Stage 2 · holdout) 그 N 으로 작성·동결·실행. 임계값·MCID·δ·SLO 는 `thresholds.json` 에 있고 **holdout 을 열기 전에 동결**된다. N 이 예산을 넘으면 그 endpoint 의 결론은 `inconclusive` 로 사전 선언한다.

**D4 단계별 계측 · 채널 `[r4-B6, B8]`** — 제품 seam `explainGraphContext(query)` 반환 = `{ status:'vector'|'entity-text-fallback'|'chunk-vector-disabled'|'error', query_variants, seeds:[{entity_id,name,similarity}], connected:[{entity_id,name,via_seed_id,via_seed_name,edge_id,relation_type,direction:'out'|'in',confidence:number|null}] }` — parallel edge·복수 via_seed 손실 없이 · 결정적 정렬(seeds = similarity desc, entity_id asc / connected = via_seed 순 → edge_id asc). **hybridSearch 의 분기 보존**: chunk-vector degraded → graph 블록 생략(seam 은 `chunk-vector-disabled`, 두 집합 빈 값) · entity-vector 예외 → 텍스트 폴백(seam 은 `entity-text-fallback`, connected 는 폴백 경로 결과) · 정상 → `vector`. hybridSearch 는 seam 결과에서 지금과 **동일한** 이름 집합을 만든다. **행동 무변 증명 = differential parity matrix**: 추출 **전** 커밋에서 고정 stub 임베딩 픽스처 DB 로 `hybridSearch` 결과(순서 + vs/gb/fts/fin 성분)를 golden JSON 으로 기록·commit → 추출 후 같은 픽스처에서 byte 동일 비교. 케이스 = 임계 경계(0.4 바로 위/아래) · multi-seed · 양방향/parallel edge · confidence null · 후보 0 · entity-vector 예외 강제(폴백) · chunk-vector degraded · 관계 0 · cross-lingual 변형. 임베딩은 **stub 으로 고정**(모델 의존 테스트 금지).
채널(예산 = chunk-K **와** unique-document-K, K ∈ {10, 30, 100}): `vector` · `fts` · `graph-seed`(seeds 에 링크된 청크) · `graph-n1`(1-hop 이웃에 링크된 청크 · 제품 경로와 같은 이웃 정의) · `graph-n2`(bounded 2-hop: hop 당 이웃 ≤ 50 · harness SQL · 라벨 분리) · `graph-reach`(2-hop 도달 집합 전체 = reachable-set recall, 예산 없음) · `graph-vec`(graph-n1 집합을 질의-청크 벡터 유사도로 정렬 = **graph-filtered vector upper-bound**, semantics 성과로 읽지 않는다) · `rrf2 = RRF(vector,fts)@K` · `rrf3 = RRF(vector,fts,graph-n1)@K` · `rrf3-n2`. **점수 전파** = 이웃 점수 = max_seed(seed 유사도 × 0.5^hop) · 청크 점수 = Σ_{매칭 entity dedup}(entity 점수) · tie-break = (점수 desc, chunk_id asc). **비의미 baseline**(semantics 축) = 링크 수 prior · 매칭 링크 수 · seed degree · 전파 점수(shuffled edge 위). 최종 랭킹 = 제품 `hybridSearch(q,10,false)` · `(q,10,true)`(SUMMARIES=off) · **고정 pool 재랭킹**(rrf2@30 후보에 제품 boost 공식을 feature 로 얹은 순서 vs 없는 순서 = pure rerank 증거) · warm/cold p50·p95 end-to-end ms.

**D5 upstream 지표** — seed recall = `seed_candidates` ∩ seeds ≠ ∅ · edge validity = 각 expected edge 가 KG 에 존재하는가(방향·type 일치 플래그 별도) · encoded-path coverage(kg-informed 만) · projection recall = gold document 중 connected 의 chunk link 로 닿는 비율 · **hub degree 조건부 오랭킹률** = 정답 문서를 밀어낸 청크의 링크 수 분위별 비율 · link precision = 층화 표본(청크 링크 수 ≤5 / 6~30 / >30, 층당 20)의 (chunk, entity) 쌍(청크당 ≤15 무작위)을 판정자가 **"이 entity 가 이 청크에 실제로 언급되는가(정확한 mention)"** 로 판정(주제성 X) · provenance = `name`(literal 매칭) | `nonliteral`(literal 부재 — alias 라 단정하지 않는다) `[r4-NB2]` · **chunk-cluster CI + 층별 prevalence weighting**.

**D6 대조군 `[r4-B7]`** — DB 사본에서 `relationships` 를 (a) **degree-preserving double-edge swap replicate 20**(seed 0~19 · 노드 ID 별 (in,out) degree 정확 보존 검증 · self-loop/duplicate 거부 · mixing = 성공 swap |E|×20 · relation_type/confidence 는 간선에 붙어 이동) (b) **type-preserving swap**(같은 relation_type 안에서만 swap · 방향/type 축 평가용) replicate 5 (c) same-|E| Erdős–Rényi 1개. graph 의존 지표는 real 과 **shuffle null 분포**(replicate 별 값)로 비교 — `p_null = #{rep: metric_rep ≥ metric_real} / R`.

**D7 통계 `[r4-Q6]`** — 질의 단위 짝지음(worse/same/better + sign test 정확 이항은 **방향** 검정에만) · 효과 크기 Δ의 bootstrap 95% CI(**고정 RNG seed · 10,000 회** · 재표본 단위 = K 는 document, A·M 은 family · 매 draw 에서 한 질의의 모든 채널/조건 결과를 함께 뽑아 짝 보존) · **비열등성 = one-sided 95% CI 하한 > −δ** · corpus 별 + **corpus-stratified macro**(naive pooling 금지) · **primary endpoint 5개 고정**(K safety · latency SLO · candidate · semantics · rerank) + gatekeeping 순서, 효능 3개엔 Holm · 나머지는 exploratory 표기 · link precision 은 chunk-cluster CI.

**D8 결정표 v2 `[r4-B5, B4]`** — `thresholds.json`(동결) 에 박는 값과 근거: **MCID_candidate = Δrecall@30(document, rrf3 − rrf2) ≥ +0.05** · **MCID_rerank = ΔnDCG@10(A·M) ≥ +0.05**(v1 의 +0.02 는 r4 산정으로 ~784 질의 필요 = 예산 밖 → 제품상 의미 있는 값으로 올린다) · **MCID_semantics = real − shuffle-null 평균 ≥ +0.03 이면서 p_null ≤ 0.05** · **K 허용 손실 δ = 0.02(hit@5) — one-sided CI 하한 > −δ** · **latency SLO = 채널·모드별 warm p95 ≤ 1,000 ms(SUMMARIES=off · hub 사본)** 및 cold p95 기록 · upstream 게이트 = seed recall ≥ 0.70 · link precision(name) ≥ 0.60 · edge validity ≥ 0.80(**pilot 값이 아니라 결정표 진입 조건** — 미달이면 갈래 ①). ⚠ 이 수치들은 여전히 사전 선언이지 검증된 값이 아니다 — **바꾸려면 holdout 을 열기 전에만**, 변경 이력은 FREEZE 에.
gatekeeping 순서(holdout · 첫 참인 갈래):
| 갈래 | 조건 | 후속 change |
|---|---|---|
| ① `upstream-first` | upstream 게이트 미달(corpus 하나라도) | `entity-link-quality`(또는 seed 매칭 수리) 를 **이 change 가 연다** |
| ② `candidate-generation+RRF` | K safety 통과 **and** latency SLO 통과 **and** candidate: 조정 CI 하한 > 0 **and** point ≥ MCID_candidate(corpus 별 ≥ 2/3) **and** semantics 통과 | graph→chunk 후보 채널 + RRF, `mode:explore` |
| ③ `gated-rerank` | K safety·SLO 통과 **and** candidate 미달 **and** rerank(고정 pool): 조정 CI 하한 > 0 **and** point ≥ MCID_rerank **and** semantics 통과 | 제한적 재랭킹(gate = 명시적 `mode`) |
| ④ `remove-from-ranking` | candidate·rerank·semantics **셋 다** CI 상한 < MCID(futility/equivalence, 검정력 확보 상태) | 랭킹에서 graph 제거 · traversal 도구만 |
| ⑤ `inconclusive → expand-evaluation` | 위 어느 것도 아님(검정력 부족 · 방향 불일치 · SLO 만 실패 등) | 평가 확장 change(N 확대 · 표본 설계 변경) 를 **연다** — *미입증 ≠ 무효* |
+ **semantics 축**은 ②③ 의 필요조건이자 별도 기록(real ≈ shuffle null 이고 비의미 baseline 이 이득을 재현하면 "graph semantics 미입증"). + `mode: known-item | explore` 는 ②③ 어느 쪽이든 후속 change 의 제품 계약. + **`evaluation complete` ≠ `root repair complete`** — 후속 구현 change 가 출하되고 post-change holdout 을 통과하기 전에는 프레임워크 `current-focus` ② 를 닫지 않으며 v5.3.0 containment 는 유지된다 `[r4-B9]`.

**D9 corpus·스냅샷** — hub `.memory/rag-memory.db`(80.4MB) · uap `--0-CollectLOG/Ultimate_AI_Personal_Assistant/.memory/rag-memory.db`(29.7MB) · hal `~/Development/Halal_Assistant_incubator_active/.memory/rag-memory.db`(21.7MB). sqlite **online backup** 사본만(원본 mtime 무변 · 남의 DB 는 SELECT/backup 까지). `eval/graph-role/dbs/`(gitignore) + `snapshot.json`(source · bytes · sha256 · taken_at · 엔진 commit).

**D10 판정 프로토콜 `[r4-B2]`** — `suite/JUDGING.md` 에 **동결**: 판정자 A = Claude(fresh subagent · 모델 id 기록) · 판정자 B = codex(모델 id 기록) · 조정자 C = 셋째 컨텍스트 · temperature 0(가능한 곳) · 입력 순서 = 질의별 고정 seed 셔플 · 채널·조건 blind · 루브릭 0/1/2 + 예시. **게이트 = quadratic weighted κ ≥ 0.67**(corpus·부류별) — 미달이면 루브릭 개정 후 **재판정**(결과 폐기). **모든 불일치는 조정**(C, 사람 검수 가능하면 사람). **사람 audit floor = 50쌍/corpus**(부류·등급 층화, 일치 항목 포함) — 사람 audit 이 있고 불일치율 ≤ 20% 면 qrels 는 `decision-grade`; audit 이 없거나 실패하면 `LLM-judged provisional` 로 표시되고 **④ remove 와 릴리스 결정은 금지**(⑤ 또는 ②③ 의 provisional 만 가능). 판정 sensitivity(라벨 ±1 등급 흔들기) 는 exploratory 로 보고.

**D11 제품 코드 접촉** — seam 1건 + differential parity 테스트 + 계약 테스트(`verify:engine` 배선). scorer 0줄 · 도구 계약 무변 · 릴리스 없음(harness 는 worktree `dist/`). 강화가 불가능해지면 그때만 SQL 복사 + 엔진 commit 고정 + parity(r4 Q5 대안).

## Risks

- **판정자 편향·비용** — LLM 판정 2 + 조정 + κ 게이트 + 사람 audit floor 로 완화. 판정 건수가 예산(corpus 당 8,000 판정 · `thresholds.json`)을 넘으면 그 endpoint 는 사전 선언대로 `inconclusive`. **사람 audit 50쌍/corpus 는 사용자 시간(≈ 30~45분/3 corpus)** — 하지 않으면 결론은 provisional 로 제한된다(이 문장이 프로젝트 최희소 자원과의 거래 조건이다).
- **표본 크기** — Stage 1 pilot 은 결론용이 아니다(r4). N 은 pilot 분산으로 산정·동결한다. 산정 N 이 예산 밖이면 ⑤.
- **hub 는 살아 있는 DB** — 사본만 · 원본 경로 거부(exit 4).
- **CPU 경합** — 계측은 한 번에 하나(세션36 §247①). SUMMARIES off 라 표본당 ~1초 · 판정이 긴 축.
- **seam 추출이 행동을 바꿀 위험** — golden(추출 전) vs 후 differential matrix + 기존 `search-graph-default.test.mjs`.

## Contract (Phase 4 요약 — 상세 = tasks.md `## Definition of Done`)

이 change 는 다음이 모두 있을 때 끝난다: (1) 동결 suite(Stage 1 pilot + Stage 2 holdout N) + FREEZE 해시 (2) qrels(A·M graded · κ ≥ 0.67 · 조정 완료 · 등급 `decision-grade`/`provisional` 명시) 2차 동결 · missed-relevant rate (3) 채널·upstream·대조군(replicate)·최종랭킹 raw JSONL 3 corpus 전부 (4) `out/report.md`(primary 5 endpoint · Holm · CI · n/usable) (5) `DECISION.md` = 결정표 조건별 실측·임계·판정 · 갈래 1개(다섯 중) · semantics 축 · **후속 SDD change 디렉터리가 같은 commit 에 실제로 개설**(proposal 에 `mode`·방향/type/confidence·latency/quality acceptance·재평가 명령) (6) 제품 seam differential parity GREEN · `npm test` EXIT 0 (7) 프레임워크 tracker receipt(`current-focus` ② 줄 + spec §2 상태 갱신 링크)를 DECISION 에 기록 — 없으면 DoD 실패 (8) 상태 = `evaluation complete`(root repair 는 후속 change 의 것).

## References

- spec v2: `RAGMemory-Claude-memory-management-and-optimised-workflow/docs/superpowers/specs/2026-08-17-graph-role-redesign-design.md`
- advisor r1~r4 원문: 같은 폴더 `raw/advisor/2026-08-17-ranking-root-fix/{r1-codex,r2-codex,r3-codex-last,r4-codex-last}.md`
- 측정 자산: `raw/advisor/2026-08-17-ranking-root-fix/repro/`(probe v2 · summary-s36.md · probe-*.jsonl)
- 제품 코드 좌표(main 5ae46c3): 후보 생성 `index.ts:3535·3568` · seed/연결 `:3654~3730` · boost `:3767~3800` · 자동 링크 `:2740~2800` · getNeighbors `:1263`
