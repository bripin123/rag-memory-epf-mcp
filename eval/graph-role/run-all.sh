#!/usr/bin/env bash
# Serial driver for the graph-role evaluation runners: every corpus x every condition, dev split.
# NEVER parallel — one measuring process at a time (README: "One measuring process at a time").
# Conditions per corpus: real + shuffled-r0..19 + typeshuf-r0..4 + random = 27.
# Per-step stdout+stderr goes to eval/graph-role/out/log.<runner>.<corpus>.<cond>.txt; the
# "EXIT:<code>" line after each step is the only thing on this script's stdout, so a caller can
# grep for a non-zero exit without reading the logs. Exit codes: see eval/graph-role/README.md.
cd "$(cd "$(dirname "$0")/../.." && pwd)" || exit 1
mkdir -p eval/graph-role/out
echo "START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
for c in hub uap hal; do for cond in real $(seq -f "shuffled-r%g" 0 19) $(seq -f "typeshuf-r%g" 0 4) random; do
  node eval/graph-role/run-candidates.mjs --corpus $c --cond $cond --split dev > eval/graph-role/out/log.candidates.$c.$cond.txt 2>&1; echo "candidates $c $cond EXIT:$?"
  node eval/graph-role/run-final.mjs      --corpus $c --cond $cond --split dev > eval/graph-role/out/log.final.$c.$cond.txt 2>&1; echo "final $c $cond EXIT:$?"
done; done
echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ)"
