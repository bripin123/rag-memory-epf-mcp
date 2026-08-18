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
// pooling: D2 incremental deep-tier planning — saturation, qualification, ascending-qid budget truncation, judge.jsonl order
{
  const { planDeep } = await import('../eval/graph-role/lib/pooling.mjs');
  const poolRows = [
    // q1: one relevant doc (max grade 2) found by 2 channels -> saturated, does NOT qualify
    { qid: 'q1', chunk_id: 'q1c1', doc_id: 'q1d1', jid: 'q1c1', tier: 'top30', channels: ['vector'], conds: ['real'] },
    { qid: 'q1', chunk_id: 'q1c2', doc_id: 'q1d1', jid: 'q1c2', tier: 'top30', channels: ['fts'], conds: ['real'] },
    { qid: 'q1', chunk_id: 'q1x1', doc_id: 'q1d9', jid: 'q1_deep', tier: 'deep', channels: [], conds: [] },
    // q2: one relevant doc found by exactly 1 channel -> qualifies
    { qid: 'q2', chunk_id: 'q2c1', doc_id: 'q2d1', jid: 'q2c1', tier: 'top30', channels: ['vector'], conds: ['real'] },
    { qid: 'q2', chunk_id: 'q2x1', doc_id: 'q2d9', jid: 'q2_deep_a', tier: 'deep', channels: [], conds: [] },
    { qid: 'q2', chunk_id: 'q2x2', doc_id: 'q2d9', jid: 'q2_deep_b', tier: 'deep', channels: [], conds: [] },
    // q3: no relevant docs at all -> does NOT qualify
    { qid: 'q3', chunk_id: 'q3c1', doc_id: 'q3d1', jid: 'q3c1', tier: 'top30', channels: ['vector'], conds: ['real'] },
    { qid: 'q3', chunk_id: 'q3x1', doc_id: 'q3d9', jid: 'q3_deep', tier: 'deep', channels: [], conds: [] },
    // q4: one relevant doc found by exactly 1 channel -> qualifies, but its 3 deep rows overflow the budget
    { qid: 'q4', chunk_id: 'q4c1', doc_id: 'q4d1', jid: 'q4c1', tier: 'top30', channels: ['fts'], conds: ['real'] },
    { qid: 'q4', chunk_id: 'q4x1', doc_id: 'q4d9', jid: 'q4_deep_a', tier: 'deep', channels: [], conds: [] },
    { qid: 'q4', chunk_id: 'q4x2', doc_id: 'q4d9', jid: 'q4_deep_b', tier: 'deep', channels: [], conds: [] },
    { qid: 'q4', chunk_id: 'q4x3', doc_id: 'q4d9', jid: 'q4_deep_c', tier: 'deep', channels: [], conds: [] },
  ];
  // judge.jsonl file order deliberately scrambled (not qid-grouped) to prove pass2_jids follows file order, not qid order.
  const judgeRows = [
    { jid: 'q3c1', tier: 'top30', qid: 'q3' }, { jid: 'q4_deep_b', tier: 'deep', qid: 'q4' }, { jid: 'q2c1', tier: 'top30', qid: 'q2' },
    { jid: 'q1c1', tier: 'top30', qid: 'q1' }, { jid: 'q2_deep_a', tier: 'deep', qid: 'q2' }, { jid: 'q4c1', tier: 'top30', qid: 'q4' },
    { jid: 'q1_deep', tier: 'deep', qid: 'q1' }, { jid: 'q1c2', tier: 'top30', qid: 'q1' }, { jid: 'q4_deep_a', tier: 'deep', qid: 'q4' },
    { jid: 'q3_deep', tier: 'deep', qid: 'q3' }, { jid: 'q2_deep_b', tier: 'deep', qid: 'q2' }, { jid: 'q4_deep_c', tier: 'deep', qid: 'q4' },
  ];
  const grades = new Map([['q1c1', 2], ['q1c2', 0], ['q2c1', 2], ['q3c1', 0], ['q4c1', 2]]);
  const plan = planDeep({ poolRows, judgeRows, grades, budget: 7 });
  assert.deepEqual(plan.qualifying, ['q2', 'q4'], 'q1 saturated (relevant doc found by 2 channels) and q3 (no relevant docs) do not qualify; q2/q4 do');
  assert.deepEqual(plan.truncated, ['q4'], 'q4 is the 2nd qualifying query in ascending qid order; pass1(5)+q2(2)=7 fits budget 7, +q4(3)=10 overflows');
  assert.equal(plan.pass1_rows, 5, 'every top30 row across all 4 queries counts toward pass 1, regardless of qualification');
  assert.equal(plan.pass2_rows, 2, 'only q2 deep rows are planned; q4 truncated, q1/q3 never qualified');
  assert.deepEqual(plan.pass2_jids, ['q2_deep_a', 'q2_deep_b'], 'deep jids of planned queries only, in judge.jsonl file order');
  console.log('  OK: planDeep — saturation, qualification, ascending-qid budget truncation, judge.jsonl-order jids');
}
// pooling: naturalCompare — "ascending qid order" must be natural (numeric within digit runs), not lexicographic.
// Real ids are `<corpus>-<class>-<n>` with unpadded n (hub-A-1..hub-A-53), where default string sort is wrong
// (would put hub-A-10 before hub-A-2). This case uses multi-digit ids that diverge under the two orderings.
{
  const { planDeep, naturalCompare } = await import('../eval/graph-role/lib/pooling.mjs');
  assert.ok(naturalCompare('q-2', 'q-10') < 0, 'q-2 before q-10 under natural order (default string sort would reverse this)');
  assert.ok(naturalCompare('q-10', 'q-2') > 0);
  assert.equal(naturalCompare('q-1', 'q-1'), 0);
  assert.deepEqual(['q-2', 'q-10', 'q-1'].sort(naturalCompare), ['q-1', 'q-2', 'q-10'], 'natural sort ascending');
  assert.deepEqual(['q-2', 'q-10', 'q-1'].sort(), ['q-1', 'q-10', 'q-2'], 'default string sort puts q-10 before q-2 -- the bug naturalCompare fixes');

  // planDeep itself must use natural order for both the qualifying scan and the truncation walk.
  const mkTop30 = (qid) => ({ qid, chunk_id: `${qid}c1`, doc_id: `${qid}d1`, jid: `${qid}c1`, tier: 'top30', channels: ['vector'], conds: ['real'] });
  const mkDeep = (qid) => ({ qid, chunk_id: `${qid}x1`, doc_id: `${qid}d9`, jid: `${qid}_deep`, tier: 'deep', channels: [], conds: [] });
  const ids = ['q-2', 'q-10', 'q-1'];   // deliberately out of natural order in the input
  const poolRows = ids.flatMap(qid => [mkTop30(qid), mkDeep(qid)]);
  const judgeRows = ids.flatMap(qid => [{ jid: `${qid}c1`, tier: 'top30', qid }, { jid: `${qid}_deep`, tier: 'deep', qid }]);
  const grades = new Map(ids.map(qid => [`${qid}c1`, 2]));   // every query's one top30 doc is relevant, found by exactly 1 channel -> all 3 qualify
  const plan = planDeep({ poolRows, judgeRows, grades, budget: 5 });   // pass1_rows=3 (one top30 row each); budget fits exactly 2 queries' single deep row
  assert.deepEqual(plan.qualifying, ['q-1', 'q-2', 'q-10'], 'qualifying scan must use natural order, not default string sort (which would give q-1,q-10,q-2)');
  assert.deepEqual(plan.truncated, ['q-10'], 'natural order: q-1(3+1=4) then q-2(4+1=5) fit budget 5, q-10(5+1=6) overflows -- under default string sort order it would be q-2 that truncates instead');
  console.log('  OK: naturalCompare — digit runs numeric, ascending id order for qualifying scan and truncation');
}
console.log('eval-graph-role-libs: ALL OK');
