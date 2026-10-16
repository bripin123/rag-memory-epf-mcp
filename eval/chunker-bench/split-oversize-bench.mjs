// kg-relation-evidence C6: encode-call count, wall time and peak RSS of chunkStructured on a
// blank-line-free accessibility-tree block, for one build and one size per process (so maxRSS belongs
// to this run). Invariants are checked on the measured output, so a fast wrong answer cannot pass.
// usage: node eval/chunker-bench/split-oversize-bench.mjs <dist dir> <size in codepoints> <out.json>
import { writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { get_encoding } from 'tiktoken';
import { accessibilityTree } from '../../test/helpers/oversize-corpus.mjs';

const [dist, sizeArg, out] = process.argv.slice(2);
if (!dist || !sizeArg || !out || existsSync(out)) { console.error('usage: split-oversize-bench.mjs <dist dir> <size cp> <out.json> (out must not exist)'); process.exit(2); }
const { chunkStructured } = await import(pathToFileURL(join(resolve(dist), 'src', 'chunkerC.js')).href);
const real = get_encoding('cl100k_base');
const calls = { encode: 0, decode: 0 };
const enc = { encode: (s) => { calls.encode++; return real.encode(s); }, decode: (t) => { calls.decode++; return real.decode(t); } };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const text = accessibilityTree(Number(sizeArg));
const t0 = process.hrtime.bigint();
const segs = chunkStructured(text, enc, 800);
const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
if (segs.map(s => s.text).join('') !== text) throw new Error('lossless violated');
let cursor = 0;
for (const s of segs) {
  if (s.start_pos !== cursor || s.end_pos !== cursor + [...s.text].length) throw new Error('offsets violated');
  if (real.encode(s.text).length > 800) throw new Error('token budget violated');
  cursor = s.end_pos;
}
writeFileSync(out, JSON.stringify({
  dist: resolve(dist), size_cp: [...text].length, text_sha256: sha(text), segments: segs.length,
  encode_calls: calls.encode, decode_calls: calls.decode, wall_ms: Math.round(wallMs * 10) / 10,
  max_rss_kb: process.resourceUsage().maxRSS,
  boundaries_sha256: sha(JSON.stringify(segs.map(s => [s.start_pos, s.end_pos]))), node: process.versions.node,
}, null, 2) + '\n');
