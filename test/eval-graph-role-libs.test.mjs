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
// pooling: requiredItems — qrels merge required-set selection (judge-merge.mjs). Default = every top10 row
// + top30 rows of queries in plan.selected (see planPass2 above); deep-tier rows and top30 rows of
// non-selected queries are never included, in either mode. --pass1-only ignores plan.selected entirely --
// required items are the top10 tier alone.
{
  const { requiredItems } = await import('../eval/graph-role/lib/pooling.mjs');
  const items = [
    { jid: 't1', tier: 'top10', qid: 'q1' },
    { jid: 't2', tier: 'top10', qid: 'q2' },
    { jid: 'a1', tier: 'top30', qid: 'q1' },   // q1 selected
    { jid: 'a2', tier: 'top30', qid: 'q2' },   // q2 NOT selected
    { jid: 'd1', tier: 'deep', qid: 'q1' },    // deep tier -- never required, selected or not
  ];
  const plan = { selected: ['q1'], not_selected: ['q2'] };

  const def = requiredItems(items, plan, { pass1Only: false });
  assert.deepEqual(def.map(i => i.jid), ['t1', 't2', 'a1'], 'default: both top10 rows + top30 of selected q1; a2 (q2, not selected) and d1 (deep) excluded');
  assert.deepEqual(requiredItems(items, plan), def, 'options object itself is optional (defaults to {}, i.e. pass1Only false)');

  const p1 = requiredItems(items, plan, { pass1Only: true });
  assert.deepEqual(p1.map(i => i.jid), ['t1', 't2'], 'pass1Only: top10 rows only -- a1 excluded even though its query q1 IS in plan.selected');

  const planNothingSelected = { selected: [], not_selected: ['q1', 'q2'] };
  assert.deepEqual(requiredItems(items, planNothingSelected, { pass1Only: true }).map(i => i.jid), ['t1', 't2'], 'pass1Only result does not depend on plan contents at all');

  assert.ok(!def.some(i => i.tier === 'deep'), 'deep rows never included (default)');
  assert.ok(!p1.some(i => i.tier === 'deep'), 'deep rows never included (pass1Only)');
  assert.ok(!def.some(i => i.jid === 'a2'), 'top30 row of a non-selected query never included (default)');
  console.log('  OK: requiredItems — default (top10 + top30-of-selected), pass1Only (top10 only, selected ignored), deep/non-selected always excluded');
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

// ---------------------------------------------------------------------------
// Task 8 — metrics library + the two gold sources report.mjs/power.mjs share.
// Every fixture below is hand-computed; the comment carries the arithmetic so a
// reviewer can re-derive the expected value without running the code.
// ---------------------------------------------------------------------------

// Step 1 fixture block from the task brief, kept verbatim.
{
  const M = await import('../eval/graph-role/lib/metrics.mjs');
  assert.equal(M.hitAtK(1, 1), 1); assert.equal(M.hitAtK(-1, 5), 0);
  assert.equal(M.hitAtK(0, 5), 0, 'rank 0 = "not found" (findIndex(-1)+1), never a hit');
  const docOf = id => id.split('_')[0];
  assert.equal(M.recallAtKDoc(['d1_c1', 'd2_c1', 'd3_c1'], new Set(['d2', 'd9']), docOf, 2), 0.5);
  assert.equal(M.mrrDoc(['d1_c1', 'd2_c1'], new Set(['d2']), docOf), 0.5);
  const grade = { d1: 2, d2: 1 };
  const nd = M.ndcg10Graded(['d2_c1', 'd1_c1'], d => grade[d] || 0, docOf);   // DCG = 1/log2(2) + 3/log2(3) ; IDCG = 3/log2(2) + 1/log2(3)
  assert.ok(Math.abs(nd - ((1 + 3 / Math.log2(3)) / (3 + 1 / Math.log2(3)))) < 1e-9);
  assert.ok(Math.abs(M.signTestExact(8, 2) - 0.109375) < 1e-6, 'two-sided exact binomial 8 vs 2');
  const ci = M.bootstrapPairedCI([0.1, 0.2, 0.0, 0.3, 0.1, 0.2], ['a', 'a', 'b', 'b', 'c', 'c'], { iters: 2000, seed: 1 });
  assert.ok(ci[0] <= 0.15 && ci[1] >= 0.15 && ci[0] > -0.2 && ci[1] < 0.5);
  assert.deepEqual(M.holm([0.01, 0.04, 0.03]).map(x => +x.toFixed(2)), [0.03, 0.06, 0.06]);
  assert.ok(M.powerN(0.2, 0.05, { alpha: 0.05, power: 0.8 }) >= 120 && M.powerN(0.2, 0.05, { alpha: 0.05, power: 0.8 }) <= 130, 'n ≈ 126 (r4 example)');
  console.log('  OK: metrics (hit/recall/mrr/ndcg/sign/bootstrap/holm/power)');
}

// recall/mrr/nDCG edge cases the report actually hits: empty gold, gold outside
// the budget, the full-gold ideal (report.mjs passes allGoldDocs; the brief's
// Step 1 case above passes null and therefore uses the retrieved-only ideal).
{
  const M = await import('../eval/graph-role/lib/metrics.mjs');
  const docOf = M.docOfChunk;
  assert.equal(M.recallAtKDoc(['d1_chunk_0'], new Set(), docOf, 10), null, 'no gold -> null, never 0 (0 would read as "missed everything")');
  assert.equal(M.recallAtKDoc([], new Set(['d1']), docOf, 10), 0, 'empty ranking with gold = 0 recall');
  // duplicate documents inside the chunk budget collapse: top-3 chunks are d1,d1,d2 -> 2 unique docs
  assert.equal(M.recallAtKDoc(['d1_chunk_0', 'd1_chunk_1', 'd2_chunk_0', 'd3_chunk_0'], new Set(['d2', 'd3']), docOf, 3), 0.5);
  assert.equal(M.mrrDoc(['d1_chunk_0', 'd1_chunk_1', 'd2_chunk_0'], new Set(['d2']), docOf), 0.5, 'rank is over DISTINCT documents: d1(1), d2(2) -> 1/2');
  assert.equal(M.mrrDoc(['d1_chunk_0'], new Set(['d9']), docOf), 0, 'gold never retrieved -> 0');
  // full-gold ideal: ranked d2(1), d1(2), d5(0); gold {d1,d2,d3} with grades 2,1,2
  // DCG   = (2^1-1)/log2(2) + (2^2-1)/log2(3) + 0            = 1 + 3/log2(3)
  // IDCG  = grades [2,2,1] -> 3/log2(2) + 3/log2(3) + 1/log2(4) = 3 + 3/log2(3) + 0.5
  const g = { d1: 2, d2: 1, d3: 2 };
  const ndFull = M.ndcg10Graded(['d2_chunk_0', 'd1_chunk_0', 'd5_chunk_0'], d => g[d] || 0, docOf, new Set(['d1', 'd2', 'd3']));
  assert.ok(Math.abs(ndFull - ((1 + 3 / Math.log2(3)) / (3.5 + 3 / Math.log2(3)))) < 1e-9, 'full-gold ideal includes the unretrieved gold doc');
  assert.equal(M.ndcg10Graded(['d5_chunk_0'], () => 0, docOf, new Set()), 0, 'ideal 0 -> 0, not NaN');
  console.log('  OK: recall/mrr/nDCG edge cases (null gold, doc dedup, full-gold ideal)');
}

// docOfChunk: the engine id form is `${document_id}_chunk_${index}`, and document
// ids in these corpora can themselves contain "_chunk_" -> lastIndexOf, not split.
{
  const M = await import('../eval/graph-role/lib/metrics.mjs');
  assert.equal(M.docOfChunk('log-2026-05-09_chunk_12'), 'log-2026-05-09');
  assert.equal(M.docOfChunk('a_chunk_1_chunk_2'), 'a_chunk_1', 'lastIndexOf: only the final _chunk_ separates doc from index');
  assert.equal(M.docOfChunk('no-separator-here'), 'no-separator-here', 'ids without the marker are their own document');
  console.log('  OK: docOfChunk uses lastIndexOf("_chunk_")');
}

// sign test / Holm / power / pctile / mean / sd — hand-computed
{
  const M = await import('../eval/graph-role/lib/metrics.mjs');
  assert.equal(M.signTestExact(0, 0), 1, 'no discordant pairs -> p = 1');
  assert.ok(Math.abs(M.signTestExact(0, 5) - 0.0625) < 1e-12, '2 * C(5,0)/2^5 = 2/32');
  assert.equal(M.signTestExact(5, 5), 1, '2 * 638/1024 = 1.246 -> clamped to 1');
  assert.deepEqual(M.holm([0.2]), [0.2], 'family of one = unadjusted');
  assert.deepEqual(M.holm([0.4, 0.5, 0.6]).map(x => +x.toFixed(2)), [1, 1, 1], 'adjusted p is capped at 1');
  const hm = M.holm([0.001, 1, 1]);   // the report pads non-estimable endpoints with p=1 but keeps m=3
  assert.ok(Math.abs(hm[0] - 0.003) < 1e-12 && hm[1] === 1 && hm[2] === 1, 'padding with 1 keeps the pre-declared family size m=3');
  assert.equal(M.powerN(0.2, 0.05, { alpha: 0.05, power: 0.8 }), 126, '((1.959964+0.841621)*0.2/0.05)^2 = 125.6 -> 126');
  assert.equal(M.powerN(0.2, 0.05, { alpha: 0.10, power: 0.8 }), 99, 'one-sided 0.05 (= two-sided 0.10): ((1.644854+0.841621)*4)^2 = 98.92 -> 99');
  assert.equal(M.powerN(0, 0.05, { alpha: 0.05, power: 0.8 }), 0, 'zero variance -> 0');
  assert.equal(M.powerN(0.2, 0, { alpha: 0.05, power: 0.8 }), null, 'MCID 0 would divide by zero -> null, not Infinity');
  assert.equal(M.pctile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10, 'floor(0.95*10)=9 -> 10th smallest');
  assert.equal(M.pctile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 6, 'floor(0.5*10)=5 -> 6th smallest');
  assert.equal(M.pctile([], 0.95), null, 'empty -> null');
  assert.equal(M.mean([1, 2, 3, 4]), 2.5);
  assert.equal(M.mean([]), null);
  assert.ok(Math.abs(M.sd([1, 2, 3, 4]) - Math.sqrt(5 / 3)) < 1e-12, 'sample SD: sum sq dev 5, /(n-1)=3');
  assert.equal(M.sd([7]), null, 'n=1 has no sample SD');
  console.log('  OK: signTest/holm/powerN/pctile/mean/sd hand-computed');
}

// bootstrapPairedCI: clustering, determinism, and the one-sided lower bound
{
  const M = await import('../eval/graph-role/lib/metrics.mjs');
  // cluster sums must differ, or every resample returns the same mean and the CI is a point.
  const d = [0.1, 0.2, -0.1, 0.3, 0.0, 0.5], cl = ['a', 'a', 'b', 'b', 'c', 'c'];   // cluster sums 0.3 / 0.2 / 0.5
  const a = M.bootstrapPairedCI(d, cl, { iters: 1000, seed: 42 });
  const b = M.bootstrapPairedCI(d, cl, { iters: 1000, seed: 42 });
  assert.deepEqual(a, b, 'same seed -> identical CI');
  // With only 3 clusters the 2.5/97.5 percentiles sit on the extreme resamples for
  // every seed, so seed sensitivity has to be checked where the tail can move.
  const many = [], manyCl = [];
  for (let i = 0; i < 10; i++) { many.push(i * 0.05, i * 0.05 + 0.01); manyCl.push('g' + i, 'g' + i); }
  assert.notDeepEqual(M.bootstrapPairedCI(many, manyCl, { iters: 1000, seed: 42 }),
                      M.bootstrapPairedCI(many, manyCl, { iters: 1000, seed: 43 }),
                      'a different seed moves the CI (the resample really is random)');
  // clustering is not cosmetic: resampling whole families is wider than resampling
  // observations when the between-cluster variance dominates.
  const cd = [1, 1, 1, -1, -1, -1, 1, 1, 1, -1, -1, -1], ccl = ['a', 'a', 'a', 'b', 'b', 'b', 'c', 'c', 'c', 'e', 'e', 'e'];
  const clustered = M.bootstrapPairedCI(cd, ccl, { iters: 2000, seed: 7 });
  const flat = M.bootstrapPairedCI(cd, null, { iters: 2000, seed: 7 });
  assert.ok((clustered[1] - clustered[0]) > (flat[1] - flat[0]) * 1.5, 'cluster bootstrap is materially wider than the per-observation one');
  const one = M.bootstrapPairedCI([0.2, 0.2, 0.2], ['x', 'x', 'x'], { iters: 500, seed: 1 });
  assert.ok(Math.abs(one[0] - 0.2) < 1e-12 && Math.abs(one[1] - 0.2) < 1e-12, 'a single cluster resamples to itself -> CI collapses to the point estimate');
  const lo1 = M.oneSidedLowerCI(d, cl, { iters: 1000, seed: 42 });
  assert.ok(lo1 >= a[0], 'one-sided 95% lower (5th pct) is never below the two-sided 95% lower (2.5th pct)');
  assert.ok(lo1 <= M.mean(d) + 1e-12, 'lower bound does not exceed the point estimate');
  const noCluster = M.bootstrapPairedCI(d, null, { iters: 200, seed: 3 });
  assert.ok(noCluster[0] <= noCluster[1], 'null clusterIds = one cluster per observation');
  console.log('  OK: bootstrapPairedCI clustering/determinism + oneSidedLowerCI');
}

// gold sources: (a) authored — the suite's own gold, available with no judging;
//               (b) judged  — qrels, document grade = max over judged chunks.
{
  const M = await import('../eval/graph-role/lib/metrics.mjs');
  const K = { id: 'c-K-1', class: 'K', family: 'd1', document_id: 'd1', oracle_chunk_id: 'd1_chunk_0' };
  const A = { id: 'c-A-1', class: 'A', family: 'wiki/x.md', source_docs: ['a', 'b'] };
  const Mq = { id: 'c-M-1', class: 'M', family: 'c', source_docs: ['a', 'b'] };
  const Mq2 = { id: 'c-M-2', class: 'M', family: 'a', source_docs: ['a', 'b'] };
  assert.deepEqual([...M.authoredGoldDocs(K)], ['d1'], 'K gold = its document_id');
  assert.deepEqual([...M.authoredGoldDocs(A)].sort(), ['a', 'b'], 'A gold = source_docs; family is a seed label, not a doc id');
  assert.deepEqual([...M.authoredGoldDocs(Mq)].sort(), ['a', 'b', 'c'], 'M gold = source_docs + family (the bridge target document)');
  assert.deepEqual([...M.authoredGoldDocs(Mq2)].sort(), ['a', 'b'], 'family already in source_docs -> set, no duplicate');

  const au = M.buildAuthoredGold([K, A, Mq]);
  assert.equal(au.source, 'authored');
  assert.deepEqual([...au.gold.get('c-A-1')].sort(), ['a', 'b']);
  assert.equal(au.grade.get('c-A-1').get('a'), 1, 'authored gold is binary: every gold doc gets grade 1');
  assert.equal(au.grade.get('c-A-1').get('zzz'), undefined, 'non-gold docs are absent (report reads them as 0)');
  assert.equal(au.oracleChunk.get('c-K-1'), 'd1_chunk_0');
  assert.equal(au.depth.get('c-A-1'), null, 'authored gold has no judging depth');

  assert.equal(M.buildJudgedGold([]), null, 'no qrels rows -> null, so the caller prints "qrels absent"');
  const qr = [
    { qid: 'q1', doc_id: 'd1', chunk_id: 'd1_chunk_0', grade: 2, judged_depth: 10, qrels_grade: 'LLM-judged provisional', pool_truncated: true },
    { qid: 'q1', doc_id: 'd1', chunk_id: 'd1_chunk_1', grade: 1, judged_depth: 10, qrels_grade: 'LLM-judged provisional' },
    { qid: 'q1', doc_id: 'd2', chunk_id: 'd2_chunk_0', grade: 0, judged_depth: 10, qrels_grade: 'LLM-judged provisional' },
    { qid: 'q2', doc_id: 'd3', chunk_id: 'd3_chunk_0', grade: 1, judged_depth: 30, qrels_grade: 'LLM-judged provisional' },
  ];
  const j = M.buildJudgedGold(qr);
  assert.equal(j.source, 'judged');
  assert.deepEqual([...j.gold.get('q1')], ['d1'], 'grade>=1 only: d2 graded 0 is judged non-relevant, not gold');
  assert.equal(j.grade.get('q1').get('d1'), 2, 'document grade = max over its judged chunks');
  assert.equal(j.grade.get('q1').get('d2'), 0, 'a judged-0 document is still in the grade map (nDCG gain 0)');
  assert.equal(j.depth.get('q1'), 10); assert.equal(j.depth.get('q2'), 30);
  assert.equal(j.qrels_grade, 'LLM-judged provisional');
  assert.equal(j.pool_truncated, true);
  assert.deepEqual(j.deep30, new Set(['q2']), 'only depth-30 queries can carry a recall@30 estimate');
  console.log('  OK: authored + judged gold sources (doc grade = max over chunks, depth tracking)');
}

// link-audit reliability: reliabilityOf — Cohen's kappa (weightedKappa(a,b,2), which for 2
// categories is exactly standard unweighted kappa since the only possible distance between two
// binary labels is 0 or 1) over the tagged (second_judge) jids present in both judge-A and judge-B.
{
  const { reliabilityOf } = await import('../eval/graph-role/lib/reliability.mjs');
  // perfect agreement -> kappa 1, agreement 1
  const pA1 = [{ jid: 'a', mention: 1 }, { jid: 'b', mention: 0 }, { jid: 'c', mention: 1 }];
  const pB1 = [{ jid: 'a', mention: 1 }, { jid: 'b', mention: 0 }, { jid: 'c', mention: 1 }];
  assert.deepEqual(reliabilityOf(pA1, pB1, ['a', 'b', 'c']), { n: 3, agreement: 1, kappa: 1 });

  // Hand-computed disagreement: a=[1,1,1,0,0,1] b=[1,1,0,0,0,1] (one disagreement, at j3).
  // O[1][1]=3 O[1][0]=1 O[0][0]=2 O[0][1]=0; ra=[2,4] rb=[3,3]; n=6; w(0,1)=w(1,0)=1 (L=2).
  // num = 1*O[0][1] + 1*O[1][0] = 0 + 1 = 1
  // den = 1*ra[0]*rb[1]/n + 1*ra[1]*rb[0]/n = (2*3)/6 + (4*3)/6 = 1 + 2 = 3
  // kappa = 1 - 1/3 = 2/3 ; agreement = 5/6 (only j3 disagrees)
  const pA2 = [{ jid: 'j1', mention: 1 }, { jid: 'j2', mention: 1 }, { jid: 'j3', mention: 1 }, { jid: 'j4', mention: 0 }, { jid: 'j5', mention: 0 }, { jid: 'j6', mention: 1 }];
  const pB2 = [{ jid: 'j1', mention: 1 }, { jid: 'j2', mention: 1 }, { jid: 'j3', mention: 0 }, { jid: 'j4', mention: 0 }, { jid: 'j5', mention: 0 }, { jid: 'j6', mention: 1 }];
  const disagree = reliabilityOf(pA2, pB2, ['j1', 'j2', 'j3', 'j4', 'j5', 'j6']);
  assert.equal(disagree.n, 6);
  assert.ok(Math.abs(disagree.agreement - 5 / 6) < 1e-9);
  assert.ok(Math.abs(disagree.kappa - 2 / 3) < 1e-9, `hand-computed kappa = 2/3, got ${disagree.kappa}`);

  // `tagged` restricts to a subset (j1,j3,j5): a=[1,1,0] b=[1,0,0]. O[1][1]=1 O[1][0]=1 O[0][0]=1
  // O[0][1]=0; ra=[1,2] rb=[2,1]; n=3. num=1. den=(1*1)/3+(2*2)/3=1/3+4/3=5/3. kappa=1-3/5=2/5.
  const subset = reliabilityOf(pA2, pB2, ['j1', 'j3', 'j5']);
  assert.equal(subset.n, 3);
  assert.ok(Math.abs(subset.agreement - 2 / 3) < 1e-9);
  assert.ok(Math.abs(subset.kappa - 2 / 5) < 1e-9, `hand-computed kappa = 2/5, got ${subset.kappa}`);

  // a tagged jid absent from A or B is excluded from the intersection silently, not an error
  const onlyOverlap = reliabilityOf(pA2, pB2, ['j1', 'not-in-either']);
  assert.deepEqual(onlyOverlap, { n: 1, agreement: 1, kappa: 1 }, 'single-item overlap, agrees -> kappa 1 (weightedKappa den===0 convention)');

  // missing B (or zero tagged/overlap) -> null, never throws
  assert.equal(reliabilityOf(pA2, [], ['j1', 'j2']), null, 'no B rows at all -> null');
  assert.equal(reliabilityOf(pA2, pB2, []), null, 'no tagged jids -> null');
  console.log('  OK: reliabilityOf — hand-computed kappa (perfect/disagreement/subset), missing-B/no-overlap -> null');
}

// link-audit-sample: selectSecondJudgeJids — deterministic stratified ~20% subsample (floor 1 per
// non-empty stratum) that link-audit-sample.mjs tags second_judge:true for the inter-rater check.
{
  const { selectSecondJudgeJids } = await import('../eval/graph-role/link-audit-sample.mjs');
  const mk = (s, n) => Array.from({ length: n }, (_, i) => ({ jid: `${s}${i}`, stratum: s }));
  const rows = [...mk('low', 20), ...mk('mid', 10), ...mk('high', 1)];
  const tagged = selectSecondJudgeJids(rows, mulberry32(7));
  const countIn = (s) => rows.filter(r => r.stratum === s && tagged.has(r.jid)).length;
  assert.equal(countIn('low'), 4, '20 rows * 20% = 4 exactly');
  assert.equal(countIn('mid'), 2, '10 rows * 20% = 2 exactly');
  assert.equal(countIn('high'), 1, 'floor: round(1*0.2)=0, but "at least 1 per stratum" forces 1');
  assert.equal(tagged.size, 7);
  assert.ok(tagged.has('high0'), 'the single high-stratum row is always tagged (only candidate, forced by the floor)');

  const again = selectSecondJudgeJids(rows, mulberry32(7));
  assert.deepEqual([...again].sort(), [...tagged].sort(), 'determinism: same seed -> identical tagged set');

  const emptyHigh = selectSecondJudgeJids([...mk('low', 5), ...mk('mid', 5)], mulberry32(7));
  assert.equal([...emptyHigh].filter(jid => jid.startsWith('high')).length, 0, 'a stratum absent from the input contributes nothing (no crash on an empty array)');
  console.log('  OK: selectSecondJudgeJids — stratified ~20% with floor-1, deterministic, handles an absent stratum');
}

// link-audit-merge: weightedPrecision — totalPrev===0 guard (degenerate/empty prevalence -> null,
// not NaN/Infinity from a division by zero).
{
  const { weightedPrecision } = await import('../eval/graph-role/link-audit-merge.mjs');
  const clusters = [[{ stratum: 'low', provenance: 'name', ok: 1 }]];
  assert.equal(weightedPrecision(clusters, { low: 0, mid: 0, high: 0 }), null, 'totalPrev===0 -> null, not NaN');
  console.log('  OK: weightedPrecision — totalPrev===0 guard returns null');
}

console.log('eval-graph-role-libs: ALL OK');
