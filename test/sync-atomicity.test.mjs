// #1: a sync that fails during embedding (model down) must leave the previously
// synced document fully intact — no partial state (old doc deleted but new doc
// half-embedded).
import { writeFileSync } from 'fs';
import { join } from 'path';
import { makeManager, installFakeEmbedder, simulateModelDown, assert } from './helpers/engine-test-db.mjs';

const { manager, dir, cleanup } = await makeManager();
try {
  installFakeEmbedder(manager);
  const file = join(dir, 'doc.txt');
  const original = 'alpha bravo charlie. '.repeat(50); // multi-chunk-ish content
  writeFileSync(file, original, 'utf-8');

  // 1) Initial successful sync.
  const first = await manager.syncDocumentFromFile(file, 'doc1', {});
  assert(first.embeddedChunks > 0, `initial sync embedded ${first.embeddedChunks} chunks`);

  // Snapshot the stored state.
  const db = manager.db; // private at compile time, plain field at runtime
  const beforeContent = db.prepare('SELECT content FROM documents WHERE id = ?').get('doc1').content;
  const beforeChunks = db.prepare('SELECT count(*) AS n FROM chunk_metadata WHERE document_id = ?').get('doc1').n;
  const beforeEmb = db.prepare(
    'SELECT count(*) AS n FROM chunks c JOIN chunk_metadata m ON c.rowid = m.rowid WHERE m.document_id = ?'
  ).get('doc1').n;
  assert(beforeChunks > 0 && beforeChunks === beforeEmb, `before: ${beforeChunks} chunks all embedded`);

  // 2) Model goes down, content CHANGES (so dedup would not short-circuit anyway).
  simulateModelDown(manager);
  writeFileSync(file, original + ' delta echo foxtrot.', 'utf-8');

  let threw = false;
  try {
    await manager.syncDocumentFromFile(file, 'doc1', {});
  } catch (e) {
    threw = true;
  }
  assert(threw, 'sync with model down throws');

  // 3) Old document must be byte-identical and fully embedded — no partial state.
  const afterContent = db.prepare('SELECT content FROM documents WHERE id = ?').get('doc1').content;
  const afterChunks = db.prepare('SELECT count(*) AS n FROM chunk_metadata WHERE document_id = ?').get('doc1').n;
  const afterEmb = db.prepare(
    'SELECT count(*) AS n FROM chunks c JOIN chunk_metadata m ON c.rowid = m.rowid WHERE m.document_id = ?'
  ).get('doc1').n;
  assert(afterContent === beforeContent, 'document content unchanged after failed sync');
  assert(afterChunks === beforeChunks, 'chunk count unchanged after failed sync');
  assert(afterEmb === beforeEmb, 'embedding count unchanged after failed sync (no partial state)');
} finally {
  cleanup();
}
console.log(process.exitCode ? 'ATOMICITY FAILED' : 'ATOMICITY OK');
