// kg-relation-evidence C7.4: capture the boundaries chunkStructured produces for the structure-split
// fixture (never reaches the oversize fallback). Generated ONCE from the 6.4.0 build; the parity test
// compares the current build against it through chunkDocument and syncDocumentFromFile.
// usage: node eval/chunker-bench/structure-golden.mjs <dist dir> <out.json>
import { writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { get_encoding } from 'tiktoken';
import { structureDoc } from '../../test/helpers/oversize-corpus.mjs';

const [dist, out] = process.argv.slice(2);
if (!dist || !out || existsSync(out)) { console.error('usage: structure-golden.mjs <dist dir> <out.json> (out must not exist)'); process.exit(2); }
const { chunkStructured } = await import(pathToFileURL(join(resolve(dist), 'src', 'chunkerC.js')).href);
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const text = structureDoc();
const segs = chunkStructured(text, get_encoding('cl100k_base'), 800);
writeFileSync(out, JSON.stringify({ generated_from: 'rag-memory-epf-mcp 6.4.0 (7ac45b3) dist', text_sha256: sha(text),
  segments: segs.map(s => ({ start_pos: s.start_pos, end_pos: s.end_pos, text_sha256: sha(s.text) })) }, null, 2) + '\n');
