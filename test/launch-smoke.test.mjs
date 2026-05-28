// Regression for the v3.5.0 entry-point bug: the built server MUST boot main()
// when launched directly (as npx/bin does), not only when imported. v3.5.0 gated
// main() behind `process.argv[1] === fileURLToPath(import.meta.url)`, which is
// false under a symlinked bin path, so main() silently skipped and the MCP client
// could not connect (-32000). This test launches the built entry as a child
// process and asserts it reaches main()'s first log line.
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');
const dir = mkdtempSync(join(tmpdir(), 'ragmem-launch-'));

const child = spawn(process.execPath, [entry], {
  // Bogus model => initializeEmbeddingModel fails gracefully; we only need to see
  // that main() started (the "Initializing" line prints before model load).
  env: { ...process.env, DB_FILE_PATH: join(dir, 'l.db'), EMBEDDING_MODEL: '__nonexistent_model__' },
  stdio: ['ignore', 'ignore', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

const MARKER = 'Initializing RAG Knowledge Graph';
const booted = await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (stderr.includes(MARKER)) { clearInterval(timer); resolve(true); }
  }, 100);
  setTimeout(() => { clearInterval(timer); resolve(stderr.includes(MARKER)); }, 8000);
});

child.kill('SIGKILL');
rmSync(dir, { recursive: true, force: true });

if (booted) {
  console.log('  OK: server boots main() on direct launch');
  console.log('LAUNCH OK');
  process.exit(0);
} else {
  console.error('  FAIL: server did not boot main() on direct launch (entry-point guard regression)');
  console.error('  stderr head:', stderr.slice(0, 300));
  console.log('LAUNCH FAILED');
  process.exit(1);
}
