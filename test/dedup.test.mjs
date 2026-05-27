// #2: identical content short-circuits (skipped=true, no re-embed); changed
// content re-syncs; partial state (missing embeddings) does NOT short-circuit.
import { writeFileSync } from 'fs';
import { join } from 'path';
import { makeManager, installFakeEmbedder, assert } from './helpers/engine-test-db.mjs';

const { manager, dir, cleanup } = await makeManager();
try {
  const counter = installFakeEmbedder(manager);
  const file = join(dir, 'doc.txt');
  writeFileSync(file, 'alpha bravo charlie delta.', 'utf-8');

  // 1) First sync.
  const first = await manager.syncDocumentFromFile(file, 'doc1', {});
  assert(!first.skipped && first.embeddedChunks > 0, `first sync runs (embedded ${first.embeddedChunks})`);

  // 2) Same content -> skipped, no embedding work.
  counter.calls = 0;
  const second = await manager.syncDocumentFromFile(file, 'doc1', {});
  assert(second.skipped === true, 'unchanged content short-circuits (skipped=true)');
  assert(second.reason === 'unchanged', 'skip reason is "unchanged"');

  // 3) Changed content -> re-syncs (not skipped).
  writeFileSync(file, 'alpha bravo charlie delta ECHO.', 'utf-8');
  const third = await manager.syncDocumentFromFile(file, 'doc1', {});
  assert(third.skipped !== true && third.embeddedChunks > 0, 'changed content re-syncs');

  // 4) Partial state: drop vec embeddings but keep chunk_metadata + same hash.
  const db = manager.db;
  db.exec('DELETE FROM chunks'); // remove all vector rows (simulate partial/failed prior sync)
  const fourth = await manager.syncDocumentFromFile(file, 'doc1', {});
  assert(fourth.skipped !== true, 'incomplete embeddings (hash match) does NOT short-circuit');
  const reEmb = db.prepare(
    'SELECT count(*) AS n FROM chunks c JOIN chunk_metadata m ON c.rowid = m.rowid WHERE m.document_id = ?'
  ).get('doc1').n;
  assert(reEmb > 0, 'partial-state recovery re-embeds chunks');
} finally {
  cleanup();
}
console.log(process.exitCode ? 'DEDUP FAILED' : 'DEDUP OK');
