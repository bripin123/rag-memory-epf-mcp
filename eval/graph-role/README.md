# graph-role evaluation harness

Runs ONLY on `.backup` copies (`dbs/`, gitignored). Summaries are forced off. One measuring process at a time.
Order: snapshot → suite freeze → controls → run-candidates/run-final (all conditions) → pool → judging → qrel freeze → upstream → report → power.
Exit codes: 3 FROZEN_MISMATCH · 4 REFUSE_LIVE_DB · 5 SUITE_INVALID · 6 CONTROL_DEGREE_MISMATCH · 7 POOL_INCOMPLETE · 8 KAPPA_BELOW_GATE · 9 MODEL_NOT_READY · 10 SOURCE_MTIME_CHANGED · 11 JUDGE_INCOMPLETE · 12 ADJUDICATION_PENDING.
