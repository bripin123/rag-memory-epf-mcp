# 3-arm search-quality release gate (spec §8.3)

**Not part of `verify:engine`** — needs the real embedding model and the hub's private
frozen dataset. Mandatory before any v14+ release (plan Task 10).

## Run

```
cd rag-memory-epf-mcp && npm run build
RG_DIR=<hub>/raw/next-p/three-arm node test/release-gate/three-arm.mjs > /tmp/v14-3arm.log 2>&1; echo "EXIT:$?"
```

`RG_DIR` must contain the frozen artifacts (created by plan Task 1, integrity forced via
`shasum -c FROZEN.sha256` on start): `old.db`, `baseline-old.json`, `probes-selfretrieval.json`,
`probes-knownitem.json`, `cohort.json`.

## What it does

- old-arm: links/boost baselines from a copy of the frozen `old.db`.
- coldreplay: representative top-insert edit on `wiki-gotchas`, twice — reports cold vs
  steady `reusedChunks` (release-note honesty numbers).
- mixed arm (cohort-converted) and full arm (all docs converted): built via public tools
  (`chunkDocument` + `embedChunks`), each waiting for model-ready AND reconciliation
  `complete|n/a` before measuring (eligibility = both, `backfillCoordinator.ts:72`).
- synthetic boundary control runs on a CLONE of each arm so quality metrics measure an
  uncontaminated corpus (r7-3).
- Verdicts per arm: eligibility, selfRetrieval (hit-rate drop >3pp or paired sign-test
  p<0.05), knownItem (zero regressions), linkRecall (distinct entity|doc tuples ⊇ old),
  multiplicity (INFO), boostControl (graph boost changes top-5 in BOTH old and arm),
  synthetic (cut name still linked — requires the range-linking fix), coverage,
  invariants, divergence=DEFER.
- `three-arm-report.json` gets the full numbers; `divergence` holds the bottom-10%
  Jaccard probes for the reserved advisor judgment. Exit ≠ 0 on any FAIL → no release.

Expected duration: full arm re-embeds all 125 documents (~22 min measured) + ~390
probes × 3 measurement passes.
