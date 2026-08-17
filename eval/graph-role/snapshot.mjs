// Makes .backup copies of the three corpora into eval/graph-role/dbs/ and records snapshot.json.
// Uses the sqlite3 CLI's `.backup` (Online Backup API; WAL-safe). Never opens the live DB for writing.
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPORA, EVAL_DIR, REPO_ROOT } from './lib/paths.mjs';
import { sha256File } from './lib/freeze.mjs';
mkdirSync(join(EVAL_DIR, 'dbs'), { recursive: true });
const engineCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim();
const snap = { taken_at: new Date().toISOString(), engine_commit: engineCommit, corpora: {} };
for (const c of Object.values(CORPORA)) {
  const before = statSync(c.live).mtimeMs;
  execFileSync('sqlite3', [c.live, `.backup '${c.copy}'`]);
  const after = statSync(c.live).mtimeMs;
  if (before !== after) { console.error(`SOURCE_MTIME_CHANGED ${c.label}`); process.exit(10); }
  snap.corpora[c.label] = { source: c.live, copy: c.copy, bytes: statSync(c.copy).size, sha256: sha256File(c.copy) };
  console.log(`${c.label}: ${snap.corpora[c.label].bytes} bytes sha256=${snap.corpora[c.label].sha256.slice(0, 12)}`);
}
writeFileSync(join(EVAL_DIR, 'snapshot.json'), JSON.stringify(snap, null, 2) + '\n');
