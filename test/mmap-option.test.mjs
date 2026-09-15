// SQLite mmap is opt-in from the next release (framework spec 2026-09-14-universal-mcp-config-design §11-2).
// Measured 2026-09-15 (Windows, Google Drive G:, WAL, mmap 256 MB): one writer + two readers ->
// 373,684 `database disk image is malformed` reads in 20 s; mmap 0 -> 0 errors; local disk -> 0
// either way. The framework opens one DB from several CLIs on synced folders, so the default is 0.
// RAG_MEMORY_MMAP_SIZE=<bytes> turns it back on. The APPLIED value (read back from SQLite after the
// pragma) is printed in the boot banner as `| mmap <n>`, which is what these cases assert — so a
// value SQLite refuses (compile-time cap) or a garbage value shows up as what actually happened.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');

function bootMmap(env) {
  return new Promise((res, rej) => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-mmap-'));
    const child = spawn(process.execPath, [entry], {
      cwd: dir,
      env: { ...process.env, RAG_MEMORY_NO_AUTOSTART: undefined, RAG_MEMORY_MODEL_CACHE_DIR: '/dev/null/rag-mmap-nope', DB_FILE_PATH: join(dir, 't.db'), RAG_MEMORY_MMAP_SIZE: undefined, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    const done = (fn) => { child.kill('SIGTERM'); child.once('exit', () => { rmSync(dir, { recursive: true, force: true }); fn(); }); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); rej(new Error('no banner within 20s\nstderr: ' + stderr.slice(-800))); }, 20000);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      const line = stderr.split('\n').find(l => l.includes('| db '));
      if (!line) return;
      clearTimeout(timer);
      const m = line.match(/\| mmap (\S+)/);
      done(() => m ? res(Number(m[1])) : rej(new Error('banner has no `| mmap <n>` field: ' + line)));
    });
    child.on('error', (e) => { clearTimeout(timer); rej(e); });
  });
}

assert.equal(await bootMmap({}), 0, 'default (unset) must apply mmap_size 0');
console.log('mmap: default 0 OK');
assert.equal(await bootMmap({ RAG_MEMORY_MMAP_SIZE: '1048576' }), 1048576, 'explicit bytes must be applied and read back');
console.log('mmap: explicit 1048576 OK');
assert.equal(await bootMmap({ RAG_MEMORY_MMAP_SIZE: 'abc' }), 0, 'garbage must fall back to 0');
console.log('mmap: garbage -> 0 OK');
assert.equal(await bootMmap({ RAG_MEMORY_MMAP_SIZE: '-5' }), 0, 'negative must fall back to 0');
console.log('mmap: negative -> 0 OK');

process.env.RAG_MEMORY_NO_AUTOSTART = '1'; // import the module without starting the stdio server
const mod = await import(new URL('../dist/index.js', import.meta.url).href);
assert.equal(typeof mod.parseMmapSize, 'function', 'dist/index.js must export parseMmapSize');
assert.equal(mod.parseMmapSize(undefined), 0);
assert.equal(mod.parseMmapSize(''), 0);
assert.equal(mod.parseMmapSize('268435456'), 268435456);
assert.equal(mod.parseMmapSize('12.9'), 12);
assert.equal(mod.parseMmapSize('nope'), 0);
assert.equal(mod.parseMmapSize('-1'), 0);
console.log('mmap: parser unit contract OK');
