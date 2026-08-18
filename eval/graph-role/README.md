# graph-role evaluation harness

Runs ONLY on `.backup` copies (`dbs/`, gitignored). Summaries are forced off. One measuring process at a time.
Order: snapshot → suite freeze → controls → run-candidates/run-final (all conditions) → pool → judging → qrel freeze → upstream → report → power.
Exit codes: 3 FROZEN_MISMATCH · 4 REFUSE_LIVE_DB · 5 SUITE_INVALID · 6 CONTROL_DEGREE_MISMATCH · 7 POOL_INCOMPLETE · 8 KAPPA_BELOW_GATE · 9 MODEL_NOT_READY · 10 SOURCE_MTIME_CHANGED · 11 JUDGE_INCOMPLETE · 12 ADJUDICATION_PENDING · 13 OUTLIERS_PRESENT · 14 MANIFEST_INCOMPLETE.

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
4. `node eval/graph-role/make-manifest.mjs --gzip --reruns <path-to-the-JSON-array-from-step-2>`
   Writes `out/MANIFEST.json` (file · rows · bytes · sha256 for every raw file, plus the `reruns` record). `--gzip` first writes `<name>.gz` for every `final.*.jsonl` and `purevec.*.jsonl` (candidates are skipped) via a deterministic gzip — the header's MTIME/OS bytes are zeroed so the archive is byte-stable across machines and times — then the manifest lists those `.gz` files too. Exit 0 when 165/165 raw files are present, the driver log has an `END` line, and no driver step exited nonzero; otherwise exit 14 (`MANIFEST_INCOMPLETE`), unless `--allow-incomplete` (then exit 0 with `complete: false` left in the file).
5. `git add eval/graph-role/out/MANIFEST.json eval/graph-role/out/*.jsonl.gz` and commit.
   Raw `out/*.jsonl` and `out/log.*.txt` stay git-ignored (candidates ≈ 7.8 MB/file × 81 files) — R12 amendment: they're re-derivable from the frozen suites + snapshot provenance + these deterministic runners, and `MANIFEST.json`'s per-file sha256 is what makes that re-derivation checkable.
