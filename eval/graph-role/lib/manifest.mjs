// Pure post-hoc packaging helpers for the graph-role evaluation harness: expected-file inventory
// (162 driver files + 3 purevec), ms-outlier detection (Mac-sleep timing pollution), MANIFEST.json
// shape, deterministic gzip, and run-all.log parsing. No engine/DB import at module top level —
// stays importable from plain `node --test`, same as lib/rrf.mjs and lib/prng.mjs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { sha256File } from './freeze.mjs';

// Same order as run-all.sh: real, shuffled-r0..19, typeshuf-r0..4, random = 27.
export const CONDS = [
  'real',
  ...Array.from({ length: 20 }, (_, i) => `shuffled-r${i}`),
  ...Array.from({ length: 5 }, (_, i) => `typeshuf-r${i}`),
  'random',
];
export const CORPUS_ORDER = ['hub', 'uap', 'hal'];

// 165 names in the driver's order: for each corpus, for each cond, candidates then final (162),
// then the 3 post-hoc purevec files (one per corpus, real copy only).
export function expectedFiles() {
  const out = [];
  for (const corpus of CORPUS_ORDER) {
    for (const cond of CONDS) { out.push(`candidates.${corpus}.${cond}.jsonl`); out.push(`final.${corpus}.${cond}.jsonl`); }
  }
  for (const corpus of CORPUS_ORDER) out.push(`purevec.${corpus}.jsonl`);
  return out;
}

// candidates.<c>.<cond>.jsonl / final.<c>.<cond>.jsonl / purevec.<c>.jsonl -> {corpus, cond, runner}.
// Ignores MANIFEST.json, log.*.txt and *.gz.
export function pairsFromFilenames(names) {
  const out = [];
  for (const name of names) {
    if (name === 'MANIFEST.json') continue;
    if (name.startsWith('log.')) continue;
    if (name.endsWith('.gz')) continue;
    if (!name.endsWith('.jsonl')) continue;
    const parts = name.slice(0, -'.jsonl'.length).split('.');
    if (parts[0] === 'purevec' && parts.length === 2) out.push({ corpus: parts[1], cond: 'real', runner: 'purevec' });
    else if ((parts[0] === 'candidates' || parts[0] === 'final') && parts.length === 3) out.push({ corpus: parts[1], cond: parts[2], runner: parts[0] });
  }
  return out;
}

// Recursively collects every numeric value found under a key `ms` or ending `_ms`, at any depth,
// across plain objects/arrays (the shape JSON.parse produces for candidates/final/purevec rows).
function collectMsInto(value, key, out) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) { for (const v of value) collectMsInto(v, null, out); return; }
  if (typeof value === 'object') { for (const [k, v] of Object.entries(value)) collectMsInto(v, k, out); return; }
  if ((key === 'ms' || (key && key.endsWith('_ms'))) && typeof value === 'number') out.push(value);
}
export function collectMs(obj) { const out = []; collectMsInto(obj, null, out); return out; }

// Rows whose max ms is strictly greater than threshold. max_ms is the greatest ms value seen across
// every row scanned (which, whenever n > 0, is necessarily the max of some outlier row).
export function outlierRows(rows, threshold) {
  let n = 0, max_ms = 0;
  for (const row of rows) {
    const vals = collectMs(row);
    if (!vals.length) continue;
    const rowMax = Math.max(...vals);
    if (rowMax > max_ms) max_ms = rowMax;
    if (rowMax > threshold) n++;
  }
  return { n, max_ms };
}

// Parses JSONL text one line at a time, skipping (not throwing on) any line JSON.parse rejects --
// in particular a half-written last line, the shape a concurrent writer leaves behind when
// interrupted mid-append (e.g. by the Mac sleeping). Empty lines, including the one a trailing
// newline produces, are not attempted and never appear in `skipped`. `line` is 1-based, matching
// the SKIP notes scan-outliers.mjs used to print inline before this loop was extracted here.
export function parseJsonlTolerant(text) {
  const lines = text.split('\n');
  const rows = []; const skipped = [];
  lines.forEach((line, idx) => {
    if (!line) return;
    try { rows.push(JSON.parse(line)); }
    catch (e) { skipped.push({ line: idx + 1, last: idx === lines.length - 1, error: e instanceof Error ? e.message : String(e) }); }
  });
  return { rows, skipped };
}

const DATA_KINDS = new Set(['candidates', 'final', 'purevec']);
function kindOf(file) {
  if (file.endsWith('.jsonl')) { const prefix = file.split('.')[0]; return DATA_KINDS.has(prefix) ? prefix : 'other'; }
  if (file.endsWith('.gz')) return 'gz';
  if (file.startsWith('log.') && file.endsWith('.txt')) return 'log';
  return 'other';
}
const countRows = (text) => text.split('\n').filter(l => l.length > 0).length;

// Scans `dir` (flat, non-recursive — that's how out/ is laid out) and builds the MANIFEST.json shape.
// Pure w.r.t. the filesystem: no network, no DB, no child process — just fs reads of files the caller
// already produced. `now` is a parameter (defaulting to `new Date()`) so tests can pin generated_at.
export function buildManifest({ dir, reruns = [], extra = {}, now = new Date() }) {
  const names = readdirSync(dir).filter(f => f !== 'MANIFEST.json').sort();
  const files = names.map((file) => {
    const p = join(dir, file);
    const bytes = statSync(p).size;
    const sha256 = sha256File(p);
    const kind = kindOf(file);
    const rows = file.endsWith('.jsonl') ? countRows(readFileSync(p, 'utf8')) : null;
    const rec = { file, kind, rows, bytes, sha256 };
    if (kind === 'gz') rec.of = file.slice(0, -'.gz'.length);
    return rec;
  });
  const present = new Set(names);
  const expected = expectedFiles();
  const missing = expected.filter(f => !present.has(f));
  return {
    generated_at: now.toISOString(),
    files,
    expected: { total: expected.length },
    present: expected.length - missing.length,
    missing,
    complete: missing.length === 0,
    reruns,
    ...extra,
  };
}

// buf -> gzip bytes that are identical across machines/times: zlib's own header embeds MTIME (bytes
// 4-7) and OS (byte 9), which otherwise make two gzips of the same content byte-different. Zero both.
export function gzipDeterministic(buf) {
  const out = gzipSync(buf, { level: 9 });
  out[4] = 0; out[5] = 0; out[6] = 0; out[7] = 0;
  out[9] = 0x03;
  return out;
}

// Parses a run-all.sh-shaped driver log: "START <iso>", "<runner> <corpus> <cond> EXIT:<code>" steps,
// "END <iso>". end is null while the driver is still running (no END line yet).
export function readDriverLog(text) {
  let start = null, end = null, steps = 0; const nonzero = [];
  for (const line of text.split('\n')) {
    let m = line.match(/^START (.+)$/); if (m) { start = m[1]; continue; }
    m = line.match(/^END (.+)$/); if (m) { end = m[1]; continue; }
    m = line.match(/^\S+ \S+ \S+ EXIT:(-?\d+)$/); if (m) { steps++; if (Number(m[1]) !== 0) nonzero.push(line); }
  }
  return { start, end, steps, nonzero };
}
