# DECISION — graph-role-evaluation (Stage 1, authored axis)

**갈래 = ① upstream-first** · 등급 **`provisional`** · 상태 **`evaluation complete`** (≠ `root repair complete`).

생성 2026-08-22T04:27:30.723Z · 근거 = `out/report.md`(생성 2026-08-20T08:37:04.152Z · engine head `334a409fd85723090f726aab13415276239c27ce`) + `out/upstream.<c>.jsonl` + `out/link-precision.<c>.json` + `suite/judging-record.json`. 이 파일은 `run-decision.mjs` 가 씁니다 — 손으로 고치지 말고 러너를 다시 돌리세요.

대상 corpus = **hub · uap · hal** (3/3 of `lib/paths.mjs` CORPORA).

## 0. 이 판정이 무엇 위에 서 있나 (측정 기반)

소비한 리포트 = **Stage 1 pilot (dev split · SUMMARIES=off)** · stage `stage-1-pilot` · split `dev`.

🔴 **이 갈래는 holdout 이 아니라 Stage 1 pilot(dev split) 실측 위에서 선택됐다.** 동결 규정(proposal D3/r4)은 결정을 holdout 에서 내리도록 적어 두었으므로, 그 조건은 **충족되지 않았다.** 무엇이 그래도 성립하고 무엇이 성립하지 않는지를 갈라 적는다:

- **성립**: 갈래 ①(`upstream-first`)의 진입 게이트는 *검정력이 필요한 효능 비교*가 아니라 **구조 지표**다 — 소스 문서가 진술하는 관계가 KG 에 존재하는가. 그리고 dev/holdout 분리가 막으려는 누출 통로(**작성자가 답을 보고 문제를 냄**)는 이 suite 에서 **다른 방식으로 이미 닫혀 있다**: A·M 질의 전부가 `author_mode: source-grounded`(작성자는 `documents.content` + `entities.name` 만 열람, `relationships`·`chunk_entities` 금지)이고 `kg-informed` 는 **0건**이다.
- **성립 안 함**: 그럼에도 이 값의 **두 번째 독립 추정치는 없다.** 그리고 홀드아웃으로 확인할 길이 지금은 막혀 있다 — **holdout 에는 A·M 질의가 존재하지 않는다**(전 corpus `A 30 dev / M 30 dev`, holdout 은 K 뿐: hub 30 · uap 30 · hal 26). `edge_validity` 는 주로 M 브리지 질의에서 나오므로, holdout 판을 만들려면 **T9(A·M holdout 작성·동결)를 먼저 해야 한다.**
- **등급 귀결**: 이 사유만으로도 결론은 `provisional` 을 벗어날 수 없다. 러너가 이것을 **구조적으로 강제**한다(판정 기록의 `grade` 가 무엇이든 pilot 리포트면 `provisional` 로 내린다).

> 이 절은 *"dev 라 괜찮다"* 도 *"dev 라 틀렸다"* 도 아니다 — **무엇을 쟀고 무엇을 안 쟀는지**를 읽는 사람이 직접 판단할 수 있게 적어 둔 것이다.

## 1. 결정표 적용 (proposal D8 lines 63–71 · delta R9, gatekeeping 순서 = 첫 참인 갈래)

| 갈래 | 참? | 근거 |
|---|---|---|
| ① upstream-first | **예** | 게이트 미달 3건: hub.edge_validity=0.194 < 0.8 · uap.edge_validity=0.177 < 0.8 · hal.edge_validity=0.077 < 0.8 |
| ② candidate-generation+RRF | — | **평가 안 함** — gatekeeping 순서상 앞 갈래가 참이라 여기까지 오지 않았다(조건 미충족과 다르다) |
| ③ gated-rerank | — | **평가 안 함** — gatekeeping 순서상 앞 갈래가 참이라 여기까지 오지 않았다(조건 미충족과 다르다) |
| ④ remove-from-ranking | — | **평가 안 함** — gatekeeping 순서상 앞 갈래가 참이라 여기까지 오지 않았다(조건 미충족과 다르다) |
| ⑤ inconclusive → expand-evaluation | — | **평가 안 함** — gatekeeping 순서상 앞 갈래가 참이라 여기까지 오지 않았다(조건 미충족과 다르다) |

**해석 고정** (표가 남긴 자유도 — 코드 주석 `INTERPRETATIONS` 와 같은 문장):
- **I-1** *"조정 CI 하한 > 0"* — `report.mjs` 는 **비조정** bootstrap CI + Holm 조정 p 를 낸다(조정 구간이 아니다). 조정은 구간을 넓히기만 하므로 비조정 하한 ≤ 0 이면 조정 절도 실패다. 비조정 하한 > 0 인 경우에만 그 endpoint 의 **Holm 조정 p < α(=`thresholds.json.power.alpha`)** 를 추가로 요구했다.
- **I-2** corpus 정량자 — 표는 *"corpus 별 ≥ 2/3"* 을 candidate 절에만 적었다. 같은 2/3 다수결을 ②③ 의 semantics 절에 적용하고, **K 안전성·latency SLO 는 안전 게이트라 전 corpus**, ④ 의 futility 도 **전 corpus** 를 요구했다.
- **I-3** semantics futility — `report.mjs` 는 semantics Δ 의 CI 를 내지 않는다. 그래서 그 endpoint 의 *"CI 상한 < MCID"* 는 **성립 불가**(`SEMANTICS_CI_ABSENT`)이고 ④ 는 현재 보고 형식에서 도달할 수 없다. 어떤 값도 대입하지 않았다.
- **I-4** *"검정력 확보 상태"* — `suite/POWER.md` 가 `suite/FREEZE.md` 에 해시로 동결돼 있고 해시가 일치할 때만 인정. 현재 = **동결 안 됨(파일을 쓴 것은 동결이 아니다)**.

## 2. Primary endpoint 5종 — 실측 · 임계 · 판정

gatekeeping 순서 = K 안전성 → latency SLO → candidate → semantics → rerank. **정답원(gold)은 매 줄에 적혀 있다** — 이 회차는 전부 `authored`(suite 자체 정답: K `oracle_chunk_id`/`document_id` · A `source_docs` · M `source_docs`+`family`)다. `judged`(qrels) 축은 성립하지 않았다(§4).

| corpus | gold | (1) K 안전성 Δhit@5 · one-sided 하한 vs −δ | (2) latency SLO warm p95 | (3) candidate Δrecall@30(doc) rrf3−rrf2 · 95% CI vs MCID | (4) semantics real vs shuffle null | (5) rerank ΔnDCG@10 · 95% CI vs MCID |
|---|---|---|---|---|---|---|
| hub | `authored` | -0.302 · 하한 -0.415 vs −0.02 → **FAIL** | ≤ 1000ms → **PASS** | 0.000 · CI [-0.040, 0.042] vs MCID 0.05 (Holm p 1.0000→1.0000) | real 0.300 · null 0.110 (R=20/20) · Δ 0.190 vs MCID 0.03 · p_null 0.000 ≤ 0.05 → **PASS** | 0.015 · CI [-0.024, 0.053] vs MCID 0.05 (Holm p 0.0433→0.1299) |
| uap | `authored` | -0.296 · 하한 -0.407 vs −0.02 → **FAIL** | ≤ 1000ms → **PASS** | 0.000 · CI [-0.055, 0.050] vs MCID 0.05 (Holm p 1.0000→1.0000) | real 0.481 · null 0.201 (R=20/20) · Δ 0.279 vs MCID 0.03 · p_null 0.000 ≤ 0.05 → **PASS** | 0.015 · CI [-0.003, 0.034] vs MCID 0.05 (Holm p 0.6072→1.0000) |
| hal | `authored` | -0.196 · 하한 -0.286 vs −0.02 → **FAIL** | ≤ 1000ms → **PASS** | 0.042 · CI [0.008, 0.080] vs MCID 0.05 (Holm p 0.0625→0.0952) | real 0.572 · null 0.231 (R=20/20) · Δ 0.341 vs MCID 0.03 · p_null 0.000 ≤ 0.05 → **PASS** | 0.035 · CI [-0.013, 0.079] vs MCID 0.05 (Holm p 0.0046→0.0137) |

숫자는 전부 `out/report.md` 에서 **그대로 읽은 값**이다 — 이 스크립트는 통계를 다시 계산하지 않는다(bootstrap CI · sign test · Holm · 각 endpoint 판정은 `report.mjs` 소유). 분모(`n`/`usable`)와 계산 조건은 `out/report.md` 의 같은 줄에 있다.

## 3. semantics 축 (②③ 의 필요조건이자 별도 기록 — proposal D8 각주)

| corpus | real | degree-preserving shuffle null (평균) | Δ vs MCID | p_null vs ≤ | 판정 | Holm 조정 p |
|---|---|---|---|---|---|---|
| hub | 0.300 | 0.110 (R=20/20) | 0.190 vs 0.03 | 0.000 vs ≤0.05 | **PASS** | 0.1299 |
| uap | 0.481 | 0.201 (R=20/20) | 0.279 vs 0.03 | 0.000 vs ≤0.05 | **PASS** | 0.1429 |
| hal | 0.572 | 0.231 (R=20/20) | 0.341 vs 0.03 | 0.000 vs ≤0.05 | **PASS** | 0.0952 |

**읽는 법**: 사전 등록된 게이트는 *Δ ≥ MCID 이면서 raw `p_null` ≤ p_null_max* 이고 그 기준으로 **3/3 PASS** 다. 같은 endpoint 의 **Holm 조정 p 는 0.05 를 넘는다** — 이건 endpoint 실패가 아니라 **R(replicate) 의 해상도 한계**다(R=20 이면 add-one 하한 1/(R+1) 이 Holm 첫 단계 α/m 보다 이미 크다). 상세 = `out/report.md` 의 macro 줄.

그래서 semantics 축의 결론은 *"real 그래프가 degree-preserving null 보다 낫다"* 까지이고, **그 이득이 제품 이득으로 이어졌는지는 (3)(5) 가 답한다** — 둘 다 MCID 미달이다.

## 4. 판정(judging) 기록 — qrels 는 성립하지 않았다

- 출처: `.superpowers/sdd/2026-08-17-graph-role-evaluation-stage1/progress.md — entries `JUDGING hub COMPLETE + KAPPA GATE FAIL (2026-08-20)` and `USER DECISION (2026-08-20)` (worktree-local ledger, git-ignored)`
- **hub**: pass 1 (fixed depth 10) · 판정자 A=claude-sonnet-5 · B=gpt-5 (codex) · C=not dispatched (the gate halts before adjudication) · weighted κ all 0.619 · A 0.659 · M 0.571 vs 게이트 **0.67** → **KAPPA_BELOW_GATE (judge-merge.mjs --pass1-only, exit 8)** · qrels 작성 **안 됨** · 조정 not run (no to-adjudicate file is produced when the gate halts)
  - 불일치 프로파일: agree 2916/4135 (70.5%); of the 1219 disagreements 0↔1 817 (67%) · 1↔2 270 (22%) · 0↔2 head-on 132 (11%); judge B more lenient in 997/1219 (82%) = systematic grade-boundary calibration gap, not noise
- **uap**: not judged · 판정자 n/a · weighted κ n/a vs 게이트 **0.67** → **n/a — judging cancelled by the 2026-08-20 user decision before this corpus was pooled for judging** · qrels 작성 **안 됨**
- **hal**: not judged · 판정자 n/a · weighted κ n/a vs 게이트 **0.67** → **n/a — judging cancelled by the 2026-08-20 user decision before this corpus was pooled for judging** · qrels 작성 **안 됨**
- 미판정 corpus = uap, hal (사용자 결정으로 취소)
- 사람 audit(floor 50쌍/corpus): **없음** — the 50-pair/corpus floor (thresholds.json human_audit.pairs_per_corpus) is user time and was not spent; without it qrels could only ever have been `LLM-judged provisional` (proposal D10)
- 동결된 미달 구제 절차(`suite/JUDGING.md`): the frozen suite/JUDGING.md remedy for a below-gate kappa = revise the rubric examples, re-run BOTH judges over the whole corpus, and discard the earlier outputs to pool/rejected/ · 실행 **안 함** — user decision 2026-08-20 — the judged axis cannot flip the K-safety FAIL without both a gate pass and a human audit, and the upstream-first evidence needs neither
- **사용자 결정 (2026-08-20)**: stop at the kappa gate; do NOT execute the frozen re-judge remedy; conclude Stage 1 on the authored axis. Judged qrels recorded as not established. Pass 2 / uap / hal judging stays cancelled.
  - 사용자 원문: *"구축개선 할때 graph rag을 확실히 조사해서 구축하자"*

**등급 = `provisional`.** 근거 = qrels 미성립(κ 0.619 < 0.67) + 사람 audit 부재 (proposal D10 · delta R7). **이 등급이 금지하는 것**:
- 갈래 ④ `remove-from-ranking` (delta R7 MUST — 이 스크립트가 코드로 막는다).
- 릴리스 결정(제품 기본값·랭킹 공식 변경의 최종 근거로 쓰는 것). v5.3.0 의 `useGraph` opt-in **containment 는 유지**된다.
- 허용되는 것 = 갈래 ⑤, 그리고 ②③ 의 **provisional** 판정.

## 5. upstream 증거 (D5 지표 · D8 진입 조건)

| corpus | seed recall | edge validity (기대 edge 가 KG 에 실존) | link precision(name) | 판정 |
|---|---|---|---|---|
| hub | 57/60 = 0.950 vs ≥0.7 → **PASS** | 12/62 = 0.194 vs ≥0.8 → **FAIL** | 1.000 (n=14 pairs / 60 chunk clusters) vs ≥0.6 → **PASS** | **미달** |
| uap | 56/60 = 0.933 vs ≥0.7 → **PASS** | 11/62 = 0.177 vs ≥0.8 → **FAIL** | 1.000 (n=93 pairs / 60 chunk clusters) vs ≥0.6 → **PASS** | **미달** |
| hal | 56/60 = 0.933 vs ≥0.7 → **PASS** | 5/65 = 0.077 vs ≥0.8 → **FAIL** | 0.989 (n=88 pairs / 60 chunk clusters) vs ≥0.6 → **PASS** | **미달** |

- **hub** 부가: required edge 중 KG 부재 50건 · link precision weighted 0.237 CI [0.185, 0.289] (pairs 590 / chunks 60) · nonliteral 0.139 (n=576) · 판정자 신뢰도 n=118 agreement 0.932 κ 0.768 · judged-gold 지표 60/60 행이 `qrels-absent` 로 null (**측정 안 됨이지 0 이 아니다**)
- **uap** 부가: required edge 중 KG 부재 51건 · link precision weighted 0.465 CI [0.370, 0.567] (pairs 577 / chunks 60) · nonliteral 0.112 (n=484) · 판정자 신뢰도 n=115 agreement 0.974 κ 0.920 · judged-gold 지표 60/60 행이 `qrels-absent` 로 null (**측정 안 됨이지 0 이 아니다**)
- **hal** 부가: required edge 중 KG 부재 60건 · link precision weighted 0.475 CI [0.398, 0.549] (pairs 572 / chunks 60) · nonliteral 0.229 (n=484) · 판정자 신뢰도 n=114 agreement 0.912 κ 0.818 · judged-gold 지표 60/60 행이 `qrels-absent` 로 null (**측정 안 됨이지 0 이 아니다**)

**읽는 법**: seed 는 들어온다(95.0% · 93.3% · 93.3%) — 질의가 가리키는 entity 를 검색이 찾는다. **다리가 없다**(edge validity 19.4% · 17.7% · 7.7%) — 소스 텍스트가 진술하는 관계가 KG 에 대부분 존재하지 않는다. 즉 랭킹 공식 이전에 **탐색할 그래프가 없다**. 이것이 갈래 ① 의 실체다.

## 6. §227 재현 쿼리 — upstream 수리 후 다시 볼 것 (관찰, 이번 회차에 실행하지 않음)

출처 = hub 로그 `logs/2026-08/2026-08-17.md` §227(표본 2/2 재현). **이 스크립트는 MCP·라이브 DB 를 부르지 않는다** — 아래는 그때 실측된 값을 그대로 옮긴 관찰이고, 후속 change 의 재평가 항목이다.

1. *"경고를 내는 훅이 계약 밖 값을 반환해서 위험할 때만 조용히 죽었다"* (정답 = 세션29 gotcha (wiki/gotchas.md))
   - 2026-08-17 실측: useGraph:true → 1위 오답(세션18 gotcha, vector 0.5153, boost 0.4), 정답(vector 0.5641)은 top-3 밖 · useGraph:false → 정답 1위 · v5.3.0 canary(기본 off) → 정답 top-1 (`wiki-gotchas_chunk_21`)
   - **재확인 조건**: upstream change 출하 후 `useGraph: true` 로도 정답이 top-1 이어야 한다(설계 spec `2026-08-17-graph-role-redesign-design.md` §2 의 수용 기준). 기본값 off 로 top-1 인 것은 containment 이지 수리가 아니다.
2. *"빈 디렉터리 사슬이 경로 길이 제한 때문에 검사를 죽이고 있었다"* (정답 = 세션23 gotcha)
   - 2026-08-17 실측: useGraph:true → `vector_similarity 0` 인 무관 청크가 entity 링크 수만으로 상위 진입, 정답 gotcha 는 2위(vector 0, boost 0.375)
   - **재확인 조건**: upstream change 출하 후 `useGraph: true` 로도 정답이 top-1 이어야 한다(설계 spec `2026-08-17-graph-role-redesign-design.md` §2 의 수용 기준). 기본값 off 로 top-1 인 것은 containment 이지 수리가 아니다.

## 7. 후속 change (delta R11 — 같은 commit 에 존재해야 한다)

- 갈래 ① upstream-first 의 D8 후속 = `entity-link-quality`(또는 seed 매칭 수리) 를 이 change 가 연다
- **개설 대상 = `specs/changes/graph-upstream-build/proposal.md`** — 존재함(이 실행이 증거 블록을 갱신했다)
- slug 선택 근거: D8 은 갈래 ① 의 후속을 `entity-link-quality` 로 예시했지만 실측된 미달 성분은 링크 정밀도가 아니라 **edge 커버리지**다(seed 는 게이트를 통과, 기대 edge 는 대부분 KG 에 없다). 그래서 후속 change 는 링크 품질보다 넓은 **그래프 구축(build) 개선**이고 slug 는 `graph-upstream-build` 다 — 링크 품질 수리는 그 안의 한 축으로 들어간다.
- 후속 change 의 acceptance 는 최소 넷을 담는다(tasks.md T11 · delta R9): ① 명시적 검색 `mode`(후보 생성 vs 재랭킹) ② edge 방향·type·confidence 취급 ③ latency/quality 예산 ④ 재평가 명령(§9).

## 8. 프레임워크 tracker receipt (delta R11 — DECISION 이 경로를 담는다)

아래는 **프레임워크 hub 폴더**(이 repo 밖)의 경로다. 이 스크립트는 그 파일들을 고치지 않는다 — receipt 가 어디에 남아야 하는지를 기록한다.

- `decisions/current-focus.md` — ② (graph 랭킹 근본 수리) 항목 갱신 — B Stage 1 = evaluation complete · 갈래 · 후속 change 포인터. ⚠ `evaluation complete` ≠ `root repair complete`: ② 는 후속 구현 change 가 출하되고 post-change holdout 을 통과할 때까지 닫지 않는다 (proposal D8 [r4-B9]).
- `docs/superpowers/specs/2026-08-17-graph-role-redesign-design.md` — §2 (변경 B — graph 역할 재설계) 상태 갱신 + 이 DECISION.md 링크.

## 9. 재평가 명령 (upstream change 출하 후 이 suite 를 그대로 다시 돌린다)

```bash
# 0) 이 repo 의 워크트리에서, 계측 프로세스는 항상 한 번에 하나 (README)
node eval/graph-role/snapshot.mjs                     # 3 corpus online backup -> dbs/ (+ snapshot.json)
for c in hub uap hal; do node eval/graph-role/make-controls.mjs --corpus $c; done   # shuffled-r0..19 · typeshuf-r0..4 · random
bash eval/graph-role/run-all.sh > eval/graph-role/out/run-all.log 2>&1              # 3 corpus × 27 조건 × 2 러너 (직렬)
for c in hub uap hal; do node eval/graph-role/run-purevec.mjs --corpus $c; done
node eval/graph-role/scan-outliers.mjs                # exit 13 이면 해당 쌍만 재실행
node eval/graph-role/make-manifest.mjs --gzip
for c in hub uap hal; do node eval/graph-role/run-upstream.mjs $c; done
for c in hub uap hal; do node eval/graph-role/link-audit-sample.mjs $c; done        # 판정 A/B 후
for c in hub uap hal; do node eval/graph-role/link-audit-merge.mjs $c; done
node eval/graph-role/report.mjs                       # -> out/report.md
node eval/graph-role/power.mjs                        # -> suite/POWER.md
node eval/graph-role/run-decision.mjs                 # -> eval/graph-role/DECISION.md
```

판정(qrels) 축까지 되살리려면 그 앞에 `pool.mjs` → `judge-batches.mjs split/merge` → 조정자 C → `judge-merge.mjs <c>` 가 들어가고, **κ ≥ 0.67 를 통과해야** 등급이 `provisional` 을 벗어난다. 사람 audit 50쌍/corpus 까지 있어야 `decision-grade` 다.

## 10. 상태

- 이 change(`graph-role-evaluation`) = **`evaluation complete`**.
- **≠ `root repair complete`** — 후속 구현 change 가 출하되고 post-change holdout 을 통과하기 전까지 프레임워크 `current-focus` ② 는 닫지 않으며 v5.3.0 `useGraph` opt-in containment 는 유지된다 (proposal D8 `[r4-B9]`).

