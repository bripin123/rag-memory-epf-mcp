#!/usr/bin/env node
// Publish-time invariant test for chunkText().
//
// Cross-language position indexing invariant:
//   For every chunk produced by chunkText(text), if start_pos !== null then
//   [...text].slice(start_pos, end_pos).join('') === chunk.text
//
// SQL substr(content, start_pos+1, end_pos-start_pos) and Python
// content[start_pos:end_pos] must produce the same result. JS UTF-16 indexing
// breaks this for supplementary characters (emoji, rare CJK), so chunkText
// uses parallel UTF-16 + codepoint cursors and reports codepoint offsets.
//
// This test imports the built dist/ output (so npm publish exercises the same
// artifact users consume) and exits non-zero on any violation. Wired as
// prepublishOnly to block bad publishes at the source.
//
// History: Session 12 (2026-04-28) shipped v3.3.5 to fix this exact class of
// bug. v3.3.6 adds this test so a future regression is caught before publish.

import { get_encoding } from 'tiktoken';
import { chunkText } from '../dist/src/chunkText.js';

const encoding = get_encoding('cl100k_base');

const cases = [
  {
    name: 'ASCII English (long)',
    text: 'The quick brown fox jumps over the lazy dog. '.repeat(120),
  },
  {
    name: 'Korean 한국어',
    text: '대한민국은 동아시아의 국가입니다. 수도는 서울입니다. '.repeat(80),
  },
  {
    name: 'Emoji-heavy 🟢✅🎉',
    text: '🟢 Status check ✅ 모든 시스템 정상 🎉 Build OK 💯 '.repeat(80),
  },
  {
    name: 'Mixed CJK + supplementary',
    text: '𠮷田さん says 안녕! 你好世界 🌍🟢✅ こんにちは '.repeat(80),
  },
  {
    name: 'Pure supplementary plane',
    text: '🟢✅🎉💯🌍🚀⭐📊'.repeat(60),
  },
  {
    name: 'Short text (single chunk)',
    text: 'Hello 안녕 🟢',
  },
];

let pass = 0;
let fail = 0;
const failures = [];

for (const { name, text } of cases) {
  // Use small maxTokens to force many chunk boundaries (= more invariant checks)
  const segments = chunkText(text, encoding, 100, 20);
  const cps = [...text]; // codepoint array for slicing

  let caseFail = 0;
  let nullCount = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.start_pos === null) {
      nullCount++;
      continue;
    }
    const sliced = cps.slice(seg.start_pos, seg.end_pos).join('');
    if (sliced !== seg.text) {
      caseFail++;
      failures.push({
        case: name,
        chunkIdx: i,
        start_pos: seg.start_pos,
        end_pos: seg.end_pos,
        expected: seg.text.slice(0, 60),
        got: sliced.slice(0, 60),
      });
    }
  }

  if (caseFail === 0) {
    console.log(`  OK: ${name} — ${segments.length} chunks (${nullCount} null)`);
    pass++;
  } else {
    console.error(`  FAIL: ${name} — ${caseFail}/${segments.length} chunks violated invariant`);
    fail++;
  }
}

encoding.free();

console.log('');
console.log(`=== ${pass}/${pass + fail} cases passed ===`);

if (fail > 0) {
  console.error('');
  console.error('Detailed failures:');
  for (const f of failures.slice(0, 10)) {
    console.error(`  [${f.case}] chunk ${f.chunkIdx}: start=${f.start_pos} end=${f.end_pos}`);
    console.error(`    expected: ${JSON.stringify(f.expected)}`);
    console.error(`    got:      ${JSON.stringify(f.got)}`);
  }
  if (failures.length > 10) {
    console.error(`  ... and ${failures.length - 10} more`);
  }
  console.error('');
  console.error('PUBLISH BLOCKED: chunk substr invariant violated.');
  console.error('See src/chunkText.ts and the migration v11 history.');
  process.exit(1);
}

console.log('Publish-time invariants OK.');
process.exit(0);
