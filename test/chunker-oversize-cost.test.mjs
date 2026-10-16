#!/usr/bin/env node
// kg-relation-evidence Problem 3 (C1 RED / C6, fixed in Task 10): 6.4.0 splitOversize
// (src/chunkerC.ts:113-133) re-encodes every codepoint prefix of a blank-line-free block — about one
// encode() per codepoint, ~4.6 s for 20k chars measured. This pins the cost: a constant number of
// encode() calls per output chunk. Correctness is asserted with the REAL encoder, not the counter.
import assert from 'node:assert/strict';
import { get_encoding } from 'tiktoken';
import { chunkStructured } from '../dist/src/chunkerC.js';
import { accessibilityTree } from './helpers/oversize-corpus.mjs';
import { redCase, defect } from './helpers/red-case.mjs';

const real = get_encoding('cl100k_base');
const calls = { encode: 0 };
const enc = { encode: (s) => { calls.encode++; return real.encode(s); }, decode: (t) => real.decode(t) };
const text = accessibilityTree(20000);
let segs = [];
await redCase('Problem 3: oversize fallback costs a constant number of encode() calls per chunk', {
  // control = the input really is one oversize block and the output is correct (6.4.0 is correct, only slow)
  control: () => {
    assert.equal([...text].length, 20000, 'fixture: 20,000 codepoints');
    assert.ok(!/\n[ \t\r]*\n/.test(text), 'fixture: no blank line, so the whole input is one oversize block');
    segs = chunkStructured(text, enc, 800);
    assert.equal(segs.map(s => s.text).join(''), text, 'lossless');
    for (const s of segs) assert.ok(real.encode(s.text).length <= 800, 'every chunk within budget (real encoder)');
    assert.ok(segs.length > 1, 'the fallback split happened');
  },
  defect: () => {
    const bound = 4 * segs.length + 16;
    console.log(`  encode calls=${calls.encode} chunks=${segs.length} bound=${bound}`);
    defect(calls.encode <= bound, `encode calls ${calls.encode} exceed ${bound} (4 per chunk + 16): the fallback re-encodes prefixes`);
  },
});
console.log(process.exitCode ? 'chunker-oversize-cost: FAIL' : 'chunker-oversize-cost: ALL PASS');
