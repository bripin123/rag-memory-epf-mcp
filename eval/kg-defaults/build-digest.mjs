// kg-relation-evidence C7.1 / C7.3: one definition of "which build ran", shared by the C7.3 snapshot and
// the C7.1 parity producer and keyed on by the C7.1 compare's same-build refusal. The ESM entry loads
// other compiled modules, so hashing the entry file alone cannot tell two builds apart when only a
// sub-module differs. build_digest = SHA-256 over every .js/.mjs file under the entry's directory,
// sorted by POSIX relative path, each contributing its relative path, byte length and bytes. No absolute
// paths and no mtimes go in, so the same file set in another directory gives the same digest.
// entry_sha256 (the entry file alone) is kept under its own name and is not a build identity.
// usage (CLI): node eval/kg-defaults/build-digest.mjs <dist/index.js>
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXEC = /\.(js|mjs)$/;

export function buildIdentity(entry) {
  const entryPath = resolve(entry);
  const root = dirname(entryPath);
  const files = [];
  const walk = (dir, rel) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(join(dir, d.name), r);
      else if (d.isFile()) { if (EXEC.test(d.name)) files.push(r); }
      // a link or special file could point anywhere, so the digest would not name the bytes that run
      else if (EXEC.test(d.name) || d.isSymbolicLink()) throw new Error(`build-digest: refusing non-regular entry ${r}`);
    }
  };
  walk(root, '');
  if (files.length === 0) throw new Error(`build-digest: no .js/.mjs files under ${root}`);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash('sha256').update('kg-build-digest/1\0');
  for (const r of files) {
    const bytes = readFileSync(join(root, ...r.split('/')));
    h.update(`${r}\0${bytes.length}\0`).update(bytes);
  }
  return { build_digest: h.digest('hex'), build_files: files.length,
           entry_sha256: createHash('sha256').update(readFileSync(entryPath)).digest('hex') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entry = process.argv[2];
  if (!entry) { console.error('usage: build-digest.mjs <dist/index.js>'); process.exit(2); }
  console.log(JSON.stringify(buildIdentity(entry)));
}
