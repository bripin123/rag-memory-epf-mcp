# Judging protocol (frozen with qrels)
- Unit judged: chunk (with title + adjacent chunks shown). Document grade = max over its judged chunks.
- Scale: 0 = not relevant to the question · 1 = partially relevant (touches the topic/relationship but does not answer it) · 2 = relevant (a reader exploring this question would want this passage).
- Blind: judges see jid, query text, class (K/A/M), doc title, chunk text, previous+next chunk text. They never see channel, condition, scores, or other judges' output.
- Judge A = Claude (fresh subagent per corpus; record model id in the output file header) · Judge B = codex (record model id) · Adjudicator C = a fresh context that sees the query, the chunk, and both grades+rationales, and outputs a final grade. temperature 0 where the API allows.
- Input order: `pool/<c>.judge.jsonl` is shuffled with seed 20260817 + corpus index; judges process in file order.
- Gate: quadratic weighted kappa (A vs B) per corpus and per class >= 0.67 (thresholds.json kappa_gate_weighted). Below the gate: revise the rubric examples in this file, re-run BOTH judges on the whole corpus, discard the earlier outputs (keep them in pool/rejected/).
- Adjudication: every A/B disagreement goes to C. Human adjudication replaces C when the user has time.
- Human audit: `suite/human-audit.<c>.jsonl` = 50 pairs per corpus, stratified by class x final grade, including agreed items. Disagreement rate <= 20% -> qrels are `decision-grade`; otherwise or if absent -> `LLM-judged provisional` (no `remove-from-ranking` decision may be issued on provisional qrels).
- Prompt (identical for A and B): "You judge relevance for a retrieval evaluation. For each item output JSON {jid, grade, rationale<=25 words}. Grade 2 if a reader exploring the QUESTION would want this PASSAGE, 1 if it only touches the topic, 0 otherwise. Judge the passage as it stands; do not reward length or link count."
