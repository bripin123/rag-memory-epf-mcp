// #2: identical content short-circuits (skipped=true, no re-embed); changed
// content re-syncs; identical content with MISSING/STALE vectors preserves the
// document/chunks/rowids and re-queues vectors only (v3.6 spec §5b M12 —
// pre-3.6 this path re-chunked the whole document).
import { writeFileSync } from 'fs';
import { join } from 'path';
import { makeManager, installFakeEmbedder, assert } from './helpers/engine-test-db.mjs';

const { manager, dir, cleanup } = await makeManager();
try {
  manager.embeddingsMode = 'lazy';
  const counter = installFakeEmbedder(manager);
  await manager.startReconciliation(); // fresh DB -> n/a, opens backfill eligibility
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
  assert(counter.calls === 0, 'unchanged skip performs zero inference');

  // 3) Changed content -> re-syncs (not skipped).
  writeFileSync(file, 'alpha bravo charlie delta ECHO.', 'utf-8');
  const third = await manager.syncDocumentFromFile(file, 'doc1', {});
  assert(third.skipped !== true && third.embeddedChunks > 0, 'changed content re-syncs');

  // 4) Stale/missing vectors + same hash: vector-only re-queue, chunks preserved.
  const db = manager.db;
  const rowidsBefore = db.prepare('SELECT rowid FROM chunk_metadata WHERE document_id = ? ORDER BY rowid').all('doc1').map(r => r.rowid);
  db.exec('DELETE FROM chunks'); // drop all vector rows (simulate stale invalidation)
  const fourth = await manager.syncDocumentFromFile(file, 'doc1', {});
  assert(fourth.skipped === true && fourth.reason === 'unchanged-revectorizing',
    `hash-match + missing vectors re-queues instead of re-chunking (got ${fourth.reason})`);
  assert(fourth.embedding_status === 'queued', 'revectorizing reports queued');
  const rowidsAfter = db.prepare('SELECT rowid FROM chunk_metadata WHERE document_id = ? ORDER BY rowid').all('doc1').map(r => r.rowid);
  assert(JSON.stringify(rowidsAfter) === JSON.stringify(rowidsBefore), 'chunk rowids preserved (no re-chunk churn)');

  // 5) The coordinator kick actually restores the vectors.
  await new Promise(r => setTimeout(r, 700));
  const reEmb = db.prepare(
    'SELECT count(*) AS n FROM chunks c JOIN chunk_metadata m ON c.rowid = m.rowid WHERE m.document_id = ?'
  ).get('doc1').n;
  assert(reEmb === rowidsBefore.length, `backfill restored all vectors (${reEmb}/${rowidsBefore.length})`);
} finally {
  cleanup();
}
console.log(process.exitCode ? 'DEDUP FAILED' : 'DEDUP OK');
