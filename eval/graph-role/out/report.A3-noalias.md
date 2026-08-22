# graph-role evaluation report — Stage 1 pilot (dev split · SUMMARIES=off)

**PROVISIONAL.** Stage 1 is a pilot for variance, not for conclusions (proposal D3/r4). No decision branch is taken here; `run-decision.mjs` (Stage 2) does that on holdout.

Generated 2026-08-22T12:11:23.248Z · engine worktree head `334a409fd85723090f726aab13415276239c27ce` · node v24.12.0.
Driver run: 2026-08-17T22:25:35Z → 2026-08-18T01:38:16Z (162 steps, nonzero exits []) · measured with light concurrent load (subagent editing only; no builds/tests during the run).

Channel labels: `vector` = **product base ranking (no graph)** — `hybridSearch(q,K,false)` = vector ∨ FTS-boost, so `rrf2`/`rrf3` fold FTS in twice. `purevec` (separate file) = a raw chunk-vector scan, independent of the product path.

Gold sources — every metric line names the one it used:
- `authored` = the suite's own gold (K `document_id` / `oracle_chunk_id` · A `source_docs` · M `source_docs` + `family`). Needs no judging, exists for all three corpora, and is **not** truncated by pool depth. Grades are binary (gold = 1).
- `judged` = qrels (document grade = max over judged chunks, graded 0/1/2). Pass 1 judged a **fixed-depth-10** pool; the predeclared depth-30 subset is not judged for now and ranks 31–100 are unjudged. So on judged gold nDCG@10 / hit@k(k≤10) are estimable for every judged query, **recall@30(doc) only where `judged_depth: 30`**, and recall@100 is **exploratory only**.

## hub

Measured rows: 113 (split dev) — K 53 · A 30 · M 30. Suite file holds 143 rows (dev+holdout).
qrels: **absent** (`suite/qrels.hub.jsonl` does not exist — judging pass 1 has not produced it). Primary gold = **authored**; every judged-gold line below says `qrels absent`.

### Primary endpoints (gatekeeping order)

- **(1) K-safety** Δhit@5(on−off), oracle chunk · gold=authored (suite oracle; needs no judging): mean n/a · one-sided 95% lower n/a vs −δ=-0.02 → **not estimable** · worse/same/better 0/0/0 · sign p=1.0000 · cluster=document · n=0 usable=0
- **(2) latency-SLO** (gold=n/a — latency is gold-independent) warm p95 ms ≤ 1000 → **PASS** · channels vector=28 · fts=7 · graph-seed=1 · graph-n1=1 · graph-n2=2 · graph-vec=5 · final off/on=n/a/n/a · fixedpool_rerank=n/a · cold p95=n/a (recorded, not gated) · rrf2/rrf3/rrf3-n2 are fused in-process and carry no ms (excluded) · measured under light concurrent load, **this run only** · n=113 usable=112 (first row dropped: process warm-up)
- **(3) candidate** Δrecall@30(doc) rrf3−rrf2, A+M · gold=authored **[primary]**: mean 0.042 · 95% CI [-0.007, 0.092] · MCID 0.05 · worse/same/better 2/51/7 · sign p=0.1797 · cluster=family · n=60 usable=60
- **(4) semantics** graph-n1 recall@30(doc) real vs degree-preserving shuffle null, A+M · gold=authored **[primary]**: real 0.533 · null mean n/a (R=0/20) · Δ n/a vs MCID 0.03 · p_null 0/0=n/a vs ≤0.05 → **not estimable** · resolution floor 1/1=n/a, add-one estimate n/a (Holm below uses the add-one value — a permutation p is never exactly 0) · n=60 usable=60
- **(5) rerank** ΔnDCG@10 fixed-pool(with_graph−base), A+M, pool = product base@30 · gold=authored **[primary]**: mean n/a · 95% CI n/a · MCID 0.05 · worse/same/better 0/0/0 · sign p=n/a · cluster=family · n=0 usable=0 · authored gold is binary (gain 1), so this nDCG is a binary-relevance nDCG
- judged-gold block · gold=judged: **qrels absent** — `suite/qrels.hub.jsonl` not written yet; no judged numbers are shown or imputed · n=0 usable=0

- **Holm** over the pre-declared efficacy family (m=3, family size held at 3 even when an endpoint is not estimable — those enter as p=1, which is conservative) · gold=authored: candidate p=0.1797→0.5391 · semantics p=not estimable→1.0000 · rerank p=not estimable→1.0000 · n=3 usable=1

### Exploratory (descriptive — never a gate, never a power input)

- recall@K(doc) by channel, A+M · gold=authored · @100 is exploratory only (never a gate or a power input): vector=0.61/0.76/0.91 · fts=0.60/0.84/0.98 · graph-seed=0.59/0.83/0.93 · graph-n1=0.37/0.53/0.77 · graph-n2=0.07/0.16/0.38 · graph-vec=0.55/0.71/0.80 · rrf2=0.71/0.89/0.99 · rrf3=0.74/0.93/1.00 · rrf3-n2=0.72/0.93/0.98 · n=60 usable=60
- recall@K over the **unique-document budget** (docK lists = first K distinct documents), A+M · gold=authored: vector=0.65/0.88 · fts=0.70/0.96 · graph-seed=0.77/0.90 · graph-n1=0.42/0.63 · graph-n2=0.13/0.33 · graph-vec=0.62/0.76 · rrf2=0.74/0.96 · rrf3=0.83/0.98 · rrf3-n2=0.83/0.97 · n=60 usable=60
- MRR(doc, over chunk100) and hit@10(doc, ≥1 gold document inside the top-10 chunks) by channel, A+M · gold=authored: vector=0.59/0.83 · fts=0.58/0.82 · graph-seed=0.50/0.88 · graph-n1=0.26/0.58 · graph-n2=0.08/0.12 · graph-vec=0.51/0.77 · rrf2=0.62/0.92 · rrf3=0.62/0.93 · rrf3-n2=0.49/0.93 · n=60 usable=60
- K known-item hit@1/@5/@10 (oracle chunk, product final) · gold=authored: off=n/a/n/a/n/a · on=n/a/n/a/n/a · n=0 usable=0
- pure-vector channel: `out/purevec.hub.jsonl` not present — not run · gold=authored (nothing to score) · n=0 usable=0
- alternative control families for graph-n1 recall@30(doc), A+M · gold=authored: real 0.533 · type-preserving swap null n/a (R=0/5) · same-|E| random null n/a (R=0/1) · the pre-registered null for endpoint (4) is the degree-preserving shuffle; these two are the direction/type axis (D6 b/c) and are descriptive only · n=60 usable=60
- seam status distribution (gold=n/a — run diagnostics, not a retrieval metric): vector=113 · mean seeds 10.00 · mean 1-hop connected 52.43 · mean 2-hop entities 97.41 · mean reach chunks 638.06 / docs 121.88 · **reachable-set recall (`graph-reach`, D4) is not computable from these outputs** — the runner recorded the reach set SIZES, not the set, so no recall can be derived without re-running · n=113 usable=113
- upstream gates · gold=authored: `out/upstream.hub.jsonl` absent — **upstream not run** · n=0 usable=0
- link precision · gold=link-audit judge (a separate mention judgement, not qrels): name 1 (n=14) vs ≥0.6 · nonliteral 0.1388888888888889 (n=576) · weighted 0.2367 CI [0.1854,0.289] · n=590 usable=60 chunk clusters

## uap

- inputs missing: queries=144 candidates=0 → nothing to report · gold=none · n=0 usable=0

## hal

Measured rows: 116 (split dev) — K 56 · A 30 · M 30. Suite file holds 142 rows (dev+holdout).
qrels: **absent** (`suite/qrels.hal.jsonl` does not exist — judging pass 1 has not produced it). Primary gold = **authored**; every judged-gold line below says `qrels absent`.

### Primary endpoints (gatekeeping order)

- **(1) K-safety** Δhit@5(on−off), oracle chunk · gold=authored (suite oracle; needs no judging): mean n/a · one-sided 95% lower n/a vs −δ=-0.02 → **not estimable** · worse/same/better 0/0/0 · sign p=1.0000 · cluster=document · n=0 usable=0
- **(2) latency-SLO** (gold=n/a — latency is gold-independent) warm p95 ms ≤ 1000 → **PASS** · channels vector=13 · fts=2 · graph-seed=0 · graph-n1=1 · graph-n2=1 · graph-vec=2 · final off/on=n/a/n/a · fixedpool_rerank=n/a · cold p95=n/a (recorded, not gated) · rrf2/rrf3/rrf3-n2 are fused in-process and carry no ms (excluded) · measured under light concurrent load, **this run only** · n=116 usable=115 (first row dropped: process warm-up)
- **(3) candidate** Δrecall@30(doc) rrf3−rrf2, A+M · gold=authored **[primary]**: mean 0.047 · 95% CI [0.014, 0.087] · MCID 0.05 · worse/same/better 0/54/6 · sign p=0.0313 · cluster=family · n=60 usable=60
- **(4) semantics** graph-n1 recall@30(doc) real vs degree-preserving shuffle null, A+M · gold=authored **[primary]**: real 0.599 · null mean n/a (R=0/20) · Δ n/a vs MCID 0.03 · p_null 0/0=n/a vs ≤0.05 → **not estimable** · resolution floor 1/1=n/a, add-one estimate n/a (Holm below uses the add-one value — a permutation p is never exactly 0) · n=60 usable=60
- **(5) rerank** ΔnDCG@10 fixed-pool(with_graph−base), A+M, pool = product base@30 · gold=authored **[primary]**: mean n/a · 95% CI n/a · MCID 0.05 · worse/same/better 0/0/0 · sign p=n/a · cluster=family · n=0 usable=0 · authored gold is binary (gain 1), so this nDCG is a binary-relevance nDCG
- judged-gold block · gold=judged: **qrels absent** — `suite/qrels.hal.jsonl` not written yet; no judged numbers are shown or imputed · n=0 usable=0

- **Holm** over the pre-declared efficacy family (m=3, family size held at 3 even when an endpoint is not estimable — those enter as p=1, which is conservative) · gold=authored: candidate p=0.0313→0.0938 · semantics p=not estimable→1.0000 · rerank p=not estimable→1.0000 · n=3 usable=1

### Exploratory (descriptive — never a gate, never a power input)

- recall@K(doc) by channel, A+M · gold=authored · @100 is exploratory only (never a gate or a power input): vector=0.75/0.86/0.98 · fts=0.67/0.88/0.96 · graph-seed=0.69/0.83/0.88 · graph-n1=0.44/0.60/0.80 · graph-n2=0.17/0.34/0.54 · graph-vec=0.59/0.77/0.81 · rrf2=0.84/0.92/0.99 · rrf3=0.86/0.97/0.99 · rrf3-n2=0.80/0.97/0.99 · n=60 usable=60
- recall@K over the **unique-document budget** (docK lists = first K distinct documents), A+M · gold=authored: vector=0.82/0.96 · fts=0.78/0.95 · graph-seed=0.81/0.88 · graph-n1=0.54/0.76 · graph-n2=0.28/0.51 · graph-vec=0.66/0.79 · rrf2=0.89/0.98 · rrf3=0.92/0.99 · rrf3-n2=0.91/0.98 · n=60 usable=60
- MRR(doc, over chunk100) and hit@10(doc, ≥1 gold document inside the top-10 chunks) by channel, A+M · gold=authored: vector=0.64/0.97 · fts=0.66/0.87 · graph-seed=0.49/0.87 · graph-n1=0.29/0.65 · graph-n2=0.20/0.28 · graph-vec=0.53/0.80 · rrf2=0.80/0.97 · rrf3=0.68/0.98 · rrf3-n2=0.57/0.97 · n=60 usable=60
- K known-item hit@1/@5/@10 (oracle chunk, product final) · gold=authored: off=n/a/n/a/n/a · on=n/a/n/a/n/a · n=0 usable=0
- pure-vector channel: `out/purevec.hal.jsonl` not present — not run · gold=authored (nothing to score) · n=0 usable=0
- alternative control families for graph-n1 recall@30(doc), A+M · gold=authored: real 0.599 · type-preserving swap null n/a (R=0/5) · same-|E| random null n/a (R=0/1) · the pre-registered null for endpoint (4) is the degree-preserving shuffle; these two are the direction/type axis (D6 b/c) and are descriptive only · n=60 usable=60
- seam status distribution (gold=n/a — run diagnostics, not a retrieval metric): vector=116 · mean seeds 10.00 · mean 1-hop connected 28.20 · mean 2-hop entities 63.14 · mean reach chunks 144.40 / docs 50.85 · **reachable-set recall (`graph-reach`, D4) is not computable from these outputs** — the runner recorded the reach set SIZES, not the set, so no recall can be derived without re-running · n=116 usable=116
- upstream gates · gold=authored: `out/upstream.hal.jsonl` absent — **upstream not run** · n=0 usable=0
- link precision · gold=link-audit judge (a separate mention judgement, not qrels): name 0.9886363636363636 (n=88) vs ≥0.6 · nonliteral 0.22933884297520662 (n=484) · weighted 0.4751 CI [0.398,0.5495] · n=572 usable=60 chunk clusters

## Corpus-stratified macro (mean of corpus means — no naive pooling)

- candidate Δrecall@30(doc) macro 0.044 · rerank ΔnDCG@10 macro n/a · gold=per-corpus primary (hub:authored hal:authored) · n=2 usable=2 corpora
- K-safety per corpus hub:not estimable hal:not estimable · latency-SLO hub:PASS hal:PASS · semantics PASS 0/2 — **per-corpus and unadjusted** (gate (4) is Δ ≥ MCID 0.03 and the raw `p_null` ≤ 0.05); the same endpoint **Holm-adjusted** is 1.0000–1.0000 and never clears 0.05. That is a **resolution limit of R, not a failed endpoint**: with R=20 replicates the add-one floor is 1/21=0.0476, already above Holm's first step α/m=0.0167, so at this R the semantics endpoint can never be the family's first rejection and could only clear 0.05 in the last step (i.e. only if the other two are rejected first). Resolution is bought by raising R (a FREEZE.md threshold change), not by raising holdout N — see `suite/POWER.md` · gold=per-corpus primary · n=2 usable=2
- Stage 2 branch inputs (counts only — the branch is decided on holdout): candidate point ≥ MCID 0.05 in 0/2 corpora, unadjusted CI lower > 0 in 1/2 · rerank point ≥ MCID 0.05 in 0/2, CI lower > 0 in 0/2 · gold=per-corpus primary · n=2 usable=2

## Reading this report

- Gatekeeping order is **K-safety → latency-SLO → candidate → semantics → rerank**. The five branch conditions (upstream-first / candidate-generation+RRF / gated-rerank / remove-from-ranking / inconclusive→expand-evaluation) are applied by `run-decision.mjs` on **holdout**, not here. Stage 1 supplies variance for `suite/POWER.md`.
- Holm is applied over the three efficacy endpoints (candidate · semantics · rerank) with the family size pre-declared at 3.
- `n=` is the rows the endpoint was eligible for; `usable=` is the rows the metric could actually be computed on (gold present, and — on judged gold — judged deeply enough).
- Anything under **Exploratory** is descriptive only: it is not a gate, is not Holm-adjusted, and must not be quoted as an outcome.
- `remove-from-ranking` needs futility evidence and `decision-grade` qrels; with `LLM-judged provisional` or absent qrels it is unavailable by construction (proposal D10).
