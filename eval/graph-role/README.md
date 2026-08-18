# graph-role evaluation harness

Runs ONLY on `.backup` copies (`dbs/`, gitignored). Summaries are forced off. One measuring process at a time.
Order: snapshot → suite freeze → controls → run-candidates/run-final (all conditions) → pool → judging → qrel freeze → upstream → link-audit (sample → judge-A/judge-B → merge) → report → power.
Exit codes: 3 FROZEN_MISMATCH · 4 REFUSE_LIVE_DB · 5 SUITE_INVALID · 6 CONTROL_DEGREE_MISMATCH · 7 POOL_INCOMPLETE · 8 KAPPA_BELOW_GATE · 9 MODEL_NOT_READY · 10 SOURCE_MTIME_CHANGED · 11 JUDGE_INCOMPLETE · 12 ADJUDICATION_PENDING · 13 OUTLIERS_PRESENT · 14 MANIFEST_INCOMPLETE · 15 LINK_AUDIT_INPUT_MISSING (link-audit-merge.mjs: a required input file -- the sample, the prevalence file, or the judge-A verdicts -- does not exist yet, or judge-A shares no jids with the sample) · 16 REPORT_LINE_MISSING_DENOMINATOR (report.mjs emitted a metric line without `n=`, `usable=` or `gold=` -- spec R8's denominator rule plus the gold-source rule, enforced in code rather than by habit) · 17 REPORT_INPUT_MISSING (report.mjs/power.mjs: no corpus had both `suite/queries.<c>.jsonl` and `out/candidates.<c>.real.jsonl`).

Channel labels: `vector` (in `candidates.*.jsonl`) = product base ranking (no graph) — `hybridSearch(q, K, false)` = vector ∨ FTS-boost, not pure vector (its `rrf2`/`rrf3` therefore fold FTS twice). `purevec` (in `purevec.*.jsonl`, Task 5b) = pure vector — a raw chunk vector scan on the query embedding (k=100), independent of the product ranking path and of the graph seam.

## Post-run packaging (Task 5b)

Once the driver's `END` line has landed in `out/run-all.log`, the controller runs, in order:

1. `node eval/graph-role/scan-outliers.mjs`
   Exit 0 = no sleep-polluted rows found, skip to step 3. Exit 13 (`OUTLIERS_PRESENT`) = read the `PAIR <corpus> <cond>` / `PUREVEC <corpus>` lines it printed and continue to step 2.
2. For each `PAIR <corpus> <cond>` line, re-run whichever of `run-candidates.mjs`/`run-final.mjs` produced the flagged file — one process at a time, never both together (one measuring process at a time):
   `node eval/graph-role/run-candidates.mjs --corpus <corpus> --cond <cond> --split dev`
   `node eval/graph-role/run-final.mjs --corpus <corpus> --cond <cond> --split dev`
   Record each rerun in a JSON array (shape `{ corpus, cond, runner, reason, rerun_at }`, e.g. `reason: "sleep outlier ms>30000"`) for step 4's `--reruns`.
3. `node eval/graph-role/run-purevec.mjs --corpus hub`
   `node eval/graph-role/run-purevec.mjs --corpus uap`
   `node eval/graph-role/run-purevec.mjs --corpus hal`
   (one at a time; real copy only — the channel is graph-independent, so there is no `--cond`.)
4. `node eval/graph-role/make-manifest.mjs --gzip` — add `--reruns <path-to-the-JSON-array-from-step-2>` only if step 2 actually ran (no outliers in step 1 means no reruns file to pass; `--reruns` defaults to an empty array).
   Writes `out/MANIFEST.json` (file · rows · bytes · sha256 for every raw file, plus the `reruns` record). `--gzip` first writes `<name>.gz` for every `final.*.jsonl` and `purevec.*.jsonl` (candidates are skipped) via a deterministic gzip — the header's MTIME/OS bytes are zeroed so the archive is byte-stable across machines and times — then the manifest lists those `.gz` files too. Exit 0 when 165/165 raw files are present, the driver log has an `END` line, and no driver step exited nonzero; otherwise exit 14 (`MANIFEST_INCOMPLETE`), unless `--allow-incomplete` (then exit 0 with `complete: false` left in the file).
5. `git add eval/graph-role/out/MANIFEST.json eval/graph-role/out/*.jsonl.gz` and commit.
   Raw `out/*.jsonl` and `out/log.*.txt` stay git-ignored (candidates ≈ 7.8 MB/file × 81 files) — R12 amendment: they're re-derivable from the frozen suites + snapshot provenance + these deterministic runners, and `MANIFEST.json`'s per-file sha256 is what makes that re-derivation checkable.

## Reporting (Task 8)

Both scripts read `suite/` and `out/` only -- no DB is opened, no engine is loaded, and nothing under `pool/` is touched, so they are safe to run while judging is in flight. Neither takes arguments.

```
node eval/graph-role/report.mjs    # -> out/report.md   (also printed to stdout)
node eval/graph-role/power.mjs     # -> suite/POWER.md  (also printed to stdout)
```

`report.mjs` prints the five primary endpoints in gatekeeping order (K-safety -> latency-SLO -> candidate -> semantics -> rerank), applies Holm over the three efficacy endpoints with the family size pre-declared at 3, adds a corpus-stratified macro, and marks everything else `exploratory`. Every metric line carries `n=`, `usable=` and the gold source it used; a line that fails that check aborts the run with exit 16 (this fired for real during development, so the check is not vacuous).

**Two gold sources, both reported whenever computable.** `authored` = the suite's own gold (K `document_id`/`oracle_chunk_id`, A `source_docs`, M `source_docs` + `family`) -- it needs no judging, exists for every corpus, and is not truncated by pool depth, but it is binary (gold = 1). `judged` = qrels, document grade = max over that document's judged chunks. The primary endpoints use `judged` where `suite/qrels.<c>.jsonl` exists and `authored` otherwise; with no qrels the judged block prints `qrels absent` rather than zeros.

**What pass-1 judging depth allows.** Pass 1 judged a fixed-depth-10 pool, so on judged gold nDCG@10 and hit@k (k <= 10) are estimable for every judged query, `recall@30(doc)` only for queries carrying `judged_depth: 30`, and recall@100 is exploratory only (never a headline, a power input, or a decision input). On authored gold none of those depth limits apply.

Both scripts also run before `run-upstream.mjs`/`link-audit-merge.mjs` have produced anything -- the corresponding lines then say `upstream not run` / `link audit not merged`.

`power.mjs` turns the pilot SD of each paired endpoint into a holdout N at power 0.8, checks it against the frozen judging budget (per-query judging cost re-derived from `out/`, not read from `pool/`), and says `not estimable` instead of extrapolating where an input is missing. **`suite/POWER.md` and `thresholds.json` must be hashed into `suite/FREEZE.md` before the holdout is opened (R9)** -- writing the file is not freezing it.
