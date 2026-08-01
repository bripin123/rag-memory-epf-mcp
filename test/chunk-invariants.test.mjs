#!/usr/bin/env node
// Publish-time invariant gate for chunker c1 (spec §4.3). Replaces the BPE gate.
// The old gate skipped rows with start_pos===null — that hole let a
// text-mutating chunker publish (advisor r1). c1 has a NULL budget of 0:
// this gate checks EVERY chunk, no skip branch.
import assert from 'node:assert/strict';
import { get_encoding } from 'tiktoken';
import { chunkStructured } from '../dist/src/chunkerC.js';

const enc = get_encoding('cl100k_base');
const MAX = 800;
const F = '`'.repeat(3);
const T4 = '~'.repeat(4);

const corpora = [
  `# doc\n\nplain paragraph\n\n## section\n- bullet 한🎉글\n- two\n\n${F}js\n# not a heading\ncode()\n${F}\ntail\n`,
  '한글 문단 '.repeat(500) + '\n\n## 절\n' + '- 항목 '.repeat(300) + '\n',
  'no headings at all\n\n' + 'p '.repeat(2000) + '\n',
  `${T4}\nfence with # inside\n${T4}\nafter\r\nCRLF line\r\n`,
  '🎉'.repeat(3000),
  '/sdkX'.repeat(200),
];

for (const [ci, text] of corpora.entries()) {
  const segs = chunkStructured(text, enc, MAX);
  assert.equal(segs.map(s => s.text).join(''), text, `corpus ${ci}: join === content`);
  let cursor = 0;
  for (const [i, s] of segs.entries()) {
    assert.equal(typeof s.start_pos, 'number', `corpus ${ci} chunk ${i}: start_pos NOT NULL`);
    assert.equal(s.start_pos, cursor, `corpus ${ci} chunk ${i}: contiguous`);
    assert.equal([...text].slice(s.start_pos, s.end_pos).join(''), s.text,
      `corpus ${ci} chunk ${i}: cp-slice round-trip`);
    cursor = s.end_pos;
    assert.ok(enc.encode(s.text).length <= MAX, `corpus ${ci} chunk ${i}: tokens <= ${MAX}`);
  }
  assert.deepEqual(chunkStructured(text, enc, MAX), segs, `corpus ${ci}: deterministic`);
}
console.log('chunk-invariants (c1): ALL PASS');
