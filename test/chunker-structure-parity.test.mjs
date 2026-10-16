#!/usr/bin/env node
// kg-relation-evidence C7.4: for input that never reaches the oversize fallback, chunkDocument and
// syncDocumentFromFile produce exactly the 6.4.0 boundaries (golden generated from the 6.4.0 build by
// eval/chunker-bench/structure-golden.mjs), and an unchanged-content sync of a document stamped with the
// previous signature is not re-chunked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { get_encoding } from 'tiktoken';
import { makeManager } from './helpers/engine-test-db.mjs';
import { structureDoc } from './helpers/oversize-corpus.mjs';
import { chunkStructured } from '../dist/src/chunkerC.js';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const golden = JSON.parse(readFileSync(new URL('./fixtures/chunker-structure-golden.json', import.meta.url), 'utf8'));
const text = structureDoc();
assert.equal(sha(text), golden.text_sha256, 'fixture text drifted from the golden');
const real = get_encoding('cl100k_base');
const calls = { decode: 0 };
chunkStructured(text, { encode: (s) => real.encode(s), decode: (t) => { calls.decode++; return real.decode(t); } }, 800);
assert.equal(calls.decode, 0, 'fixture: the structure-split input must never reach the oversize fallback');

const { manager: m, cleanup } = await makeManager();
try {
  const db = m.db;
  const rows = (id) => db.prepare(`SELECT rowid, chunk_index, text, start_pos, end_pos FROM chunk_metadata WHERE document_id = ? ORDER BY chunk_index`).all(id);
  const shape = (rs) => rs.map(r => ({ start_pos: r.start_pos, end_pos: r.end_pos, text_sha256: sha(r.text) }));
  await m.syncDocumentFromFile('/parity.md', 'parity-sync', { content: text });
  assert.deepEqual(shape(rows('parity-sync')), golden.segments, 'syncDocumentFromFile boundaries differ from 6.4.0');
  await m.storeDocument('parity-chunk', text, {});
  await m.chunkDocument('parity-chunk');
  assert.deepEqual(shape(rows('parity-chunk')), golden.segments, 'chunkDocument boundaries differ from 6.4.0');

  const OLD = 'c1:enc=cl100k_base:max=800:overlap=0:fence=on:merge=400:fallback=cp-exact-800';
  db.prepare(`UPDATE documents SET chunking_signature = ? WHERE id = 'parity-sync'`).run(OLD);
  const before = rows('parity-sync').map(r => r.rowid);
  const r = await m.syncDocumentFromFile('/parity.md', 'parity-sync', { content: text });
  assert.equal(r.skipped, true, 'unchanged content with an old signature was re-chunked');
  assert.deepEqual(rows('parity-sync').map(x => x.rowid), before, 'chunk rows were replaced');
  assert.equal(db.prepare(`SELECT chunking_signature s FROM documents WHERE id = 'parity-sync'`).get().s, OLD, 'signature re-stamped without re-chunking');
  console.log('chunker-structure-parity: ALL PASS');
} finally { cleanup(); }
