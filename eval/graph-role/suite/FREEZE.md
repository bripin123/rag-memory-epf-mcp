# FREEZE — suites/thresholds are hashed here BEFORE any run

| file | sha256 | frozen_at | commit |
|---|---|---|---|
| `queries.hub.jsonl` | `130e4162664d4458662df765485ff030b244bc3df05248e541d1b8e834ad0b0c` | 2026-08-17 21:50:33 UTC | (fill after commit) |
| `queries.uap.jsonl` | `d324401ab2c1c6cf7dc8fce5f2dc831b56f4710dd7e3f69c201e626998fae608` | 2026-08-17 21:50:33 UTC | (fill after commit) |
| `queries.hal.jsonl` | `35ddaec9e75e7e8ec62c570f43f7312d420710b81144c5bbb1a2ac31190c294d` | 2026-08-17 21:50:33 UTC | (fill after commit) |
| `../thresholds.json` | `bdf93c3ac546014685d8a8d387202bbb20172730c43193f2860d5d49201bde09` | 2026-08-17 21:50:33 UTC | (fill after commit) |

## Notes — Stage 1 pilot suite (known limitations recorded before freeze)

1. All hops carry `type`/`direction` = "any" (180/180 M hops + 9 A-row hops): the source texts never state a typed/directed relation, so edge-validity gold has no type/direction signal in Stage 1.
2. C's role differs by corpus: hub/uap ask for the entity C; hal asks "which document" (30/30), so C is a witness entity inside the target document. Grading is document-level (doc2 = target), so both are consistent under document qrels; a rule of the form "correct iff the answer names C" would not be.
3. Templated phrasing: uap 28/30 M use an em-dash pivot " — " and 21/30 "회차", 18/30 end "어디인가?"; hal 29/30 "따라가면", 30/30 end "…에 이르나/닿나?"; hub varied (max marker 2/30).
4. hal role-document targets: 6/30 M rows (hal-M-14, M-15, M-22, M-23, M-27, M-29) target current-focus / core-decisions / wiki-project-context / spec-codebase-reference — no alternative bridge existed.
5. Bridge concentration: uap Motaded×4, CICOT×3, SASO×2; hub skills-guide.md×3; hal kmfhc_checklist.py×3.
6. Target-identifying token carried by the bridge's own entity name (unremovable without dropping the bridge): hub-M-25 (`ax-line-2026-08-05.md` → target log-2026-08-05), hal-M-26 ("upgrade").
7. hub-M-1: A (`Template Enhancement`) appears in doc1 only inside a longer token (A-side, does not affect the target).
8. Three A rows carry one `expected_entity` that is a surface variant absent as an exact string from the cited docs: hub-A-12 (`Antigravity CLI`), hub-A-20 (`current-focus.md`), hal-A-7 (`Phase 4 Validation`).
9. K dev = 30 stride/fill-sampled + N pinned M-target documents (hub N=23, uap N=24, hal N=26); K holdout = 30 non-pinned for hub and uap. hal holdout = 26 non-pinned (short of the 30 cap): after pinning 26 M-target documents to dev, the exhaustive fill pass (every eligible row scanned) found only 26 non-pinned holdout-parity documents left in the hal corpus — a corpus-size ceiling, not an authoring or validation error (`freeze.mjs --validate` has no per-split minimum-count check, and none of the three files reference an undersized split). `dev-docs.<c>.txt` lists the pins (one document id per line, sorted) for each corpus.
