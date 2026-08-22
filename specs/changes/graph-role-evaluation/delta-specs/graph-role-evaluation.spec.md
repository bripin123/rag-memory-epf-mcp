# Delta Spec — graph-role-evaluation (v2 · advisor r4 반영)

> Capability: hybridSearch graph 역할 판정을 위한 평가 harness + 결정 절차. 제품 동작 변경 없음(진단 seam 1건만 ADDED, differential parity 로 무변 증명).
> 용어: *gold* = qrels grade ≥ 1 · *K* = 후보 예산(chunk-K 와 unique-document-K 둘 다) · *채널* = vector | fts | graph-seed | graph-n1 | graph-n2 | graph-reach | graph-vec | rrf2 | rrf3 | rrf3-n2 · *조건* = real | shuffled-r{0..19} | typeshuf-r{0..4} | random · *primary endpoint* = K-safety · latency-SLO · candidate · semantics · rerank.

## ADDED Requirements

### Requirement: R1 판정 suite 는 결과 확인 전에 동결되고, 주석은 source-grounded 다
시스템은 corpus 별 `eval/graph-role/suite/queries.<corpus>.jsonl` 을 가져야 하며(SHALL) 각 행은 `{id, class:'K'|'A'|'M', split:'dev'|'holdout', family, text, expected_entities:string[], expected_paths:Array<Array<{from,to,type,direction:'out'|'in'|'any',required:boolean}>>, seed_candidates:string[], source_docs:string[], author_mode:'source-grounded'|'kg-informed', notes?}` 이어야 한다. K 행은 `oracle_chunk_id` 를 추가로 가지며 **한 document 당 최대 1 행**이어야 한다(MUST). 같은 `family` 는 같은 split 에만 있어야 한다(MUST). `suite/FREEZE.md` 는 각 파일의 sha256·동결 시각·commit 을 담아야 하며(SHALL), 러너는 해시 불일치 시 exit 3 으로 거부해야 한다(MUST). `--unfrozen` 명시 시에만 실행하되 모든 산출 행에 `unfrozen:true` 를 표시한다(MUST). 동결 뒤 `extract-observed.mjs` 가 KG 에서 `suite/observed.<corpus>.jsonl`(`{id, observed_paths:[{from,to,edge_id,relation_type,direction,confidence}]}`) 을 **별도 파일**로 만든다(SHALL) — queries 파일은 수정되지 않는다.

#### Scenario: 동결 뒤 질의를 고치면 러너가 멈춘다
- GIVEN `queries.hub.jsonl` 의 sha256 이 FREEZE.md 에 있고
- WHEN 그 파일의 한 행을 편집한 뒤 `node eval/graph-role/run-candidates.mjs --corpus hub --cond real` 을 실행하면
- THEN exit 3 · stderr `FROZEN_MISMATCH queries.hub.jsonl`

#### Scenario: `--unfrozen` 은 돌되 표시가 남는다
- WHEN 위 상태에서 `--unfrozen` 을 붙이면
- THEN 실행되고 `out/*.jsonl` 모든 레코드에 `"unfrozen":true`

#### Scenario: document leakage 차단
- GIVEN K 질의 60개를 만들 때
- THEN 같은 `document_id` 의 청크가 두 행이 되지 않고, dev 와 holdout 에 같은 document 가 나타나지 않는다(`freeze.mjs --validate` 가 exit 5 로 잡는다)

### Requirement: R2 제품 진단 seam — 분기 보존 · 결정적 정렬 · differential parity
`RAGKnowledgeGraphManager` 는 `explainGraphContext(query: string, queryVariants?: string[], opts?: { chunkVectorDegraded?: boolean })` 를 제공해야 하며(SHALL — 두 번째 인자는 선택이고 생략 시 `buildCrossLingualVariants(query)` 와 동일) 세 번째 인자도 선택이고 `hybridSearch` 는 자기가 이미 확정한(latched) `vectorDegraded` 를 넘겨 seam 과 랭킹 경로가 **같은 eligibility 판정**을 보게 해야 하며(MUST — 생략하면 seam 이 `coordinator.eligible` 로 그 자리에서 유도한다) 반환은 `{ status:'vector'|'entity-text-fallback'|'chunk-vector-disabled'|'error', query_variants:string[], seeds:Array<{entity_id,name,similarity}>, connected:Array<{entity_id,name,via_seed_id,via_seed_name,edge_id,relation_type,direction:'out'|'in',confidence:number|null}> }` 이다. parallel edge 와 복수 via_seed 는 행으로 **모두 보존**하고(MUST) 정렬은 seeds = (similarity desc, entity_id asc) · connected = (via_seed 순, edge_id asc) 로 결정적이어야 한다(MUST). `hybridSearch(q, limit, true)` 는 (a) chunk-vector degraded 이면 graph 블록을 건너뛰고(seam `chunk-vector-disabled`, 두 집합 빈 값) (b) entity-vector 예외면 텍스트 폴백 경로를 그대로 타며(seam `entity-text-fallback`) (c) 정상이면 seam 의 seeds·connected 이름 집합을 **그대로** `queryMatchedEntities`/`connectedEntities` 로 쓴다(MUST). 임계값(유사도 > 0.4)·top-k(변형당 10)·1-hop SQL 은 추출 전과 동일해야 한다(MUST). 행동 무변은 **differential parity**로 증명한다: 추출 전 커밋에서 stub 임베딩 픽스처 DB 로 기록한 golden(`test/fixtures/graph-context-golden.json`: 케이스별 결과 순서 + vector_similarity·graph_boost·fts_boost·relevance_score) 과 추출 후 실행 결과가 byte 동일이어야 한다(MUST). 케이스 = 임계 경계(0.39/0.41) · multi-seed · 양방향/parallel edge · confidence null · 후보 0 · entity-vector 예외 강제 · chunk-vector degraded · 관계 0 · cross-lingual 변형.

#### Scenario: seam 과 boost 경로가 같은 집합을 본다
- GIVEN stub 임베딩으로 A 유사도 0.6 · B 0.1 이 되게 고정한 픽스처(A→B `REFERENCES` confidence 0.9, c1 ∋ A, c2 ∋ B)
- WHEN `explainGraphContext(q)` 와 `hybridSearch(q, 10, true)` 를 부르면
- THEN seeds = [{A, 0.6}] · connected = [{B, via A, edge_id, 'REFERENCES', 'out', 0.9}] 이고 c2 의 `graph_boost` 는 connected 가산 0.15 를 포함한다

#### Scenario: 분기 보존
- WHEN entity-vector 검색이 예외를 던지도록 강제하면 seam.status = 'entity-text-fallback' 이고 hybridSearch 결과는 golden 의 폴백 케이스와 byte 동일
- WHEN chunk-vector 가 degraded 이면 seam.status = 'chunk-vector-disabled' · seeds/connected 빈 값 · hybridSearch 는 `search_mode:'fts-only'` 그대로

#### Scenario: 기본 호출은 seam 을 부르지 않는다
- WHEN `hybridSearch(q, 10)` 이면 결과에 `graph_boost` 없음(`test/search-graph-default.test.mjs` 유지)

### Requirement: R3 채널 후보는 같은 예산에서 나오고, graph 는 층으로 분리된다
러너는 질의마다 K ∈ {10, 30, 100} 각각에 대해 채널 `vector` · `fts` · `graph-seed` · `graph-n1` · `graph-n2`(hop 당 이웃 ≤ 50 · harness SQL · 라벨 `harness-2hop`) · `graph-vec`(graph-n1 집합을 질의-청크 벡터 유사도로 정렬 · 이름 = graph-filtered vector upper-bound) · `rrf2 = RRF(vector,fts)` · `rrf3 = RRF(vector,fts,graph-n1)` · `rrf3-n2` 의 상위 K 를 **chunk-K 와 unique-document-K 둘 다**로 기록해야 하며(SHALL), `graph-reach`(2-hop 도달 청크 전체 수·gold 포함 여부)도 기록해야 한다(SHALL). 점수 전파 = 이웃 점수 max_seed(seed 유사도 × 0.5^hop) · 청크 점수 = Σ 매칭 entity(dedup) · tie-break = (점수 desc, chunk_id asc)(MUST). 채널마다 warm/cold ms 를 기록한다(SHALL). 후보 recall@K = gold document 중 그 채널 상위 K 에 청크가 하나라도 있는 비율.

#### Scenario: 예산과 결정성
- WHEN 같은 질의를 두 번 돌리면 모든 채널의 후보 순서가 동일하고(tie-break) 각 채널 후보 수 ≤ K 이며 `rrf3` 는 세 채널 후보를 RRF(k=60) 로 합친 뒤 K 에서 자른 것이다

### Requirement: R4 upstream 지표는 최종 랭킹보다 먼저 계산 가능해야 한다
러너는 A·M 질의마다 seed recall(`seed_candidates` ∩ seeds ≠ ∅) · edge validity(각 expected edge 의 KG 존재 · direction 일치 · type 일치 플래그, `type:'any'`/`direction:'any'` 는 존재만) · encoded-path coverage(`author_mode:'kg-informed'` 만) · projection recall(gold document 중 connected 의 chunk link 로 닿는 비율) · **hub-degree 조건부 오랭킹률**(정답 문서 위에 오른 청크의 링크 수 분위별 비율)을 기록해야 한다(SHALL). link precision audit 는 corpus 당 층화 표본(청크 링크 수 ≤5 / 6~30 / >30, 층당 20)의 (chunk, entity) 쌍을 청크당 ≤15 무작위로 뽑아 provenance(`name` = literal 매칭 | `nonliteral` = literal 부재)와 판정 입력(질문 = *"이 entity 가 이 청크에 실제로 언급되는가"*)을 만들어야 하며(SHALL), 집계는 chunk-cluster CI + 층별 prevalence weighting 이어야 한다(MUST).

#### Scenario: provenance
- GIVEN 청크 텍스트에 entity 이름 literal 이 있으면 `name`, 없으면 `nonliteral` (제품 `buildEntityMatcher` 규칙: Latin 단어 경계 · CJK 부분 문자열)

### Requirement: R5 대조군은 replicate 이고 노드별 degree 를 보존한다
`make-controls.mjs` 는 corpus 사본마다 (a) degree-preserving double-edge swap replicate 20(seed 0~19 · 성공 swap |E|×20 · self-loop/duplicate 거부 · relation_type/confidence 는 간선에 붙어 이동) (b) type-preserving swap replicate 5(같은 relation_type 안에서만) (c) same-|E| Erdős–Rényi 1 을 `dbs/<corpus>.<cond>.db` 로 만들어야 하며(SHALL), (a)(b) 는 **entity_id 별 (in_degree, out_degree)** 가 원본과 정확히 같음을 검증하고 실패 시 exit 6 이어야 한다(MUST). graph 의존 지표는 real 과 shuffle null 분포(replicate 별 값)로 비교하며 `p_null = #{rep: metric_rep ≥ metric_real}/R` 을 보고한다(SHALL).

#### Scenario: 노드별 degree 보존
- WHEN shuffled-r0 사본의 노드별 (in,out) 을 원본과 대조하면 모든 entity_id 에서 같다(다중집합이 아니라 노드별)

### Requirement: R6 실행 순서(DAG) — 모든 run 이 pool 에 기여한다
러너 실행 순서는 `suite freeze → snapshot → controls → run-candidates(모든 채널 × 조건: real · shuffled-r0 · random; replicate 1~19 는 지표만) + run-final(모든 조건) → pool(모든 채널×조건 + 최종 랭킹, 깊이 100 · 증분 30/100) → blind judging → qrel freeze → run-upstream · report · decision` 이어야 하며(MUST), `pool.mjs` 는 real 조건만으로 만들어진 pool 을 거부해야 한다(exit 7 `POOL_INCOMPLETE`)(MUST). unpooled 무작위 (query, document) 100/corpus 를 판정해 missed-relevant rate 를 보고한다(SHALL).

#### Scenario: control 이 pool 에 없으면 멈춘다
- GIVEN `out/candidates.hub.shuffled-r0.jsonl` 이 없을 때
- WHEN `pool.mjs --corpus hub` 를 실행하면 exit 7

### Requirement: R7 판정 프로토콜과 품질 게이트
`suite/JUDGING.md` 는 판정자 A(Claude, 모델 id)·B(codex, 모델 id)·조정자 C · temperature · 입력 순서 seed · 채널 blind · 0/1/2 루브릭을 동결해야 한다(SHALL). `judge-merge.mjs` 는 quadratic weighted κ 를 corpus·부류별로 계산하고 **κ < 0.67 이면 exit 8 `KAPPA_BELOW_GATE`** 를 내며(MUST), 모든 불일치를 조정 목록으로 내고 조정 결과가 반영될 때까지 qrels 를 쓰지 않는다(MUST). 사람 audit 파일(`suite/human-audit.<corpus>.jsonl`, 50쌍/corpus 층화)이 있고 불일치율 ≤ 20% 면 qrels 등급 = `decision-grade`, 없거나 실패면 `LLM-judged provisional` 로 표시한다(MUST). `run-decision.mjs` 는 provisional 등급에서 갈래 ④(remove) 를 내지 않는다(MUST).

#### Scenario: κ 게이트
- GIVEN 두 판정 파일의 weighted κ 가 0.5 이면 `judge-merge.mjs` exit 8 이고 qrels 파일이 생성되지 않는다

### Requirement: R8 통계는 짝지음 + 부트스트랩 + gatekeeping 이고 분모를 같은 줄에 적는다
`report.mjs` 는 지표마다 worse/same/better · sign test 정확 이항 p(방향) · Δ의 bootstrap 95% CI(고정 seed · 10,000 회 · 재표본 단위 = K 는 document, A·M 은 family · 매 draw 에서 한 질의의 모든 채널/조건을 함께) · 비열등성 = one-sided 95% CI 하한 vs −δ · n/usable 을 한 줄에 담아야 하며(SHALL), primary endpoint 5개(K-safety · latency-SLO · candidate · semantics · rerank)에 gatekeeping 순서 + 효능 3개 Holm 조정을 적용하고 나머지는 `exploratory` 로 표기해야 한다(MUST). corpus 별 + corpus-stratified macro 를 낸다(SHALL).

#### Scenario: 분모 누락 금지
- WHEN 지표 한 줄을 출력하면 `n=` 과 `usable=` 이 반드시 있다

### Requirement: R9 결정표는 사전 동결 임계값 + 검정력으로 다섯 갈래를 자동 판정한다
`thresholds.json`(MCID_candidate · MCID_rerank · MCID_semantics · δ · latency SLO · upstream 게이트 · 판정 예산)과 `suite/POWER.md`(pilot 분산 · 검정력 0.8 · holdout N · corpus 별)는 holdout 을 열기 전에 FREEZE 에 동결되어야 한다(MUST). `run-decision.mjs` 는 holdout 실측값에 gatekeeping 순서(upstream-first → candidate-generation+RRF → gated-rerank → remove-from-ranking → inconclusive/expand-evaluation)를 적용하고, `remove` 는 candidate·rerank·semantics 셋 다 CI 상한 < MCID(futility) 일 때만 낼 수 있으며(MUST), 그 외는 `inconclusive` 다. `DECISION.md` 에 조건별 실측·임계·판정 · 갈래 · semantics 축 · 후속 change acceptance(`mode: known-item|explore` · 방향/type/confidence · latency/quality · 재평가 명령) · 상태 `evaluation complete`(≠ root repair complete) 를 쓴다(SHALL). 임계값 변조 시 exit 3.

#### Scenario: 강제 분기 금지
- GIVEN candidate Δ의 CI 가 0 을 포함하고 CI 상한 ≥ MCID(검정력 부족)이면
- THEN 판정은 `remove` 가 아니라 `inconclusive → expand-evaluation`

### Requirement: R10 격리 — 요약 off · 사본만 · 한 번에 하나
모든 러너는 `RAG_MEMORY_SEARCH_SUMMARIES=off` 를 강제하고(MUST) 원본 DB 경로를 열려 하면 exit 4 `REFUSE_LIVE_DB`(MUST). README 는 계측 프로세스 동시 1개를 명시한다.

### Requirement: R11 후속 change 개설이 DoD 다
`run-decision.mjs` 가 갈래를 내면 같은 commit 에 `specs/changes/<selected>/proposal.md`(acceptance 포함)가 존재해야 하며(MUST), `DECISION.md` 는 프레임워크 tracker receipt(hub `decisions/current-focus.md` ② 갱신 · spec §2 상태 갱신) 경로를 담아야 한다(SHALL) — 없으면 DoD 미충족.

### Requirement: R12 산출은 repo 에 남는다
suite · observed · qrels · thresholds · POWER · `out/*.jsonl` · `DECISION.md` · README · 스크립트 · golden 은 commit 대상이고 `dbs/` 만 `.gitignore` 다(SHALL).

## MODIFIED Requirements
(없음 — 제품 검색 계약 무변. R2 는 내부 메서드 추가 · MCP 도구 목록/스키마 무변.)

## REMOVED Requirements
(없음)
