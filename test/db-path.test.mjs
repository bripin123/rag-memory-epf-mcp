// DB path resolution contract (framework spec 2026-09-14-universal-mcp-config-design §11-1):
//   (1) a RELATIVE DB_FILE_PATH resolves against the server's working directory (process.cwd()),
//       NOT against the package install directory (pre-6.2 behaviour: under npx that was the npm
//       cache, so a relative value silently opened a database nobody could find — measured
//       2026-09-14 on 6.1.0 dist/index.js:83-88).
//   (2) an ABSOLUTE DB_FILE_PATH is used as-is (unchanged).
//   (3) UNSET keeps the documented default (`rag-memory.db` next to the server) — asserted through
//       the exported resolver only, so the test never writes a database into dist/.
// The spawned cases read the boot banner (`| db <path>`) on stderr, which main() prints from the
// same DB_FILE_PATH constant the engine opened. Temp cwd + temp DB only; the model cache dir is
// unwritable so the lazy loader fails fast with zero downloads (same trick as launch-smoke).
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');

function bootBanner(cwd, env) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry], {
      cwd,
      env: { ...process.env, RAG_MEMORY_NO_AUTOSTART: undefined, RAG_MEMORY_MODEL_CACHE_DIR: '/dev/null/rag-dbpath-nope', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // never leak DB_FILE_PATH from the outer environment into the "unset" scenario
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); rej(new Error('no banner within 20s\nstderr: ' + stderr.slice(-800))); }, 20000);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      const m = stderr.match(/\| db (.+?)(?: \| mmap \S+)?\n/);
      if (m) { clearTimeout(timer); child.kill('SIGTERM'); child.once('exit', () => res(m[1])); }
    });
    child.on('error', (e) => { clearTimeout(timer); rej(e); });
  });
}

// ---- (1) relative -> cwd ----------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'rag-dbpath-rel-'));
  // The engine does not create parent directories (better-sqlite3 refuses a missing directory);
  // in the framework the launcher creates `.memory/` — mirror that here.
  mkdirSync(join(dir, '.memory'), { recursive: true });
  const banner = await bootBanner(dir, { DB_FILE_PATH: join('.memory', 'rag-memory.db') });
  // realpath both sides: on macOS the temp dir is /var/... but a child's process.cwd() reports the
  // resolved /private/var/... — same directory, different spelling.
  assert.equal(realpathSync(banner), realpathSync(join(dir, '.memory', 'rag-memory.db')),
    `relative DB_FILE_PATH must resolve against cwd; banner said ${banner}`);
  assert.ok(existsSync(join(dir, '.memory', 'rag-memory.db')), 'the database must exist under cwd/.memory');
  rmSync(dir, { recursive: true, force: true });
  console.log('db-path: relative resolves against cwd OK');
}

// ---- (2) absolute -> as-is --------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'rag-dbpath-abs-'));
  const abs = join(dir, 'abs.db');
  const banner = await bootBanner(tmpdir(), { DB_FILE_PATH: abs });
  assert.equal(resolve(banner), resolve(abs), `absolute DB_FILE_PATH must be used as-is; banner said ${banner}`);
  rmSync(dir, { recursive: true, force: true });
  console.log('db-path: absolute used as-is OK');
}

// ---- (3) unset -> server dir default (resolver only; no DB written) ---------
{
  process.env.RAG_MEMORY_NO_AUTOSTART = '1'; // import the module without starting the stdio server
  const mod = await import(new URL('../dist/index.js', import.meta.url).href);
  assert.equal(typeof mod.resolveDbFilePath, 'function', 'dist/index.js must export resolveDbFilePath');
  const serverDir = `${sep}srv${sep}pkg${sep}dist`;
  assert.equal(mod.resolveDbFilePath(undefined, `${sep}work`, serverDir), join(serverDir, 'rag-memory.db'));
  assert.equal(mod.resolveDbFilePath('', `${sep}work`, serverDir), join(serverDir, 'rag-memory.db'));
  assert.equal(mod.resolveDbFilePath('x/y.db', `${sep}work`, serverDir), resolve(`${sep}work`, 'x/y.db'));
  assert.equal(mod.resolveDbFilePath(`${sep}abs${sep}z.db`, `${sep}work`, serverDir), `${sep}abs${sep}z.db`);
  console.log('db-path: resolver unit contract OK');
}
