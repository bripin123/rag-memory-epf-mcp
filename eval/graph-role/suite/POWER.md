# POWER — holdout N from Stage 1 pilot variance

**Freeze this file (and `thresholds.json`) into `suite/FREEZE.md` before the holdout is opened** (spec R9). Stage 1 is a pilot for variance, not for conclusions; nothing in this file is an outcome.

Target power 0.8 · alpha 0.05 (two-sided) · MCID candidate Δrecall@30(doc) 0.05 · MCID rerank ΔnDCG@10 0.05 · K non-inferiority δ(hit@5) 0.02 · judging budget 8000 judgements/corpus.

Sample size uses the paired normal (t) approximation `N = ceil(((z_{1-α/2} + z_{power}) · SD_Δ / MCID)^2)`, where `SD_Δ` is the **pilot SD of the per-query paired difference** measured below. Two caveats carried into every row:

- The **cluster** for inference is the family (K: the document). The SD below is the plain per-query SD, so N is **anticonservative** wherever within-family correlation is positive; the clustered interval lives in `out/report.md`. The `families` column is the effective unit count for the clustered analysis.
- Δ for K-safety and for a binary-gold recall is a **bounded discrete** variable (values in {−1, 0, +1} for hit@5), so the normal approximation is rough at small N. Discordance (the share of non-zero Δ) is printed next to the SD because for a discrete paired endpoint it is the more honest driver of power.

| corpus | gold | endpoint | pilot n | usable | families | paired SD | discordance | mean Δ | N (power 0.8) | note |
|---|---|---|---|---|---|---|---|---|---|---|
| hub | authored | candidate Δrecall@30(doc) rrf3−rrf2 | 60 | 60 | 53 | 0.159 | 0.10 | 0.000 | 80 |  |
| hub | authored | rerank ΔnDCG@10 fixed-pool | 60 | 60 | 53 | 0.150 | 0.42 | 0.015 | 71 | authored gold is binary (gain 1) |
| hub | authored (oracle) | K Δhit@5 non-inferiority | 53 | 53 | 53 | 0.463 | 0.30 | -0.302 | 4215 | two-sided z; the pre-registered test is **one-sided** vs −δ=0.02, which needs 3321. Frozen K holdout = 30. Needs no judging budget. |
| uap | authored | candidate Δrecall@30(doc) rrf3−rrf2 | 60 | 60 | 54 | 0.206 | 0.12 | 0.000 | 134 |  |
| uap | authored | rerank ΔnDCG@10 fixed-pool | 60 | 60 | 54 | 0.075 | 0.25 | 0.015 | 18 | authored gold is binary (gain 1) |
| uap | authored (oracle) | K Δhit@5 non-inferiority | 54 | 54 | 54 | 0.461 | 0.30 | -0.296 | 4169 | two-sided z; the pre-registered test is **one-sided** vs −δ=0.02, which needs 3284. Frozen K holdout = 30. Needs no judging budget. |
| hal | authored | candidate Δrecall@30(doc) rrf3−rrf2 | 60 | 60 | 56 | 0.139 | 0.08 | 0.042 | 61 |  |
| hal | authored | rerank ΔnDCG@10 fixed-pool | 60 | 60 | 56 | 0.180 | 0.55 | 0.035 | 102 | authored gold is binary (gain 1) |
| hal | authored (oracle) | K Δhit@5 non-inferiority | 56 | 56 | 56 | 0.401 | 0.20 | -0.196 | 3154 | two-sided z; the pre-registered test is **one-sided** vs −δ=0.02, which needs 2485. Frozen K holdout = 26. Needs no judging budget. |

## Judging budget check

Budget = 8000 judgements per corpus (`thresholds.json`). The per-query cost below is **re-derived from `out/`**, not read from `pool/` (judging is in flight and that directory is not touched): it reproduces pool.mjs's pass-1 `top10` tier — A+M rows only, union over {real, shuffled-r0, random} × 9 channels' `chunk10`, plus final off/on/fixed-pool top-10, plus the pure-vector channels. It is a slight **upper bound**: pool.mjs additionally drops chunk ids with no `chunk_metadata` row.

| corpus | pilot A+M queries pooled | pass-1 judgements | judgements/query | max holdout A+M queries within budget |
|---|---|---|---|---|
| hub | 60 | 4135 | 68.92 | 116 |
| uap | 60 | 4189 | 69.82 | 114 |
| hal | 60 | 4295 | 71.58 | 111 |

| corpus | gold | endpoint | N needed | within budget? |
|---|---|---|---|---|
| hub | authored | candidate | 80 | yes (80 ≤ 116) |
| hub | authored | rerank | 71 | yes (71 ≤ 116) |
| hub | authored (oracle) | K Δhit@5 | 3321 (one-sided) | consumes **no judging budget**, but the frozen K holdout is 30 — **3321 ≫ 30**: a *demonstration of non-inferiority* at δ=0.02 is out of reach at this suite size (see the note below) |
| uap | authored | candidate | 134 | **no (134 > 114)** → pre-declare this endpoint `inconclusive` at the frozen budget |
| uap | authored | rerank | 18 | yes (18 ≤ 114) |
| uap | authored (oracle) | K Δhit@5 | 3284 (one-sided) | consumes **no judging budget**, but the frozen K holdout is 30 — **3284 ≫ 30**: a *demonstration of non-inferiority* at δ=0.02 is out of reach at this suite size (see the note below) |
| hal | authored | candidate | 61 | yes (61 ≤ 111) |
| hal | authored | rerank | 102 | yes (102 ≤ 111) |
| hal | authored (oracle) | K Δhit@5 | 2485 (one-sided) | consumes **no judging budget**, but the frozen K holdout is 26 — **2485 ≫ 26**: a *demonstration of non-inferiority* at δ=0.02 is out of reach at this suite size (see the note below) |

## What the K sample size does and does not mean

The K row's N is the size needed to **demonstrate non-inferiority** — to show the one-sided lower bound clears −δ — when the true difference is 0. A margin of δ = 0.02 against the measured SD is why it lands in the thousands, while the frozen K holdout is hub 30 · uap 30 · hal 26. **Proving** K-safety at this margin is out of reach at this suite size; that limit is recorded here rather than worked around.

**Detecting harm is a different question and needs far less.** The Stage 1 pilot already answers it: hub mean Δ -0.302, worse/same/better 16/37/0, one-sided 95% lower -0.415 vs −δ -0.02, n=53 · uap mean Δ -0.296, worse/same/better 16/38/0, one-sided 95% lower -0.407 vs −δ -0.02, n=54 · hal mean Δ -0.196, worse/same/better 11/45/0, one-sided 95% lower -0.286 vs −δ -0.02, n=56. Every corpus **FAILs** K-safety in `out/report.md` at these sizes. A gate can fail on far fewer queries than it needs to pass.

## The semantics endpoint is not in the table above, and that is not an omission

Endpoint (4) compares real recall@30 against a null built from **R = 20 degree-preserving replicates**, so its precision is set by R, not by query N. With R = 20 the smallest attainable `p_null` is 0 (b/R) and the add-one estimate is 0.0476 — just under the frozen `p_null_max` 0.05. At R = 19 the add-one floor is exactly 0.05 and the endpoint could never clear a strict "< 0.05". **Increasing holdout query N does not buy resolution here; increasing R does.** Any Stage 2 change to R is a threshold change and belongs in FREEZE.md.

## Rule (pre-declared)

- Holdout A+M size per corpus = **max over the efficacy endpoints of N**, capped by the judging budget. Where the cap binds, that endpoint is pre-declared `inconclusive` rather than run underpowered (proposal D3/D8, branch ⑤).
- K holdout = the rows already generated in the frozen suite (document-split, no judging needed): hub 30 · uap 30 · hal 26.
- Where an endpoint is marked **not estimable** above, no N is extrapolated. It becomes estimable only when the missing input arrives (qrels at the needed depth), and this file must be regenerated and re-frozen before holdout.
- Numbers here are Stage 1 **dev pilot** values under `SUMMARIES=off` on `.backup` copies. They size Stage 2; they do not decide anything.
