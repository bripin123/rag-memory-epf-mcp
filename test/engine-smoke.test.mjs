// Verifies the testability seam: importing the built module does NOT boot the
// server (no hang), the class is exported, and a temp DB initializes cleanly.
import { makeManager, assert } from './helpers/engine-test-db.mjs';

const { manager, cleanup } = await makeManager();
try {
  const stats = await manager.getKnowledgeGraphStats();
  assert(stats && stats.entities && stats.entities.total === 0, 'fresh temp DB has 0 entities');
  assert(typeof stats.chunks === 'number', 'stats include chunk count');
} finally {
  cleanup();
}
console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE OK');
