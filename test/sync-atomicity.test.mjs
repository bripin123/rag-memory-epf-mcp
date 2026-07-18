// syncDocumentFromFile contract pair (v3.6 spec §5b):
//   A) model READY but inference fails mid-sync -> throw, previously synced
//      document left fully intact (v3.5.0 atomicity, unchanged).
//   B) model NOT READY -> intentional lazy sync: new content + chunks + FTS
//      stored in one transaction, zero vectors, embedding_status "queued".
import { writeFileSync } from 'fs';
import { join } from 'path';
import { makeManager, installFakeEmbedder, simulateModelDown, assert } from './helpers/engine-test-db.mjs';

const { manager, dir, cleanup } = await makeManager();
try {
  const counter = installFakeEmbedder(manager);
  const file = join(dir, 'doc.txt');
  const original = 'alpha bravo charlie. '.repeat(50); // multi-chunk-ish content
  writeFileSync(file, original, 'utf-8');

  // 1) Initial successful sync.
  const first = await manager.syncDocumentFromFile(file, 'doc1', {});
  assert(first.embeddedChunks > 0, `initial sync embedded ${first.embeddedChunks} chunks`);
  assert(first.embedding_status === 'embedded', 'ready sync reports embedded');

  const db = manager.db; // private at compile time, plain field at runtime
  const beforeContent = db.prepare('SELECT content FROM documents WHERE id = ?').get('doc1').content;
  const beforeChunks = db.prepare('SELECT count(*) AS n FROM chunk_metadata WHERE document_id = ?').get('doc1').n;
  const beforeEmb = db.prepare(
    'SELECT count(*) AS n FROM chunks c JOIN chunk_metadata m ON c.rowid = m.rowid WHERE m.document_id = ?'
  ).get('doc1').n;
  assert(beforeChunks > 0 && beforeChunks === beforeEmb, `before: ${beforeChunks} chunks all embedded`);

  // ---- Contract A: READY + inference failure -> throw, old doc intact ------
  manager.gate.embedFn = async () => { throw new Error('inference blew up mid-sync'); };
  manager.embeddingCache = new Map();
  writeFileSync(file, original + ' delta echo foxtrot.', 'utf-8');

  let threw = false;
  try {
    await manager.syncDocumentFromFile(file, 'doc1', {});
  } catch (e) {
    threw = true;
  }
  assert(threw, 'ready-state inference failure throws');

  const afterContent = db.prepare('SELECT content FROM documents WHERE id = ?').get('doc1').content;
  const afterChunks = db.prepare('SELECT count(*) AS n FROM chunk_metadata WHERE document_id = ?').get('doc1').n;
  const afterEmb = db.prepare(
    'SELECT count(*) AS n FROM chunks c JOIN chunk_metadata m ON c.rowid = m.rowid WHERE m.document_id = ?'
  ).get('doc1').n;
  assert(afterContent === beforeContent, 'document content unchanged after failed sync');
  assert(afterChunks === beforeChunks, 'chunk count unchanged after failed sync');
  assert(afterEmb === beforeEmb, 'embedding count unchanged after failed sync (no partial state)');

  // ---- Contract B: NOT READY -> lazy sync stores content, zero vectors -----
  simulateModelDown(manager);
  writeFileSync(file, original + ' lazy golf hotel.', 'utf-8');
  const lazy = await manager.syncDocumentFromFile(file, 'doc1', {});
  assert(lazy.embeddedChunks === 0, 'lazy sync embeds nothing');
  assert(lazy.embedding_status === 'queued', 'lazy sync reports queued');
  const lazyContent = db.prepare('SELECT content FROM documents WHERE id = ?').get('doc1').content;
  const lazyChunks = db.prepare('SELECT count(*) AS n FROM chunk_metadata WHERE document_id = ?').get('doc1').n;
  const lazyEmb = db.prepare(
    'SELECT count(*) AS n FROM chunks c JOIN chunk_metadata m ON c.rowid = m.rowid WHERE m.document_id = ?'
  ).get('doc1').n;
  assert(lazyContent.includes('lazy golf hotel'), 'lazy sync stored the NEW content');
  assert(lazyChunks > 0, 'lazy sync stored chunk rows');
  assert(lazyEmb === 0, 'lazy sync stored zero vectors');
  const ftsLive = db.prepare(`SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH '"hotel"'`).get().n;
  assert(ftsLive > 0, 'lazy-synced chunks searchable via FTS');
} finally {
  cleanup();
}
console.log(process.exitCode ? 'ATOMICITY FAILED' : 'ATOMICITY OK');
