# graph-role evaluation report — Stage 1 pilot (dev split · SUMMARIES=off)

**PROVISIONAL.** Stage 1 is a pilot for variance, not for conclusions (proposal D3/r4). No decision branch is taken here; `run-decision.mjs` (Stage 2) does that on holdout.

Generated 2026-08-18T04:00:57.459Z · engine worktree head `334a409fd85723090f726aab13415276239c27ce` · node v24.12.0.
Driver run: 2026-08-17T22:25:35Z → 2026-08-18T01:38:16Z (162 steps, nonzero exits []) · measured with light concurrent load (subagent editing only; no builds/tests during the run).

Channel labels: `vector` = **product base ranking (no graph)** — `hybridSearch(q,K,false)` = vector ∨ FTS-boost, so `rrf2`/`rrf3` fold FTS in twice. `purevec` (separate file) = a raw chunk-vector scan, independent of the product path.

Gold sources — every metric line names the one it used:
- `authored` = the suite's own gold (K `document_id` / `oracle_chunk_id` · A `source_docs` · M `source_docs` + `family`). Needs no judging, exists for all three corpora, and is **not** truncated by pool depth. Grades are binary (gold = 1).
- `judged` = qrels (document grade = max over judged chunks, graded 0/1/2). Pass 1 judged a **fixed-depth-10** pool; the predeclared depth-30 subset is not judged for now and ranks 31–100 are unjudged. So on judged gold nDCG@10 / hit@k(k≤10) are estimable for every judged query, **recall@30(doc) only where `judged_depth: 30`**, and recall@100 is **exploratory only**.

## hub

Measured rows: 113 (split dev) — K 53 · A 30 · M 30. Suite file holds 143 rows (dev+holdout).
qrels: **absent** (`suite/qrels.hub.jsonl` does not exist — judging pass 1 has not produced it). Primary gold = **authored**; every judged-gold line below says `qrels absent`.

### Primary endpoints (gatekeeping order)

- **(1) K-safety** Δhit@5(on−off), oracle chunk · gold=authored (suite oracle; needs no judging): mean -0.302 · one-sided 95% lower -0.415 vs −δ=-0.02 → **FAIL** · worse/same/better 16/37/0 · sign p=3.05e-5 · cluster=document · n=53 usable=53
- **(2) latency-SLO** (gold=n/a — latency is gold-independent) warm p95 ms ≤ 1000 → **PASS** · channels vector=40 · fts=6 · graph-seed=3 · graph-n1=24 · graph-n2=15 · graph-vec=7 · final off/on=19/28 · fixedpool_rerank=67 · cold p95=950 (recorded, not gated) · rrf2/rrf3/rrf3-n2 are fused in-process and carry no ms (excluded) · measured under light concurrent load, **this run only** · n=113 usable=112 (first row dropped: process warm-up)
- **(3) candidate** Δrecall@30(doc) rrf3−rrf2, A+M · gold=authored **[primary]**: mean 0.000 · 95% CI [-0.040, 0.042] · MCID 0.05 · worse/same/better 3/54/3 · sign p=1.0000 · cluster=family · n=60 usable=60
- **(4) semantics** graph-n1 recall@30(doc) real vs degree-preserving shuffle null, A+M · gold=authored **[primary]**: real 0.300 · null mean 0.110 (R=20/20) · Δ 0.190 vs MCID 0.03 · p_null 0/20=0.000 vs ≤0.05 → **PASS** · resolution floor 1/20=0.050, add-one estimate 0.048 (Holm below uses the add-one value — a permutation p is never exactly 0) · n=60 usable=60
- **(5) rerank** ΔnDCG@10 fixed-pool(with_graph−base), A+M, pool = product base@30 · gold=authored **[primary]**: mean 0.015 · 95% CI [-0.024, 0.053] · MCID 0.05 · worse/same/better 7/35/18 · sign p=0.0433 · cluster=family · n=60 usable=60 · authored gold is binary (gain 1), so this nDCG is a binary-relevance nDCG
- judged-gold block · gold=judged: **qrels absent** — `suite/qrels.hub.jsonl` not written yet; no judged numbers are shown or imputed · n=0 usable=0

- **Holm** over the pre-declared efficacy family (m=3, family size held at 3 even when an endpoint is not estimable — those enter as p=1, which is conservative) · gold=authored: candidate p=1.0000→1.0000 · semantics p=0.0476→0.1299 · rerank p=0.0433→0.1299 · n=3 usable=3

### Exploratory (descriptive — never a gate, never a power input)

- recall@K(doc) by channel, A+M · gold=authored · @100 is exploratory only (never a gate or a power input): vector=0.62/0.75/0.88 · fts=0.59/0.84/0.98 · graph-seed=0.33/0.49/0.73 · graph-n1=0.17/0.30/0.52 · graph-n2=0.07/0.12/0.28 · graph-vec=0.52/0.72/0.83 · rrf2=0.68/0.88/0.98 · rrf3=0.72/0.88/0.98 · rrf3-n2=0.60/0.84/0.93 · n=60 usable=60
- recall@K over the **unique-document budget** (docK lists = first K distinct documents), A+M · gold=authored: vector=0.65/0.87 · fts=0.72/0.96 · graph-seed=0.39/0.72 · graph-n1=0.28/0.47 · graph-n2=0.09/0.18 · graph-vec=0.58/0.77 · rrf2=0.72/0.96 · rrf3=0.80/0.95 · rrf3-n2=0.75/0.90 · n=60 usable=60
- MRR(doc, over chunk100) and hit@10(doc, ≥1 gold document inside the top-10 chunks) by channel, A+M · gold=authored: vector=0.58/0.82 · fts=0.57/0.80 · graph-seed=0.27/0.52 · graph-n1=0.17/0.28 · graph-n2=0.06/0.12 · graph-vec=0.51/0.75 · rrf2=0.62/0.90 · rrf3=0.54/0.95 · rrf3-n2=0.43/0.83 · n=60 usable=60
- K known-item hit@1/@5/@10 (oracle chunk, product final) · gold=authored: off=0.92/0.98/1.00 · on=0.64/0.68/0.83 · n=53 usable=53
- pure-vector channel (separate run, real only) recall@10/@30(doc), A+M · gold=authored: purevec=0.53/0.72 · fts=0.59/0.84 · **RRF(purevec,fts)**=0.68/0.88 vs **rrf2**(product base ∪ fts)=0.68/0.88 · n=60 usable=60
- alternative control families for graph-n1 recall@30(doc), A+M · gold=authored: real 0.300 · type-preserving swap null 0.162 (R=5/5) · same-|E| random null 0.108 (R=1/1) · the pre-registered null for endpoint (4) is the degree-preserving shuffle; these two are the direction/type axis (D6 b/c) and are descriptive only · n=60 usable=60
- seam status distribution (gold=n/a — run diagnostics, not a retrieval metric): vector=113 · mean seeds 10.00 · mean 1-hop connected 43.76 · mean 2-hop entities 91.00 · mean reach chunks 1769.06 / docs 152.06 · **reachable-set recall (`graph-reach`, D4) is not computable from these outputs** — the runner recorded the reach set SIZES, not the set, so no recall can be derived without re-running · n=113 usable=113
- upstream gates · gold=authored: `out/upstream.hub.jsonl` absent — **upstream not run** · n=0 usable=0
- link precision · gold=link-audit judge: `out/link-precision.hub.json` absent — **link audit not merged** (judge-A verdicts pending) · n=0 usable=0

## uap

Measured rows: 114 (split dev) — K 54 · A 30 · M 30. Suite file holds 144 rows (dev+holdout).
qrels: **absent** (`suite/qrels.uap.jsonl` does not exist — judging pass 1 has not produced it). Primary gold = **authored**; every judged-gold line below says `qrels absent`.

### Primary endpoints (gatekeeping order)

- **(1) K-safety** Δhit@5(on−off), oracle chunk · gold=authored (suite oracle; needs no judging): mean -0.296 · one-sided 95% lower -0.407 vs −δ=-0.02 → **FAIL** · worse/same/better 16/38/0 · sign p=3.05e-5 · cluster=document · n=54 usable=54
- **(2) latency-SLO** (gold=n/a — latency is gold-independent) warm p95 ms ≤ 1000 → **PASS** · channels vector=24 · fts=4 · graph-seed=1 · graph-n1=4 · graph-n2=3 · graph-vec=2 · final off/on=29/22 · fixedpool_rerank=56 · cold p95=1123 (recorded, not gated) · rrf2/rrf3/rrf3-n2 are fused in-process and carry no ms (excluded) · measured under light concurrent load, **this run only** · n=114 usable=113 (first row dropped: process warm-up)
- **(3) candidate** Δrecall@30(doc) rrf3−rrf2, A+M · gold=authored **[primary]**: mean 0.000 · 95% CI [-0.055, 0.050] · MCID 0.05 · worse/same/better 3/53/4 · sign p=1.0000 · cluster=family · n=60 usable=60
- **(4) semantics** graph-n1 recall@30(doc) real vs degree-preserving shuffle null, A+M · gold=authored **[primary]**: real 0.481 · null mean 0.201 (R=20/20) · Δ 0.279 vs MCID 0.03 · p_null 0/20=0.000 vs ≤0.05 → **PASS** · resolution floor 1/20=0.050, add-one estimate 0.048 (Holm below uses the add-one value — a permutation p is never exactly 0) · n=60 usable=60
- **(5) rerank** ΔnDCG@10 fixed-pool(with_graph−base), A+M, pool = product base@30 · gold=authored **[primary]**: mean 0.015 · 95% CI [-0.003, 0.034] · MCID 0.05 · worse/same/better 6/45/9 · sign p=0.6072 · cluster=family · n=60 usable=60 · authored gold is binary (gain 1), so this nDCG is a binary-relevance nDCG
- judged-gold block · gold=judged: **qrels absent** — `suite/qrels.uap.jsonl` not written yet; no judged numbers are shown or imputed · n=0 usable=0

- **Holm** over the pre-declared efficacy family (m=3, family size held at 3 even when an endpoint is not estimable — those enter as p=1, which is conservative) · gold=authored: candidate p=1.0000→1.0000 · semantics p=0.0476→0.1429 · rerank p=0.6072→1.0000 · n=3 usable=3

### Exploratory (descriptive — never a gate, never a power input)

- recall@K(doc) by channel, A+M · gold=authored · @100 is exploratory only (never a gate or a power input): vector=0.60/0.82/0.95 · fts=0.61/0.82/0.96 · graph-seed=0.46/0.70/0.91 · graph-n1=0.20/0.48/0.82 · graph-n2=0.07/0.17/0.45 · graph-vec=0.60/0.80/0.95 · rrf2=0.66/0.88/0.97 · rrf3=0.66/0.88/0.97 · rrf3-n2=0.65/0.84/0.97 · n=60 usable=60
- recall@K over the **unique-document budget** (docK lists = first K distinct documents), A+M · gold=authored: vector=0.72/0.92 · fts=0.74/0.93 · graph-seed=0.59/0.90 · graph-n1=0.35/0.74 · graph-n2=0.08/0.31 · graph-vec=0.67/0.93 · rrf2=0.75/0.94 · rrf3=0.75/0.95 · rrf3-n2=0.71/0.93 · n=60 usable=60
- MRR(doc, over chunk100) and hit@10(doc, ≥1 gold document inside the top-10 chunks) by channel, A+M · gold=authored: vector=0.45/0.83 · fts=0.47/0.82 · graph-seed=0.35/0.65 · graph-n1=0.19/0.33 · graph-n2=0.07/0.15 · graph-vec=0.41/0.83 · rrf2=0.54/0.92 · rrf3=0.47/0.87 · rrf3-n2=0.39/0.87 · n=60 usable=60
- K known-item hit@1/@5/@10 (oracle chunk, product final) · gold=authored: off=0.85/0.94/0.94 · on=0.61/0.65/0.70 · n=54 usable=54
- pure-vector channel (separate run, real only) recall@10/@30(doc), A+M · gold=authored: purevec=0.59/0.78 · fts=0.61/0.82 · **RRF(purevec,fts)**=0.65/0.88 vs **rrf2**(product base ∪ fts)=0.66/0.88 · n=60 usable=60
- alternative control families for graph-n1 recall@30(doc), A+M · gold=authored: real 0.481 · type-preserving swap null 0.258 (R=5/5) · same-|E| random null 0.217 (R=1/1) · the pre-registered null for endpoint (4) is the degree-preserving shuffle; these two are the direction/type axis (D6 b/c) and are descriptive only · n=60 usable=60
- seam status distribution (gold=n/a — run diagnostics, not a retrieval metric): vector=114 · mean seeds 10.13 · mean 1-hop connected 48.35 · mean 2-hop entities 82.82 · mean reach chunks 664.50 / docs 83.37 · **reachable-set recall (`graph-reach`, D4) is not computable from these outputs** — the runner recorded the reach set SIZES, not the set, so no recall can be derived without re-running · n=114 usable=114
- upstream gates · gold=authored: `out/upstream.uap.jsonl` absent — **upstream not run** · n=0 usable=0
- link precision · gold=link-audit judge: `out/link-precision.uap.json` absent — **link audit not merged** (judge-A verdicts pending) · n=0 usable=0

## hal

Measured rows: 116 (split dev) — K 56 · A 30 · M 30. Suite file holds 142 rows (dev+holdout).
qrels: **absent** (`suite/qrels.hal.jsonl` does not exist — judging pass 1 has not produced it). Primary gold = **authored**; every judged-gold line below says `qrels absent`.

### Primary endpoints (gatekeeping order)

- **(1) K-safety** Δhit@5(on−off), oracle chunk · gold=authored (suite oracle; needs no judging): mean -0.196 · one-sided 95% lower -0.286 vs −δ=-0.02 → **FAIL** · worse/same/better 11/45/0 · sign p=0.0010 · cluster=document · n=56 usable=56
- **(2) latency-SLO** (gold=n/a — latency is gold-independent) warm p95 ms ≤ 1000 → **PASS** · channels vector=22 · fts=2 · graph-seed=1 · graph-n1=1 · graph-n2=1 · graph-vec=2 · final off/on=6/7 · fixedpool_rerank=23 · cold p95=272 (recorded, not gated) · rrf2/rrf3/rrf3-n2 are fused in-process and carry no ms (excluded) · measured under light concurrent load, **this run only** · n=116 usable=115 (first row dropped: process warm-up)
- **(3) candidate** Δrecall@30(doc) rrf3−rrf2, A+M · gold=authored **[primary]**: mean 0.042 · 95% CI [0.008, 0.080] · MCID 0.05 · worse/same/better 0/55/5 · sign p=0.0625 · cluster=family · n=60 usable=60
- **(4) semantics** graph-n1 recall@30(doc) real vs degree-preserving shuffle null, A+M · gold=authored **[primary]**: real 0.572 · null mean 0.231 (R=20/20) · Δ 0.341 vs MCID 0.03 · p_null 0/20=0.000 vs ≤0.05 → **PASS** · resolution floor 1/20=0.050, add-one estimate 0.048 (Holm below uses the add-one value — a permutation p is never exactly 0) · n=60 usable=60
- **(5) rerank** ΔnDCG@10 fixed-pool(with_graph−base), A+M, pool = product base@30 · gold=authored **[primary]**: mean 0.035 · 95% CI [-0.013, 0.079] · MCID 0.05 · worse/same/better 8/27/25 · sign p=0.0046 · cluster=family · n=60 usable=60 · authored gold is binary (gain 1), so this nDCG is a binary-relevance nDCG
- judged-gold block · gold=judged: **qrels absent** — `suite/qrels.hal.jsonl` not written yet; no judged numbers are shown or imputed · n=0 usable=0

- **Holm** over the pre-declared efficacy family (m=3, family size held at 3 even when an endpoint is not estimable — those enter as p=1, which is conservative) · gold=authored: candidate p=0.0625→0.0952 · semantics p=0.0476→0.0952 · rerank p=0.0046→0.0137 · n=3 usable=3

### Exploratory (descriptive — never a gate, never a power input)

- recall@K(doc) by channel, A+M · gold=authored · @100 is exploratory only (never a gate or a power input): vector=0.75/0.86/0.98 · fts=0.67/0.88/0.96 · graph-seed=0.54/0.76/0.89 · graph-n1=0.37/0.57/0.78 · graph-n2=0.15/0.32/0.58 · graph-vec=0.69/0.85/0.96 · rrf2=0.84/0.92/0.99 · rrf3=0.80/0.96/1.00 · rrf3-n2=0.72/0.96/0.98 · n=60 usable=60
- recall@K over the **unique-document budget** (docK lists = first K distinct documents), A+M · gold=authored: vector=0.82/0.96 · fts=0.78/0.95 · graph-seed=0.69/0.88 · graph-n1=0.46/0.74 · graph-n2=0.25/0.51 · graph-vec=0.72/0.91 · rrf2=0.89/0.98 · rrf3=0.91/0.98 · rrf3-n2=0.82/0.98 · n=60 usable=60
- MRR(doc, over chunk100) and hit@10(doc, ≥1 gold document inside the top-10 chunks) by channel, A+M · gold=authored: vector=0.64/0.97 · fts=0.66/0.87 · graph-seed=0.42/0.78 · graph-n1=0.26/0.55 · graph-n2=0.12/0.23 · graph-vec=0.58/0.92 · rrf2=0.80/0.97 · rrf3=0.65/0.95 · rrf3-n2=0.51/0.87 · n=60 usable=60
- K known-item hit@1/@5/@10 (oracle chunk, product final) · gold=authored: off=0.91/1.00/1.00 · on=0.71/0.80/0.84 · n=56 usable=56
- pure-vector channel (separate run, real only) recall@10/@30(doc), A+M · gold=authored: purevec=0.67/0.82 · fts=0.67/0.88 · **RRF(purevec,fts)**=0.80/0.92 vs **rrf2**(product base ∪ fts)=0.84/0.92 · n=60 usable=60
- alternative control families for graph-n1 recall@30(doc), A+M · gold=authored: real 0.572 · type-preserving swap null 0.306 (R=5/5) · same-|E| random null 0.221 (R=1/1) · the pre-registered null for endpoint (4) is the degree-preserving shuffle; these two are the direction/type axis (D6 b/c) and are descriptive only · n=60 usable=60
- seam status distribution (gold=n/a — run diagnostics, not a retrieval metric): vector=116 · mean seeds 10.00 · mean 1-hop connected 28.20 · mean 2-hop entities 63.14 · mean reach chunks 437.90 / docs 73.90 · **reachable-set recall (`graph-reach`, D4) is not computable from these outputs** — the runner recorded the reach set SIZES, not the set, so no recall can be derived without re-running · n=116 usable=116
- upstream gates · gold=authored: `out/upstream.hal.jsonl` absent — **upstream not run** · n=0 usable=0
- link precision · gold=link-audit judge: `out/link-precision.hal.json` absent — **link audit not merged** (judge-A verdicts pending) · n=0 usable=0

## Corpus-stratified macro (mean of corpus means — no naive pooling)

- candidate Δrecall@30(doc) macro 0.014 · rerank ΔnDCG@10 macro 0.021 · gold=per-corpus primary (hub:authored uap:authored hal:authored) · n=3 usable=3 corpora
- K-safety per corpus hub:FAIL uap:FAIL hal:FAIL · latency-SLO hub:PASS uap:PASS hal:PASS · semantics PASS 3/3 · gold=per-corpus primary · n=3 usable=3
- Stage 2 branch inputs (counts only — the branch is decided on holdout): candidate point ≥ MCID 0.05 in 0/3 corpora, unadjusted CI lower > 0 in 1/3 · rerank point ≥ MCID 0.05 in 0/3, CI lower > 0 in 0/3 · gold=per-corpus primary · n=3 usable=3

## Reading this report

- Gatekeeping order is **K-safety → latency-SLO → candidate → semantics → rerank**. The five branch conditions (upstream-first / candidate-generation+RRF / gated-rerank / remove-from-ranking / inconclusive→expand-evaluation) are applied by `run-decision.mjs` on **holdout**, not here. Stage 1 supplies variance for `suite/POWER.md`.
- Holm is applied over the three efficacy endpoints (candidate · semantics · rerank) with the family size pre-declared at 3.
- `n=` is the rows the endpoint was eligible for; `usable=` is the rows the metric could actually be computed on (gold present, and — on judged gold — judged deeply enough).
- Anything under **Exploratory** is descriptive only: it is not a gate, is not Holm-adjusted, and must not be quoted as an outcome.
- `remove-from-ranking` needs futility evidence and `decision-grade` qrels; with `LLM-judged provisional` or absent qrels it is unavailable by construction (proposal D10).
