import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rrf, cutK, cutUniqueDoc } from '../eval/graph-role/lib/rrf.mjs';
import { mulberry32, shuffle } from '../eval/graph-role/lib/prng.mjs';
import { validateSuite, sha256File, readFreeze } from '../eval/graph-role/lib/freeze.mjs';
import { LIVE_PATHS } from '../eval/graph-role/lib/paths.mjs';

// rrf: deterministic fusion + tie-break by id
{
  const f = rrf([['a', 'b', 'c'], ['b', 'a', 'd']]);
  assert.deepEqual(f.map(x => x.id).slice(0, 2), ['a', 'b']);
  assert.equal(cutK(f, 2).length, 2);
  const uniq = cutUniqueDoc([{ id: 'x1' }, { id: 'x2' }, { id: 'y1' }], 2, id => id[0]);
  assert.deepEqual(uniq.map(u => u.id), ['x1', 'y1']);
  console.log('  OK: rrf/cutK/cutUniqueDoc');
}
// prng: seeded, reproducible
{ const a = shuffle([1, 2, 3, 4, 5], mulberry32(7)), b = shuffle([1, 2, 3, 4, 5], mulberry32(7)); assert.deepEqual(a, b); console.log('  OK: mulberry32 reproducible'); }
// validateSuite: leakage + family + schema
{
  const ok = [{ id: 'k1', class: 'K', split: 'dev', family: 'doc1', text: 'known item query text', oracle_chunk_id: 'c1', document_id: 'doc1' },
              { id: 'a1', class: 'A', split: 'dev', family: 'fam1', text: 'what relates to X', expected_entities: ['X'], seed_candidates: ['X'], source_docs: ['d'], author_mode: 'source-grounded', expected_paths: [] }];
  assert.deepEqual(validateSuite(ok), []);
  const bad = ok.concat([{ id: 'k2', class: 'K', split: 'holdout', family: 'doc1', text: 'another query', oracle_chunk_id: 'c2', document_id: 'doc1' }]);
  const errs = validateSuite(bad);
  assert.ok(errs.some(e => /spans splits/.test(e)) && errs.some(e => /used twice/.test(e)));
  console.log('  OK: validateSuite catches leakage/family');
}
// freeze table parse + live paths present
{
  const d = mkdtempSync(join(tmpdir(), 'gr-'));
  writeFileSync(join(d, 'x.jsonl'), 'a\n');
  const h = sha256File(join(d, 'x.jsonl'));
  writeFileSync(join(d, 'FREEZE.md'), `| file | sha256 | at |\n|---|---|---|\n| \`x.jsonl\` | ${h} | now |\n`);
  assert.equal(readFreeze(d).get('x.jsonl'), h);
  rmSync(d, { recursive: true, force: true });
  assert.equal(LIVE_PATHS.size, 3);
  console.log('  OK: readFreeze parses table; 3 live paths registered');
}
// controls: node-level (in,out) degree preserved exactly; no self-loops; no duplicates; type-preserving keeps per-type degrees
{
  const { degreePreservingSwap, degreeSignature, sameSignature, erdosRenyi } = await import('../eval/graph-role/lib/controls.mjs');
  const mk = (i, s, t, ty) => ({ id: `e${i}`, source: s, target: t, type: ty, confidence: 1, metadata: '{}', created_at: 'x' });
  const edges = [mk(1,'a','b','R'), mk(2,'a','c','R'), mk(3,'b','c','S'), mk(4,'c','d','S'), mk(5,'d','a','R'), mk(6,'b','d','R'), mk(7,'e','a','S'), mk(8,'e','b','R')];
  const { edges: sh, swaps } = degreePreservingSwap(edges, { seed: 1, passes: 20 });
  assert.ok(sameSignature(degreeSignature(edges), degreeSignature(sh)), 'node-level (in,out) must be identical');
  assert.ok(sh.every(e => e.source !== e.target), 'no self-loops');
  assert.equal(new Set(sh.map(e => `${e.source}>${e.target}`)).size, sh.length, 'no duplicate directed edges');
  assert.ok(swaps > 0 && JSON.stringify(sh) !== JSON.stringify(edges), 'graph actually changed');
  const { edges: ts } = degreePreservingSwap(edges, { seed: 2, passes: 20, typePreserving: true });
  const byType = (es) => { const m = new Map(); for (const e of es) { const k = e.type; const sig = m.get(k) || new Map(); const s = sig.get(e.source) || [0,0]; s[1]++; sig.set(e.source, s); const t = sig.get(e.target) || [0,0]; t[0]++; sig.set(e.target, t); m.set(k, sig); } return m; };
  for (const [ty, sig] of byType(edges)) assert.ok(sameSignature(sig, byType(ts).get(ty)), `per-type degrees kept for ${ty}`);
  const er = erdosRenyi(edges, ['a','b','c','d','e'], 3);
  assert.equal(er.length, edges.length, 'ER keeps |E|');
  console.log('  OK: controls — degree-preserving swap (node-level), type-preserving, ER');
}
// stages: graph chunk ranking (pure) + chunk/document budgets — no DB, no model
{
  const { rankGraphChunks, applyBudgets } = await import('../eval/graph-role/lib/stages.mjs');
  // rankGraphChunks: chunk score = sum over distinct matched entities of entity score; tie -> chunk_id asc
  const linked = [ { chunk_id: 'c2', entity_id: 'B' }, { chunk_id: 'c1', entity_id: 'A' }, { chunk_id: 'c1', entity_id: 'B' }, { chunk_id: 'c1', entity_id: 'B' } ];
  const ranked = rankGraphChunks(linked, new Map([['A', 0.6], ['B', 0.3]]));
  assert.deepEqual(ranked.map(r => r.chunk_id), ['c1', 'c2']); assert.ok(Math.abs(ranked[0].score - 0.9) < 1e-9, 'B counted once for c1');
  const tie = rankGraphChunks([{ chunk_id: 'z', entity_id: 'A' }, { chunk_id: 'y', entity_id: 'A' }], new Map([['A', 1]]));
  assert.deepEqual(tie.map(r => r.chunk_id), ['y', 'z'], 'tie-break chunk_id asc');
  const b = applyBudgets(['d1_c1', 'd1_c2', 'd2_c1', 'd3_c1'], [2, 3], id => id.split('_')[0]);
  assert.deepEqual(b.chunk[2], ['d1_c1', 'd1_c2']); assert.deepEqual(b.doc[2].map(x => x.id ?? x), ['d1_c1', 'd2_c1']);
  console.log('  OK: stages — graph chunk ranking (dedup, tie-break) and chunk/doc budgets');
}
// metrics: quadratic weighted Cohen's kappa — perfect agreement -> 1, hand-computed disagreement case
{
  const { weightedKappa } = await import('../eval/graph-role/lib/metrics.mjs');
  assert.equal(weightedKappa([0,1,2,0,1,2], [0,1,2,0,1,2]), 1);
  // Hand-computed: O has diagonal 1s at (0,0)(1,1)(2,2) plus off-diagonal 1s at (0,1)(1,2)(2,0); both raters'
  // marginals are uniform [2,2,2] (n=6), so num=1.5, den=2, kappa=1-0.75=0.25 exactly (mod float rounding).
  // This is forced by the marginals alone: for any distance weight w(d) with w(0)=0, kappa=0.25 here regardless
  // of w's shape (linear/quadratic/other all verified to agree) — 0.0526 is not reachable for these vectors.
  assert.ok(Math.abs(weightedKappa([0,0,1,1,2,2], [0,1,1,2,2,0]) - 0.25) < 1e-9, 'quadratic weighted kappa hand-computed');
  console.log('  OK: weighted kappa');
}
// pooling: naturalCompare — "ascending qid order" must be natural (numeric within digit runs), not lexicographic.
// Real ids are `<corpus>-<class>-<n>` with unpadded n (hub-A-1..hub-A-53), where default string sort is wrong
// (would put hub-A-10 before hub-A-2). This case uses multi-digit ids that diverge under the two orderings.
{
  const { naturalCompare } = await import('../eval/graph-role/lib/pooling.mjs');
  assert.ok(naturalCompare('q-2', 'q-10') < 0, 'q-2 before q-10 under natural order (default string sort would reverse this)');
  assert.ok(naturalCompare('q-10', 'q-2') > 0);
  assert.equal(naturalCompare('q-1', 'q-1'), 0);
  assert.deepEqual(['q-2', 'q-10', 'q-1'].sort(naturalCompare), ['q-1', 'q-2', 'q-10'], 'natural sort ascending');
  assert.deepEqual(['q-2', 'q-10', 'q-1'].sort(), ['q-1', 'q-10', 'q-2'], 'default string sort puts q-10 before q-2 -- the bug naturalCompare fixes');
  console.log('  OK: naturalCompare — digit runs numeric, non-digit runs lexicographic');
}
// pooling: planPass2 — fixed-depth-10 pass 1 + predeclared, seeded, class-alternating (A/M) depth-30 subset for
// pass 2. Replaces the D2 saturation design (measured: top10 alone already exceeds budget on all 3 corpora;
// advisor: outcome-dependent extension has an unfixed-direction bias; fixed depth + predeclared stratified
// coverage is the standard alternative).
{
  const { planPass2 } = await import('../eval/graph-role/lib/pooling.mjs');
  // 8 candidates (4 A + 4 M) with varying top30 sizes (1..3); 2 top10 rows; budget 7 -> remaining after pass1 = 5,
  // enough to fit 4 of the 8 (13 total top30 rows). File order deliberately scrambled (not grouped by qid) to
  // prove pass2_jids follows judgeRows order, not selection order.
  const classOf = (qid) => qid[0] === 'a' ? 'A' : 'M';
  const top30Row = (qid, i) => ({ jid: `${qid}x${i}`, tier: 'top30', qid, class: classOf(qid) });
  const judgeRows = [
    top30Row('m-3', 1), { jid: 't1', tier: 'top10', qid: 'k1', class: 'A' }, top30Row('a-4', 1), top30Row('a-1', 1),
    top30Row('m-1', 1), top30Row('a-2', 1), top30Row('m-4', 1), { jid: 't2', tier: 'top10', qid: 'k2', class: 'A' },
    top30Row('a-4', 2), top30Row('m-2', 1), top30Row('a-3', 1), top30Row('m-1', 2),
    top30Row('a-2', 2), top30Row('m-4', 2), top30Row('a-4', 3),
  ];   // sizes: a-1=1 a-2=2 a-3=1 a-4=3 m-1=2 m-2=1 m-3=1 m-4=2 (13 top30 rows) + 2 top10 rows = 15
  assert.equal(judgeRows.filter(r => r.tier === 'top30').length, 13, 'fixture sanity: 13 top30 rows');

  const plan = planPass2({ judgeRows, budget: 7, seed: 42 });
  assert.equal(plan.pass1_rows, 2);
  assert.deepEqual(plan.selected, ['a-1', 'm-4', 'm-2', 'a-3'], 'balanced A/M alternation (seed 42): alternation order is a-1,m-4,a-4,m-2,a-2,m-1,a-3,m-3');
  assert.deepEqual(plan.skipped_budget, ['a-4', 'a-2', 'm-1', 'm-3'], 'skip-and-continue: a-4 (size 3) does not fit after a-1+m-4 consume 3 of 5 remaining, but the walk keeps trying later (smaller) queries rather than stopping');
  assert.deepEqual(plan.not_selected, plan.skipped_budget);
  assert.equal(plan.pass2_rows, 5);
  assert.equal(plan.remaining_after, 0, 'pass1(2) + pass2(5) == budget(7) exactly');
  assert.deepEqual(plan.pass2_jids, ['a-1x1', 'm-4x1', 'm-2x1', 'a-3x1', 'm-4x2'], 'pass2_jids in judgeRows file order, not selection order -- m-4s two jids land apart because other rows sit between them in the file');
  assert.deepEqual(plan.per_class.A, { selected: ['a-1', 'a-3'], candidates: ['a-1', 'a-2', 'a-3', 'a-4'] });
  assert.deepEqual(plan.per_class.M, { selected: ['m-4', 'm-2'], candidates: ['m-1', 'm-2', 'm-3', 'm-4'] });

  const again = planPass2({ judgeRows, budget: 7, seed: 42 });
  assert.deepEqual(again, plan, 'determinism: identical input + same seed -> identical output');
  const other = planPass2({ judgeRows, budget: 7, seed: 43 });
  assert.notDeepEqual(other.selected, plan.selected, 'different seed -> different pick order');
  console.log('  OK: planPass2 — balanced A/M alternation, budget skip-and-continue, determinism, file-order pass2_jids');
}
// judging: splitRows — batch sizes and zero-padded NNN naming (batches/<c>/<set>-NNN.jsonl)
{
  const { splitRows } = await import('../eval/graph-role/lib/judging.mjs');
  const rows = Array.from({ length: 7 }, (_, i) => ({ jid: `j${i + 1}` }));
  const b3 = splitRows(rows, 3);
  assert.equal(b3.length, 3);
  assert.deepEqual(b3.map(b => b.nnn), ['001', '002', '003']);
  assert.deepEqual(b3.map(b => b.rows.length), [3, 3, 1]);
  assert.deepEqual(b3[0].jids, ['j1', 'j2', 'j3']); assert.deepEqual(b3[2].jids, ['j7']);
  const many = Array.from({ length: 12 }, (_, i) => ({ jid: `k${i + 1}` }));
  const b1 = splitRows(many, 1);
  assert.equal(b1.length, 12);
  assert.deepEqual([b1[8].nnn, b1[9].nnn, b1[11].nnn], ['009', '010', '012'], 'zero-padding stays 3 digits past 9 batches');
  for (const bad of [0, -1, NaN, 2.5]) assert.throws(() => splitRows(rows, bad), /size must be an integer >= 1/, `size ${bad} must throw`);
  assert.equal(splitRows(rows, 1).length, 7, 'size 1 (the minimum) still works');
  console.log('  OK: splitRows — batch sizes, zero-padded NNN naming, size guard (integer >= 1)');
}
// judging: wordCount — whitespace-delimited word count for the 25-word rationale cap
{
  const { wordCount } = await import('../eval/graph-role/lib/judging.mjs');
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('   '), 0);
  assert.equal(wordCount('one'), 1);
  assert.equal(wordCount('one two three'), 3);
  assert.equal(wordCount('  extra   spaces   between  '), 3);
  console.log('  OK: wordCount — whitespace-delimited, trims, collapses runs');
}
// judging: validateBatch — each error class (missing meta, missing jid, foreign jid, dup jid, bad grade, long rationale)
{
  const { validateBatch } = await import('../eval/graph-role/lib/judging.mjs');
  const meta = { meta: true, judge: 'A', model: 'x', at: '2026-01-01T00:00:00Z' };
  const good = (jid, grade = 1) => ({ jid, grade, rationale: 'a short reason' });
  { const v = validateBatch(['j1', 'j2'], [meta, good('j1'), good('j2')]); assert.equal(v.ok, true); assert.deepEqual(v.errors, []); assert.deepEqual(v.meta, meta); assert.equal(v.rows.length, 2); }
  { const v = validateBatch(['j1'], [good('j1')]); assert.equal(v.ok, false); assert.ok(v.errors.some(e => /meta/.test(e)), 'missing meta: first line is a data row'); }
  { const v = validateBatch(['j1'], []); assert.equal(v.ok, false); assert.ok(v.errors.some(e => /meta/.test(e)), 'missing meta: empty batch'); }
  { const v = validateBatch(['j1', 'j2'], [meta, good('j1')]); assert.equal(v.ok, false); assert.ok(v.errors.some(e => /missing jid j2/.test(e))); }
  { const v = validateBatch(['j1'], [meta, good('j1'), good('zzz')]); assert.equal(v.ok, false); assert.ok(v.errors.some(e => /foreign jid zzz/.test(e))); }
  { const v = validateBatch(['j1'], [meta, good('j1'), good('j1')]); assert.equal(v.ok, false); assert.ok(v.errors.some(e => /duplicate jid j1/.test(e))); }
  { const v = validateBatch(['j1'], [meta, { jid: 'j1', grade: 3, rationale: 'x' }]); assert.equal(v.ok, false); assert.ok(v.errors.some(e => /bad grade/.test(e)), 'out of range'); }
  { const v = validateBatch(['j1'], [meta, { jid: 'j1', grade: 1.5, rationale: 'x' }]); assert.equal(v.ok, false); assert.ok(v.errors.some(e => /bad grade/.test(e)), 'non-integer'); }
  { const long = Array.from({ length: 26 }, (_, i) => `w${i}`).join(' '); const v = validateBatch(['j1'], [meta, { jid: 'j1', grade: 1, rationale: long }]); assert.equal(v.ok, false); assert.ok(v.errors.some(e => /too long/.test(e))); }
  { const ok25 = Array.from({ length: 25 }, (_, i) => `w${i}`).join(' '); const v = validateBatch(['j1'], [meta, { jid: 'j1', grade: 1, rationale: ok25 }]); assert.equal(v.ok, true, 'exactly 25 words is the boundary, still valid'); }
  console.log('  OK: validateBatch — meta/jid-set/grade/rationale error classes, 25-word boundary');
}
// judging: mergeRows — jid-based dedup on merge (existing rows win; only genuinely new jids get appended)
{
  const { mergeRows } = await import('../eval/graph-role/lib/judging.mjs');
  const existing = [{ jid: 'a', grade: 1 }, { jid: 'b', grade: 2 }];
  const incoming = [{ jid: 'b', grade: 9 }, { jid: 'c', grade: 0 }];
  const merged = mergeRows(existing, incoming);
  assert.deepEqual(merged, [{ jid: 'a', grade: 1 }, { jid: 'b', grade: 2 }, { jid: 'c', grade: 0 }], 'dedup by jid keeps the existing row, appends only new jids');
  assert.deepEqual(mergeRows([], incoming), incoming, 'empty existing -> all incoming rows kept');
  console.log('  OK: mergeRows — jid-based dedup on merge');
}
// judging: trimContext — bounded prev/next context window (judge-batches.mjs split --context-chars).
// chunk_text (the passage) is never touched; n <= 0 returns the row unchanged (same reference).
{
  const { trimContext } = await import('../eval/graph-role/lib/judging.mjs');
  const row = { jid: 'j1', chunk_text: 'p'.repeat(50), prev_text: 'a'.repeat(20), next_text: 'b'.repeat(20) };
  const cut = trimContext(row, 8);
  assert.equal(cut.prev_text, '\u2026[cut] ' + 'a'.repeat(8), 'prev longer than n: kept LAST n chars, prefixed with the cut marker');
  assert.equal(cut.next_text, 'b'.repeat(8) + ' \u2026[cut]', 'next longer than n: kept FIRST n chars, suffixed with the cut marker');
  assert.equal(cut.chunk_text, row.chunk_text, 'chunk_text (the passage) is never touched');
  assert.notEqual(cut, row, 'n>0 always returns a NEW row object');

  const boundary = trimContext({ jid: 'j2', chunk_text: '', prev_text: 'a'.repeat(8), next_text: 'b'.repeat(8) }, 8);
  assert.equal(boundary.prev_text, 'a'.repeat(8), 'prev exactly n chars: unchanged (boundary), not >n');
  assert.equal(boundary.next_text, 'b'.repeat(8), 'next exactly n chars: unchanged (boundary), not >n');

  const short = trimContext({ jid: 'j3', chunk_text: 'c', prev_text: 'short', next_text: 'also short' }, 500);
  assert.equal(short.prev_text, 'short', 'prev shorter than n: unchanged');
  assert.equal(short.next_text, 'also short', 'next shorter than n: unmarked');

  assert.equal(trimContext(row, 0), row, 'n=0: row returned unchanged (same reference)');
  assert.equal(trimContext(row, -1), row, 'negative n: row returned unchanged (same reference)');
  console.log('  OK: trimContext \u2014 bounded prev/next window, cut markers, chunk_text untouched, n<=0 unchanged');
}
// stages: provenanceOf — mirrors product buildEntityMatcher (repo-root index.ts): CJK substring
// vs. Latin/mixed word-boundary. hasCJK ranges are copied verbatim from index.ts's hasCJK()
// (　-鿿가-힯＀-￯), not from the task brief's narrower literal-character-
// class approximation (`[぀-ヿ㐀-鿿가-힯]`, missing 　-〿 CJK punctuation and ＀-￯
// fullwidth/halfwidth forms) — the extra assertion below is a real, empirically-verified divergence
// between the two, not a hypothetical one (brief regex would call it 'nonliteral').
{
  const { provenanceOf } = await import('../eval/graph-role/lib/stages.mjs');
  assert.equal(provenanceOf('The Alpha Node appears here', 'Alpha Node'), 'name');
  assert.equal(provenanceOf('The AlphaNode appears here', 'Alpha Node'), 'nonliteral');
  assert.equal(provenanceOf('할랄 인증 기준', '할랄'), 'name');
  assert.equal(provenanceOf('SuperAPI runs', 'API'), 'nonliteral');   // word boundary for Latin
  assert.equal(provenanceOf('some ＡＢＣ text here', 'ＡＢＣ'), 'name',
    'fullwidth Latin (U+FF21-FF23, in \\uff00-\\uffef) counts as CJK under product hasCJK -> substring match; verified against index.ts, not guessed');
  console.log('  OK: provenance name/nonliteral');
}

// run-upstream: computeEdgeValidity — per-query edge_validity against extract-observed.mjs's
// observed_paths rows ({from,to,edge_id,relation_type,direction} when the edge exists in the KG;
// {from,to,missing_entity} -- no edge_id -- when an endpoint entity itself is missing from the KG).
{
  const { computeEdgeValidity } = await import('../eval/graph-role/run-upstream.mjs');
  const expEdges = [
    { from: 'A', to: 'B', type: 'REFERENCES', direction: 'out', required: true },   // exists, direction+type match
    { from: 'B', to: 'C', type: 'USES', direction: 'in', required: true },          // exists, direction+type mismatch
    { from: 'X', to: 'Y', type: 'any', direction: 'any', required: true },          // missing entirely, required -> required_missing++
    { from: 'P', to: 'Q', type: 'any', direction: 'any', required: false },         // missing_entity row only (no edge_id) -> not "exists"; not required -> no increment
  ];
  const obs = [
    { from: 'A', to: 'B', edge_id: 'e1', relation_type: 'REFERENCES', direction: 'out' },
    { from: 'B', to: 'C', edge_id: 'e2', relation_type: 'CONTAINS', direction: 'out' },   // wrong type AND wrong direction
    { from: 'P', to: 'Q', missing_entity: 'Q' },   // no edge_id -> the exists filter excludes it
  ];
  const ev = computeEdgeValidity(expEdges, obs);
  assert.deepEqual(ev, { total: 4, exists: 2, direction_ok: 1, type_ok: 1, required_missing: 1 });
  // 'any' bypasses both checks whenever the edge exists at all, regardless of the observed row's actual type/direction
  const anyEv = computeEdgeValidity(
    [{ from: 'A', to: 'B', type: 'any', direction: 'any', required: true }],
    [{ from: 'A', to: 'B', edge_id: 'e1', relation_type: 'WHATEVER', direction: 'in' }]
  );
  assert.deepEqual(anyEv, { total: 1, exists: 1, direction_ok: 1, type_ok: 1, required_missing: 0 });
  console.log('  OK: computeEdgeValidity — exists/direction_ok/type_ok/required_missing, any-bypass, missing_entity rows excluded');
}

// link-audit-merge: precisionOf/clusterByChunk — chunk-level grouping so a bootstrap resamples
// chunks (independent passages), not pairs (up to 15 pairs can share one passage/judge read).
{
  const { precisionOf, clusterByChunk } = await import('../eval/graph-role/link-audit-merge.mjs');
  assert.equal(precisionOf([]), null, 'no judged rows -> precision undefined, not 0');
  assert.equal(precisionOf([{ ok: 1 }, { ok: 0 }, { ok: 1 }]), 2 / 3);

  const items = [
    { jid: 'j1', chunk_id: 'c1', stratum: 'low', provenance: 'name' },
    { jid: 'j2', chunk_id: 'c1', stratum: 'low', provenance: 'nonliteral' },
    { jid: 'j3', chunk_id: 'c2', stratum: 'mid', provenance: 'name' },
    { jid: 'j4', chunk_id: 'c3', stratum: 'high', provenance: 'name' },   // unjudged -> excluded entirely
  ];
  const judgeMap = new Map([['j1', 1], ['j2', 0], ['j3', 1]]);            // j4 has no verdict
  const clusters = clusterByChunk(items, judgeMap);
  assert.equal(clusters.length, 2, 'c3 dropped entirely: its only row (j4) has no judgment');
  const byId = Object.fromEntries(clusters.map(c => [c[0].chunk_id, c]));
  assert.deepEqual(byId.c1.map(r => r.ok), [1, 0], 'both c1 pairs kept, judge-A verdicts attached as .ok');
  assert.deepEqual(byId.c2.map(r => r.ok), [1]);
  console.log('  OK: precisionOf/clusterByChunk — null-on-empty, chunk grouping drops unjudged jids');
}
// link-audit-merge: byStratum/byProvenance/weightedPrecision — hand-computed on a 4-cluster fixture
// (2 low clusters, 1 mid, 1 high; prevalence weights favor low 50%/mid 25%/high 25% of the corpus).
{
  const { byStratum, byProvenance, weightedPrecision } = await import('../eval/graph-role/link-audit-merge.mjs');
  const L1 = [{ stratum: 'low', provenance: 'name', ok: 1 }, { stratum: 'low', provenance: 'name', ok: 1 }];
  const L2 = [{ stratum: 'low', provenance: 'nonliteral', ok: 0 }];
  const M1 = [{ stratum: 'mid', provenance: 'name', ok: 1 }, { stratum: 'mid', provenance: 'name', ok: 0 }, { stratum: 'mid', provenance: 'nonliteral', ok: 1 }];
  const H1 = [{ stratum: 'high', provenance: 'name', ok: 1 }, { stratum: 'high', provenance: 'nonliteral', ok: 1 }];
  const clusters = [L1, L2, M1, H1];

  const bs = byStratum(clusters);
  assert.deepEqual(bs.low, { n: 3, precision: 2 / 3 }, 'low = L1+L2 flat = [1,1,0]');
  assert.deepEqual(bs.mid, { n: 3, precision: 2 / 3 }, 'mid = M1 = [1,0,1]');
  assert.deepEqual(bs.high, { n: 2, precision: 1 }, 'high = H1 = [1,1]');

  const bp = byProvenance(clusters);
  assert.deepEqual(bp.name, { n: 5, precision: 0.8 }, 'name rows across all clusters = [1,1,1,0,1] = 4/5');
  assert.deepEqual(bp.nonliteral, { n: 3, precision: 2 / 3 }, 'nonliteral rows = [0,1,1] = 2/3');

  // weighted = precision(low)*w(low) + precision(mid)*w(mid) + precision(high)*w(high)
  //          = (2/3)*(100/200) + (2/3)*(50/200) + 1*(50/200) = 1/3 + 1/6 + 1/4 = 0.75 exactly
  const wp = weightedPrecision(clusters, { low: 100, mid: 50, high: 50 });
  assert.ok(Math.abs(wp - 0.75) < 1e-9, `hand-computed weighted precision = 0.75, got ${wp}`);
  // a stratum absent from the sample (precision null) contributes 0, not NaN
  const wpMissing = weightedPrecision([L1, L2], { low: 100, mid: 50, high: 50 });
  assert.ok(Math.abs(wpMissing - (2 / 3) * 0.5) < 1e-9, 'mid/high absent from sample -> precision null -> contribute 0, no NaN');
  console.log('  OK: byStratum/byProvenance/weightedPrecision — hand-computed against a 4-cluster fixture');
}
// link-audit-merge: bootstrapCI — chunk-cluster percentile bootstrap. Degenerate rng (always 0)
// against a single-cluster fixture makes every resample identical to the point estimate (exact,
// no PRNG sequence to hand-simulate); a second case checks determinism + bounds sanity with the
// real mulberry32 PRNG on the 4-cluster fixture above.
{
  const { bootstrapCI, weightedPrecision } = await import('../eval/graph-role/link-audit-merge.mjs');
  const single = [[{ stratum: 'low', provenance: 'name', ok: 1 }, { stratum: 'low', provenance: 'name', ok: 1 }]];
  const prev1 = { low: 10, mid: 5, high: 5 };
  assert.ok(Math.abs(weightedPrecision(single, prev1) - 0.5) < 1e-9, 'point estimate: precision(low)=1 * w(low)=10/20 = 0.5');
  const degenerate = bootstrapCI(single, prev1, 5, () => 0);
  assert.deepEqual(degenerate.boots, [0.5, 0.5, 0.5, 0.5, 0.5], 'rng always 0 -> Math.floor(0*len)=0 always -> every resample is [clusters[0]] (len 1)');
  assert.equal(degenerate.lo, 0.5); assert.equal(degenerate.hi, 0.5);

  const L1 = [{ stratum: 'low', provenance: 'name', ok: 1 }, { stratum: 'low', provenance: 'name', ok: 1 }];
  const L2 = [{ stratum: 'low', provenance: 'nonliteral', ok: 0 }];
  const M1 = [{ stratum: 'mid', provenance: 'name', ok: 1 }, { stratum: 'mid', provenance: 'name', ok: 0 }, { stratum: 'mid', provenance: 'nonliteral', ok: 1 }];
  const H1 = [{ stratum: 'high', provenance: 'name', ok: 1 }, { stratum: 'high', provenance: 'nonliteral', ok: 1 }];
  const clusters = [L1, L2, M1, H1];
  const prev = { low: 100, mid: 50, high: 50 };
  const ciA = bootstrapCI(clusters, prev, 200, mulberry32(99));
  const ciB = bootstrapCI(clusters, prev, 200, mulberry32(99));
  assert.deepEqual(ciA, ciB, 'same seed -> identical bootstrap CI (determinism)');
  assert.ok(ciA.lo <= ciA.hi, 'lo <= hi');
  assert.ok(ciA.lo >= 0 && ciA.hi <= 1, 'CI bounds within [0,1]');
  console.log('  OK: bootstrapCI — degenerate-rng exactness, determinism, bounds sanity');
}

console.log('eval-graph-role-libs: ALL OK');
