// Writes out/MANIFEST.json (R12 amendment: raw out/*.jsonl + out/log.*.txt stay git-ignored;
// the repo keeps the manifest + gzipped final.*.jsonl.gz/purevec.*.jsonl.gz). No DB — reads
// finished JSONL, hashes bytes, shells out only to `git rev-parse HEAD`.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { EVAL_DIR, REPO_ROOT } from './lib/paths.mjs';
import { buildManifest, gzipDeterministic, readDriverLog } from './lib/manifest.mjs';

const args = process.argv.slice(2); const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dir = get('--dir', join(EVAL_DIR, 'out'));
const rerunsPath = get('--reruns', null);
const doGzip = args.includes('--gzip');
const allowIncomplete = args.includes('--allow-incomplete');

const reruns = rerunsPath ? (JSON.parse(readFileSync(rerunsPath, 'utf8')) ?? []) : [];

// Write the .gz files to disk first (skip candidates); buildManifest's own directory scan then
// picks them up like any other file and classifies them kind:'gz' with an `of` field.
if (doGzip) {
  const names = readdirSync(dir).filter(f => f.endsWith('.jsonl') && (f.startsWith('final.') || f.startsWith('purevec.')));
  for (const name of names) {
    const buf = readFileSync(join(dir, name));
    writeFileSync(join(dir, `${name}.gz`), gzipDeterministic(buf));
  }
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const driverLogPath = join(dir, 'run-all.log');
const driver = existsSync(driverLogPath) ? readDriverLog(readFileSync(driverLogPath, 'utf8')) : { start: null, end: null, steps: 0, nonzero: [] };

const manifest = buildManifest({
  dir, reruns,
  extra: {
    head, node: process.version, driver,
    load_note: 'measured with light concurrent load (subagent editing only; no builds/tests during the run)',
    vector_channel_label: 'product base ranking (no graph): hybridSearch(q,K,false) = vector ∨ FTS-boost',
    purevec_channel_label: 'pure vector: raw chunks vec scan on the query embedding, k=100',
  },
});

writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');

const ok = manifest.complete && driver.end !== null && driver.nonzero.length === 0;
if (ok || allowIncomplete) {
  console.error(`MANIFEST ${ok ? 'complete' : 'incomplete (--allow-incomplete)'} present=${manifest.present}/${manifest.expected.total} driver_end=${driver.end !== null} nonzero=${driver.nonzero.length}`);
  process.exit(0);
}
console.error(`MANIFEST_INCOMPLETE present=${manifest.present}/${manifest.expected.total} missing=${manifest.missing.length} driver_end=${driver.end !== null} nonzero=${driver.nonzero.length}`);
process.exit(14);
