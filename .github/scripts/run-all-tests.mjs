// Runs every command of verify:invariants and verify:engine and reports ALL that fail.
// `npm test` chains them with && and stops at the first failure, which is right for the release
// gate but hides the rest: on a new machine each run then reveals one failure at a time.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts;
const commands = [scripts['verify:invariants'], scripts['verify:engine']]
  .flatMap(s => s.split(' && ')).map(s => s.trim()).filter(Boolean);

const failed = [];
for (const cmd of commands) {
  const t0 = Date.now();
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const ok = r.status === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${cmd}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (!ok) {
    failed.push(cmd);
    const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trimEnd().split('\n').slice(-40).join('\n');
    console.log(`---- last lines of ${cmd} (exit ${r.status}, signal ${r.signal})\n${tail}\n----`);
  }
}

console.log(`\n${commands.length - failed.length} of ${commands.length} test commands passed`);
if (failed.length) {
  console.log(`failed:\n${failed.map(c => `  ${c}`).join('\n')}`);
  process.exit(1);
}
