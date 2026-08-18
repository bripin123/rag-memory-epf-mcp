// Pure tests for Task 5b: post-hoc pure-vector channel runner, sleep-outlier scanner,
// MANIFEST + deterministic gzip packaging. No DB, no engine import — tmp-dir fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { orderByDistance } from '../eval/graph-role/lib/purevec.mjs';
import {
  CONDS, CORPUS_ORDER, expectedFiles, pairsFromFilenames,
  collectMs, outlierRows, buildManifest, gzipDeterministic, readDriverLog, parseJsonlTolerant,
} from '../eval/graph-role/lib/manifest.mjs';
import { sha256File } from '../eval/graph-role/lib/freeze.mjs';

test('orderByDistance: sorts by distance asc, ties by chunk_id asc, returns ids', () => {
  // c2 precedes c1 in the input despite the tie, so a stable sort with no tie-break would keep
  // c2 before c1 — this only passes if the tie-break (chunk_id asc) actually runs.
  const rows = [
    { chunk_id: 'c3', distance: 0.5 },
    { chunk_id: 'c2', distance: 0.2 },
    { chunk_id: 'c1', distance: 0.2 },
    { chunk_id: 'c4', distance: 0.9 },
  ];
  assert.deepEqual(orderByDistance(rows), ['c1', 'c2', 'c3', 'c4']);
});

test('collectMs: finds ms/*_ms at any depth in candidates- and final-shaped literals', () => {
  const candidatesShaped = {
    id: 'hub-K-1', class: 'K', split: 'dev', cond: 'real', embed_ms: 736, seam_ms: 7,
    seeds: [{ name: 'x', sim: 0.55 }],
    channels: {
      vector: { chunk10: ['a'], chunk30: ['a'], chunk100: ['a'], doc10: ['a'], doc30: ['a'], doc100: ['a'], ms: 11 },
      fts: { chunk10: [], chunk30: [], chunk100: [], doc10: [], doc30: [], doc100: [], ms: 3 },
    },
    reach: { chunks: 1, docs_n: 1 }, fallback: 0, unfrozen: false,
  };
  assert.deepEqual(collectMs(candidatesShaped).slice().sort((a, b) => a - b), [3, 7, 11, 736]);

  const finalShaped = {
    id: 'hub-K-1', class: 'K', split: 'dev', cond: 'real',
    off: { top10: [{ chunk_id: 'x', vs: 0.5 }], ms: 11 },
    on: { top10: [{ chunk_id: 'x', vs: 0.5 }], ms: 12 },
    fixedpool_rerank: { base: ['x'], with_graph: ['x'], pool_n: 30, ms: 40 },
    mode: 'graph', cold: { ms: 900, first: true }, unfrozen: false,
  };
  assert.deepEqual(collectMs(finalShaped).slice().sort((a, b) => a - b), [11, 12, 40, 900]);
});

test('outlierRows: strictly greater than threshold; ms:30000 at threshold 30000 is not an outlier', () => {
  const rows = [
    { embed_ms: 100, channels: { vector: { ms: 200 } } },   // max 200 - not an outlier
    { embed_ms: 30000, channels: { vector: { ms: 1 } } },   // max 30000 - not strictly greater - not an outlier
    { embed_ms: 30001, channels: { vector: { ms: 1 } } },   // max 30001 - outlier
  ];
  const { n, max_ms } = outlierRows(rows, 30000);
  assert.equal(n, 1);
  assert.equal(max_ms, 30001);
});

test('pairsFromFilenames: parses candidates/final/purevec names, ignores MANIFEST/logs/.gz', () => {
  const names = [
    'candidates.hub.shuffled-r10.jsonl',
    'purevec.hub.jsonl',
    'MANIFEST.json',
    'log.candidates.hub.shuffled-r10.txt',
    'final.hub.real.jsonl.gz',
  ];
  assert.deepEqual(pairsFromFilenames(names), [
    { corpus: 'hub', cond: 'shuffled-r10', runner: 'candidates' },
    { corpus: 'hub', cond: 'real', runner: 'purevec' },
  ]);
});

test('expectedFiles: 165 names, 27 conditions per corpus, driver order', () => {
  assert.equal(CONDS.length, 27);
  assert.equal(CONDS[0], 'real');
  assert.equal(CONDS[1], 'shuffled-r0');
  assert.equal(CONDS[20], 'shuffled-r19');
  assert.equal(CONDS[21], 'typeshuf-r0');
  assert.equal(CONDS[25], 'typeshuf-r4');
  assert.equal(CONDS[26], 'random');
  assert.deepEqual(CORPUS_ORDER, ['hub', 'uap', 'hal']);

  const files = expectedFiles();
  assert.equal(files.length, 165);
  assert.equal(new Set(files).size, 165, 'no duplicate names');
  // driver order: corpus-major, cond in CONDS order, candidates before final per step
  assert.equal(files[0], 'candidates.hub.real.jsonl');
  assert.equal(files[1], 'final.hub.real.jsonl');
  assert.equal(files[2], 'candidates.hub.shuffled-r0.jsonl');
  assert.equal(files[53], 'final.hub.random.jsonl');
  assert.equal(files[54], 'candidates.uap.real.jsonl');
  assert.equal(files[107], 'final.uap.random.jsonl');
  assert.equal(files[108], 'candidates.hal.real.jsonl');
  assert.equal(files[161], 'final.hal.random.jsonl');
  assert.deepEqual(files.slice(162), ['purevec.hub.jsonl', 'purevec.uap.jsonl', 'purevec.hal.jsonl']);
});

test('buildManifest: rows/bytes/sha256, complete=false + missing, reruns pass-through, files sorted by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gr-t5b-'));
  try {
    // written out of alphabetical order on purpose, to prove buildManifest sorts by name
    writeFileSync(join(dir, 'final.hub.real.jsonl'), '{"b":1}\n\n');                 // trailing blank line not counted -> 1 row
    writeFileSync(join(dir, 'log.candidates.hub.real.txt'), 'log text\n');
    writeFileSync(join(dir, 'candidates.hub.real.jsonl'), '{"a":1}\n{"a":2}\n');      // 2 rows

    const reruns = [{ corpus: 'hub', cond: 'real', runner: 'candidates', reason: 'sleep', rerun_at: '2026-08-18T09:00:00Z' }];
    const fixedNow = new Date('2026-08-18T10:00:00.000Z');
    const manifest = buildManifest({ dir, reruns, extra: { note: 'x' }, now: fixedNow });

    assert.equal(manifest.generated_at, '2026-08-18T10:00:00.000Z');
    assert.deepEqual(manifest.files.map(f => f.file), ['candidates.hub.real.jsonl', 'final.hub.real.jsonl', 'log.candidates.hub.real.txt']);

    const cfile = manifest.files.find(f => f.file === 'candidates.hub.real.jsonl');
    assert.equal(cfile.kind, 'candidates');
    assert.equal(cfile.rows, 2);
    assert.equal(cfile.bytes, statSync(join(dir, 'candidates.hub.real.jsonl')).size);
    assert.equal(cfile.sha256, sha256File(join(dir, 'candidates.hub.real.jsonl')));

    const ffile = manifest.files.find(f => f.file === 'final.hub.real.jsonl');
    assert.equal(ffile.kind, 'final');
    assert.equal(ffile.rows, 1);

    const lfile = manifest.files.find(f => f.file === 'log.candidates.hub.real.txt');
    assert.equal(lfile.kind, 'log');
    assert.equal(lfile.rows, null);

    assert.equal(manifest.expected.total, 165);
    assert.equal(manifest.present, 2);
    assert.equal(manifest.missing.length, 163);
    assert.ok(!manifest.missing.includes('candidates.hub.real.jsonl'));
    assert.ok(!manifest.missing.includes('final.hub.real.jsonl'));
    assert.ok(manifest.missing.includes('final.uap.real.jsonl'));
    assert.equal(manifest.complete, false);
    assert.deepEqual(manifest.reruns, reruns);
    assert.equal(manifest.note, 'x');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gzipDeterministic: byte-identical across calls; MTIME/OS bytes normalized; round-trips', () => {
  const buf = Buffer.from('graph-role evaluation packaging payload\n'.repeat(50), 'utf8');
  const a = gzipDeterministic(buf);
  const b = gzipDeterministic(buf);
  assert.ok(a.equals(b), 'two calls must be byte-identical');
  assert.equal(a[4], 0); assert.equal(a[5], 0); assert.equal(a[6], 0); assert.equal(a[7], 0);
  assert.equal(a[9], 0x03);
  assert.ok(gunzipSync(a).equals(buf), 'round-trips to the original bytes');
});

test('readDriverLog: start/end/steps/nonzero from a run-all.sh-shaped log', () => {
  const text = [
    'START 2026-08-18T07:25:00Z',
    'candidates hub real EXIT:0',
    'final hub real EXIT:0',
    'candidates hub shuffled-r0 EXIT:1',
    'final hub shuffled-r0 EXIT:0',
    'END 2026-08-18T09:00:00Z',
    '',
  ].join('\n');
  const d = readDriverLog(text);
  assert.equal(d.start, '2026-08-18T07:25:00Z');
  assert.equal(d.end, '2026-08-18T09:00:00Z');
  assert.equal(d.steps, 4);
  assert.deepEqual(d.nonzero, ['candidates hub shuffled-r0 EXIT:1']);
});

test('readDriverLog: end is null when the driver has not finished yet', () => {
  const d = readDriverLog('START 2026-08-18T07:25:00Z\ncandidates hub real EXIT:0\n');
  assert.equal(d.start, '2026-08-18T07:25:00Z');
  assert.equal(d.end, null);
  assert.equal(d.steps, 1);
  assert.deepEqual(d.nonzero, []);
});

// parseJsonlTolerant: the scan-outliers.mjs parse/recovery loop, extracted so the exact edge case
// the task exists for (a sleep-interrupted, half-written last line) is unit-tested, not just
// hand-traced. Empty lines (including the one a trailing newline produces) are silently ignored,
// same as before extraction -- they never reach JSON.parse and never appear in `skipped`.

test('parseJsonlTolerant: normal file with trailing newline -> all rows, no skips', () => {
  const text = '{"a":1}\n{"a":2}\n{"a":3}\n';
  const { rows, skipped } = parseJsonlTolerant(text);
  assert.deepEqual(rows, [{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.deepEqual(skipped, []);
});

test('parseJsonlTolerant: truncated last line -> rows minus the partial one, skipped has one last:true entry', () => {
  // No trailing newline: the last "line" is a half-written JSON object, exactly what a writer
  // interrupted mid-append (e.g. by the Mac sleeping) leaves behind.
  const text = '{"a":1}\n{"a":2}\n{"a":3';
  const { rows, skipped } = parseJsonlTolerant(text);
  assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].line, 3);
  assert.equal(skipped[0].last, true);
  assert.equal(typeof skipped[0].error, 'string');
  assert.ok(skipped[0].error.length > 0);
});

test('parseJsonlTolerant: corrupted middle line -> skipped with last:false, later rows still parsed', () => {
  const text = '{"a":1}\n{not valid json\n{"a":3}\n';
  const { rows, skipped } = parseJsonlTolerant(text);
  assert.deepEqual(rows, [{ a: 1 }, { a: 3 }]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].line, 2);
  assert.equal(skipped[0].last, false);
  assert.equal(typeof skipped[0].error, 'string');
  assert.ok(skipped[0].error.length > 0);
});

console.log('eval-graph-role-t5b: test file loaded');
