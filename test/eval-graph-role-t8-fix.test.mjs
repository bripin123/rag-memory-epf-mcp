// T8 fix round 1 — regression tests for the two behavioural findings (I1, I5).
// Pure: every run happens inside a tmp-dir sandbox that copies eval/graph-role's `lib/`
// and the script under test, so `lib/paths.mjs` resolves EVAL_DIR to the sandbox. No DB,
// no engine, no network, and nothing under the real eval/graph-role/{suite,out,pool} is
// read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SRC = join(dirname(dirname(fileURLToPath(import.meta.url))), 'eval', 'graph-role');
const CHANNELS = ['vector', 'fts', 'graph-seed', 'graph-n1', 'graph-n2', 'graph-vec', 'rrf2', 'rrf3', 'rrf3-n2'];
const CONDS = ['real', 'shuffled-r0', 'random'];   // what poolCost needs to derive a budget cap

function sandbox(scripts) {
  const dir = join(mkdtempSync(join(tmpdir(), 'gr-t8-')), 'graph-role');
  mkdirSync(join(dir, 'suite'), { recursive: true });
  mkdirSync(join(dir, 'out'), { recursive: true });
  cpSync(join(SRC, 'lib'), join(dir, 'lib'), { recursive: true });
  copyFileSync(join(SRC, 'thresholds.json'), join(dir, 'thresholds.json'));
  for (const s of scripts) copyFileSync(join(SRC, s), join(dir, s));
  return dir;
}
const run = (dir, script) => spawnSync(process.execPath, [join(dir, script)], { encoding: 'utf8' });
const writeJsonl = (p, rows) => writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const chunksOf = (doc, n) => Array.from({ length: n }, (_, i) => `${doc}_chunk_${i}`);
const rank = (ids) => ({ chunk10: ids.slice(0, 10), chunk30: ids.slice(0, 30), chunk100: ids.slice(0, 100), doc10: ids.slice(0, 10), doc30: ids.slice(0, 30) });

// One A row. `lift` puts the gold document inside rrf3's (and the reranked pool's) top-30
// and leaves rrf2/base without it, which is the only source of a non-zero paired delta.
function amRow(i, lift) {
  const filler = chunksOf(`filler${i}`, 100);
  const withGold = [...chunksOf(`gold${i}`, 5), ...filler].slice(0, 100);
  const channels = {};
  for (const ch of CHANNELS) channels[ch] = rank(filler);
  channels.rrf3 = rank(lift ? withGold : filler);
  const cand = { id: `hub-A-${i}`, class: 'A', split: 'dev', cond: 'real', channels, seam_status: 'ok', seeds: ['s'], n_connected: 1, n2_count: 1, reach: { chunks: 1, docs_n: 1 } };
  const fin = {
    id: `hub-A-${i}`, class: 'A', split: 'dev', cond: 'real',
    off: { top10: filler.slice(0, 10).map(c => ({ chunk_id: c })) },
    on: { top10: filler.slice(0, 10).map(c => ({ chunk_id: c })) },
    // run-final.mjs records the reranked fixed pool 10 wide (`base.slice(0, 10)`)
    fixedpool_rerank: { base: filler.slice(0, 10), with_graph: (lift ? withGold : filler).slice(0, 10), pool_n: 30 },
  };
  const query = { id: `hub-A-${i}`, class: 'A', split: 'dev', family: `fam${i}`, text: `query ${i}`, source_docs: [`gold${i}`], expected_entities: [], seed_candidates: [], author_mode: 'source-grounded', expected_paths: [] };
  return { cand, fin, query };
}

// One K row. off and on rank the oracle chunk identically, so every K delta is 0.
function kRow(i) {
  const ch = chunksOf(`kdoc${i}`, 100);
  const channels = {};
  for (const c of CHANNELS) channels[c] = rank(ch);
  const cand = { id: `hub-K-${i}`, class: 'K', split: 'dev', cond: 'real', channels, seam_status: 'ok', seeds: ['s'], n_connected: 1, n2_count: 1, reach: { chunks: 1, docs_n: 1 } };
  const fin = {
    id: `hub-K-${i}`, class: 'K', split: 'dev', cond: 'real',
    off: { top10: ch.slice(0, 10).map(c => ({ chunk_id: c })) },
    on: { top10: ch.slice(0, 10).map(c => ({ chunk_id: c })) },
    fixedpool_rerank: { base: ch.slice(0, 10), with_graph: ch.slice(0, 10), pool_n: 30 },
  };
  const query = { id: `hub-K-${i}`, class: 'K', split: 'dev', family: `kdoc${i}`, text: `known item ${i}`, oracle_chunk_id: `kdoc${i}_chunk_0`, document_id: `kdoc${i}` };
  return { cand, fin, query };
}

// `lifted` = how many of the 8 A rows get the gold document in rrf3. 0 => every paired
// delta is exactly 0 => the pilot SD is exactly 0 (the I1 case).
function fixture(dir, { lifted = 0 } = {}) {
  const rows = [...Array.from({ length: 8 }, (_, i) => amRow(i, i < lifted)), kRow(0), kRow(1)];
  writeJsonl(join(dir, 'suite', 'queries.hub.jsonl'), rows.map(r => r.query));
  for (const cond of CONDS) {
    writeJsonl(join(dir, 'out', `candidates.hub.${cond}.jsonl`), rows.map(r => ({ ...r.cand, cond })));
    writeJsonl(join(dir, 'out', `final.hub.${cond}.jsonl`), rows.map(r => ({ ...r.fin, cond })));
  }
}
const tmpLeftovers = (dir) => readdirSync(join(dir, 'out')).filter(f => f.startsWith('report.md.tmp'));

// ---- I1: a degenerate (zero) pilot SD must not become "N=0, within budget" -------------

test('I1 power.mjs: zero pilot SD yields no N and never a within-budget "yes"', () => {
  const dir = sandbox(['power.mjs']);
  try {
    fixture(dir, { lifted: 0 });
    const r = run(dir, 'power.mjs');
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(join(dir, 'suite', 'POWER.md'), 'utf8');

    // the cap must be derivable, otherwise this fixture would not exercise the leak at all
    assert.match(md, /\| hub \| 8 \| \d+ \| [\d.]+ \| \d+ \|/, 'pass-1 cap row is present');
    // the N cell is not 0 and not a number
    assert.match(md, /\| hub \| authored \| candidate Δrecall@30\(doc\) rrf3−rrf2 \|[^\n]*\| n\/a \| pilot SD is exactly 0/);
    assert.match(md, /\| hub \| authored \| rerank ΔnDCG@10 fixed-pool \|[^\n]*\| n\/a \| pilot SD is exactly 0/);
    // the budget verdict must say so rather than "yes"
    assert.match(md, /\| hub \| authored \| candidate \| n\/a \| \*\*not estimable\*\* — no N to compare \|/);
    assert.match(md, /\| hub \| authored \| rerank \| n\/a \| \*\*not estimable\*\* — no N to compare \|/);
    assert.ok(!/yes \(0 ≤/.test(md), 'N=0 must never be reported as within budget');
    assert.ok(!/\| 0 \|\s*$/m.test(md), 'no row reports N = 0');
    // same leak on the K row: a degenerate SD used to read as "within the frozen holdout"
    assert.match(md, /\| hub \| authored \(oracle\) \| K Δhit@5 \| n\/a \(one-sided\) \|[^\n]*not estimable/);
    assert.ok(!/K Δhit@5 \|[^\n]*within the frozen holdout/.test(md), 'a degenerate K SD must not read as within the holdout');
  } finally { rmSync(dirname(dir), { recursive: true, force: true }); }
});

test('I1 power.mjs: a non-degenerate SD still produces a numeric N (the guard is not a blanket)', () => {
  const dir = sandbox(['power.mjs']);
  try {
    fixture(dir, { lifted: 4 });
    const r = run(dir, 'power.mjs');
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(join(dir, 'suite', 'POWER.md'), 'utf8');
    const row = md.split('\n').find(l => l.startsWith('| hub | authored | candidate |'));
    assert.ok(row, 'candidate budget row present');
    assert.match(row, /\| hub \| authored \| candidate \| \d+ \|/, 'N is a number, not n/a');
    assert.ok(!/not estimable/.test(row), row);
  } finally { rmSync(dirname(dir), { recursive: true, force: true }); }
});

// ---- I5: a failed gate must not leave a fresh-looking out/report.md --------------------

test('I5 report.mjs: exit-17 gate leaves the previous report.md untouched and no temp file', () => {
  const dir = sandbox(['report.mjs']);
  try {
    const out = join(dir, 'out', 'report.md');
    writeFileSync(out, 'STALE REPORT FROM AN EARLIER RUN\n');
    const old = new Date('2020-01-02T03:04:05Z');
    utimesSync(out, old, old);
    const before = statSync(out).mtimeMs;

    const r = run(dir, 'report.mjs');                       // no suite/, no out/candidates -> exit 17
    assert.equal(r.status, 17, r.stderr);
    assert.match(r.stderr, /REPORT_INPUT_MISSING/);
    assert.equal(readFileSync(out, 'utf8'), 'STALE REPORT FROM AN EARLIER RUN\n', 'stale report must not be overwritten');
    assert.equal(statSync(out).mtimeMs, before, 'a failed run must not refresh report.md\'s mtime');
    assert.deepEqual(tmpLeftovers(dir), [], 'the temp file must be removed on failure');
  } finally { rmSync(dirname(dir), { recursive: true, force: true }); }
});

test('I5 report.mjs: when the gates pass the report is renamed into place', () => {
  const dir = sandbox(['report.mjs']);
  try {
    fixture(dir, { lifted: 4 });
    const out = join(dir, 'out', 'report.md');
    writeFileSync(out, 'STALE REPORT FROM AN EARLIER RUN\n');
    const r = run(dir, 'report.mjs');
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(out, 'utf8');
    assert.ok(md.startsWith('# graph-role evaluation report'), md.slice(0, 80));
    assert.ok(!md.includes('STALE'), 'the stale content is gone');
    assert.deepEqual(tmpLeftovers(dir), [], 'no temp file survives a successful run');
  } finally { rmSync(dirname(dir), { recursive: true, force: true }); }
});
