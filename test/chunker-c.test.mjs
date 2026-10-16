#!/usr/bin/env node
// chunker C (spec §4.3): golden fixture(기대 chunk 전문 = 경계+offset 완전 잠금) +
// 출력 불변식 + 음성 대조군 + 비단조 회귀 2건 (r5-5).
import assert from 'node:assert/strict';
import { get_encoding } from 'tiktoken';
import { chunkStructured, effectiveSignature, isCurrentFormatSignature, LEGACY_SIGNATURE, mergeMinTokens } from '../dist/src/chunkerC.js';

const enc = get_encoding('cl100k_base');
const cp = (s) => [...s].length;
const FENCE = '`'.repeat(3);
const TILDE3 = '~'.repeat(3);
const TILDE4 = '~'.repeat(4);

function checkInvariants(text, segs, maxTokens = 800) {
  assert.equal(segs.map(s => s.text).join(''), text, 'partition: join === content');
  let cursor = 0;
  for (const [i, s] of segs.entries()) {
    assert.equal(s.start_pos, cursor, `chunk ${i}: start_pos contiguous`);
    assert.equal(s.end_pos, cursor + cp(s.text), `chunk ${i}: end_pos`);
    assert.equal([...text].slice(s.start_pos, s.end_pos).join(''), s.text, `chunk ${i}: cp-slice round-trip`);
    cursor = s.end_pos;
    assert.ok(enc.encode(s.text).length <= maxTokens, `chunk ${i}: exact tokens <= max`);
  }
}

// ---------- golden: expected = 기대 chunk 전문 배열 (경계·offset 완전 잠금) ----------
// r11: heading = 우선 절단점. 절단 = 누적 그룹·다음 절 모두 merge 최소치(⌊max/2⌋) 이상일 때만.
// 경계 의미를 검사하는 golden 은 절 크기가 최소치를 넘도록 maxTokens 를 fixture 별로 명시한다
// (절 토큰 수는 사전 실측값 — 주석에 기록).
const fakeHeads = Array.from({ length: 12 }, (_, i) => `# fake heading ${i}\n`).join('');
const golden = [
  { name: 'H2 두 절 = 절마다 chunk (양쪽 ≥ merge 최소치), 헤딩 줄은 뒤 chunk 소속 / 구분 빈 줄은 앞 블록 소속',
    maxTokens: 10,                                 // MIN=5, 절 실측 [5,6,6]
    text: '# T\nintro\n\n## A\nbody a\n\n## B\nbody b\n',
    expected: ['# T\nintro\n\n', '## A\nbody a\n\n', '## B\nbody b\n'] },
  { name: 'H5 는 경계 아님 (H1–H4 만)',
    maxTokens: 11,                                 // MIN=5, 절 실측 [11,5]
    text: '## A\n##### not-a-boundary\nbody\n## B\ny\n',
    expected: ['## A\n##### not-a-boundary\nbody\n', '## B\ny\n'] },
  { name: '선두 빈 줄 = 자체 블록, 짧은 preamble 절은 첫 절에 병합 (r11)',
    text: '\n\n## A\nbody\n',
    expected: ['\n\n## A\nbody\n'] },
  { name: 'fence 내부 헤딩형 줄 12개 = 경계 0 (AGENTS.md 구조 동형 합성)',
    maxTokens: 90,                                 // MIN=45, 절 실측 [82,48]
    text: `## S\n${FENCE}bash\n` + fakeHeads + `${FENCE}\ntail\n## T\n${'z '.repeat(44)}\n`,
    expected: [`## S\n${FENCE}bash\n` + fakeHeads + `${FENCE}\ntail\n`, `## T\n${'z '.repeat(44)}\n`] },
  { name: '미닫힘 fence = EOF 까지',
    text: `## S\n${FENCE}\n# fake\n## fake2\nno closing`,
    expected: [`## S\n${FENCE}\n# fake\n## fake2\nno closing`] },
  { name: '~~~ fence, closing 은 opening 길이 이상',
    maxTokens: 32,                                 // MIN=16, 절 실측 [16,18]
    text: `## S\n${TILDE4}\ncode\n${TILDE3}\nstill code\n${TILDE4}\nafter\n## T\n${'w '.repeat(14)}\n`,
    expected: [`## S\n${TILDE4}\ncode\n${TILDE3}\nstill code\n${TILDE4}\nafter\n`, `## T\n${'w '.repeat(14)}\n`] },
  { name: 'CRLF 보존',
    maxTokens: 10,                                 // MIN=5, 절 실측 [5,5]
    text: '## A\r\nbody\r\n\r\n## B\r\nmore\r\n',
    expected: ['## A\r\nbody\r\n\r\n', '## B\r\nmore\r\n'] },
  { name: '중첩 불릿 = 부모 불릿 블록에 묶인다',
    text: '## L\n- parent\n  - child one\n  - child two\n- sibling\n',
    expected: ['## L\n- parent\n  - child one\n  - child two\n- sibling\n'] },
  { name: '중복 블록 2회 = 각자 자리 유지',
    maxTokens: 10,                                 // MIN=5, 절 실측 [9,5]
    text: '## D\nsame para\n\nsame para\n\n## E\nend\n',
    expected: ['## D\nsame para\n\nsame para\n\n', '## E\nend\n'] },
];
for (const g of golden) {
  const segs = chunkStructured(g.text, enc, g.maxTokens ?? 800);
  checkInvariants(g.text, segs, g.maxTokens ?? 800);
  assert.deepEqual(segs.map(s => s.text), g.expected, `${g.name}: exact chunk texts`);
  console.log(`golden ok: ${g.name}`);
}

// ---------- r11 병합 규칙 golden (max=800, MIN=400. 절 토큰 실측값 주석) ----------
{
  const secA = '## A\n' + 'alpha '.repeat(500) + '\n';       // 504 tk
  const secB = '## B\n' + 'beta '.repeat(500) + '\n';        // 504 tk
  const secBsmall = '## B\n' + 'beta '.repeat(100) + '\n';   // 104 tk
  const secC = '## C\n' + 'gamma '.repeat(500) + '\n';       // 504 tk
  const P = (w) => w + (' ' + w).repeat(349) + '\n\n';       // 351 tk (1-token 단어만 사용)
  const secDsmall = '## B\n' + 'delta '.repeat(80) + '\n';   // 84 tk
  const S = (i) => `## S${i}\n` + 'word '.repeat(150) + '\n'; // 155 tk

  const merged = [
    { name: '두 절 다 짧음(<MIN) = 한 chunk 로 병합 (k05 축)',
      text: '# T\nintro\n\n## A\nbody a\n\n## B\nbody b\n',
      expected: ['# T\nintro\n\n## A\nbody a\n\n## B\nbody b\n'] },
    { name: '양쪽 절 모두 ≥ MIN = heading 절단 유지',
      text: secA + secB,
      expected: [secA, secB] },
    { name: '그룹 누적 규칙: [504,104,504] = 짧은 절은 앞 그룹에, 다음 대형 절 앞에서 절단',
      text: secA + secBsmall + secC,
      expected: [secA + secBsmall, secC] },
    { name: 'k05 패턴: 대형 절(>max)의 꼬리 chunk 에 짧은 절이 병합된다',
      text: '## A\n' + P('alpha') + P('beta') + P('gamma') + secDsmall,
      expected: ['## A\n' + P('alpha') + P('beta'), P('gamma') + secDsmall] },
    { name: 'k09 패턴: 짧은 절 연속 = budget 팩킹, 헤딩은 자기 본문과 함께 넘어간다',
      text: S(1) + S(2) + S(3) + S(4) + S(5) + S(6),
      expected: [S(1) + S(2) + S(3) + S(4) + S(5), S(6)] },
  ];
  for (const g of merged) {
    const segs = chunkStructured(g.text, enc, 800);
    checkInvariants(g.text, segs, 800);
    assert.deepEqual(segs.map(s => s.text), g.expected, `${g.name}: exact chunk texts`);
    console.log(`merge golden ok: ${g.name}`);
  }
}

// ---------- 헤딩 희소 + 작은 max: 블록 경계에서 나뉜다 (patterns.md 구조 동형) ----------
{
  // r6 실측 [64,61,61] 토큰과 같은 밀도: 각 줄 = '- alpha - alpha ...' (60 단어급 단일 불릿 줄)
  const line = (w) => ('- ' + w + ' ').repeat(30).trim() + '\n';
  const text = '## P\n' + line('alpha') + line('beta') + line('gamma');
  const segs = chunkStructured(text, enc, 80);
  checkInvariants(text, segs, 80);
  assert.equal(segs.length, 3, 'three chunks (r6 실행 확인: [64,61,61] tokens)');
  assert.ok(segs[0].text.startsWith('## P\n- alpha'), 'chunk0 = 헤딩+첫 불릿');
  assert.ok(segs[1].text.startsWith('- beta'), 'chunk1 = 둘째 불릿 경계');
}

// ---------- 메가블록 fallback: 무손실 + 비단조 회귀 (r5-5) ----------
{
  const mega = ('한글과🎉이모지🚀혼합 ').repeat(400);
  const segs = chunkStructured(mega + '\n', enc, 200);
  checkInvariants(mega + '\n', segs, 200);
  assert.ok(segs.length > 1, 'mega-block split');
}
assert.deepEqual(chunkStructured('/sdkX', enc, 1).map(s => s.text), ['/sdk', 'X'],
  'non-monotonic prefix: /sdk (1 token) must be found past the 2-token dip');
assert.throws(() => chunkStructured('🎉', enc, 1), /exceeds maxTokens/,
  'single codepoint over budget must throw');

// ---------- determinism ----------
{
  const t = '## A\nbody\n\n- item one\n- item two\n\n## B\nend\n';
  assert.deepEqual(chunkStructured(t, enc, 800), chunkStructured(t, enc, 800), 'byte-identical repeat');
}

// ---------- 음성 대조군: 불변식 검사기가 틀린 chunker 를 실제로 거부하는가 ----------
{
  const text = '## A\nbody 한🎉글\n\n## B\nmore\n';
  const normalized = [{ text: text.replace(/\n+/g, '\n'), start_pos: 0, end_pos: cp(text.replace(/\n+/g, '\n')) }];
  assert.throws(() => checkInvariants(text, normalized), /partition/, 'negative: whitespace normalizer FAILs');
  const injected = [
    { text: '## A\nbody 한🎉글\n\n', start_pos: 0, end_pos: cp('## A\nbody 한🎉글\n\n') },
    { text: '## A > ## B\nmore\n', start_pos: cp('## A\nbody 한🎉글\n\n'), end_pos: cp(text) }
  ];
  assert.throws(() => checkInvariants(text, injected), /partition|round-trip/, 'negative: heading-context injector FAILs');
  const toks = enc.encode(text);
  const lossy = new TextDecoder('utf-8').decode(enc.decode(toks.slice(0, Math.floor(toks.length / 2))));
  const sliced = [
    { text: lossy, start_pos: 0, end_pos: cp(lossy) },
    { text: text.slice(lossy.length), start_pos: cp(lossy), end_pos: cp(text) }
  ];
  if (sliced.map(s => s.text).join('') !== text) {
    assert.throws(() => checkInvariants(text, sliced), /partition|round-trip/, 'negative: token-slicer FAILs');
  } else {
    assert.fail('negative control did not exercise the lossy path — pick a different cut');
  }
}

// ---------- signature: 강한 파서 (r5-15, r11 merge 성분) ----------
assert.equal(effectiveSignature(800), 'c1:enc=cl100k_base:max=800:overlap=0:fence=on:merge=400:fallback=cp-window-800');
// kg-relation-evidence D3: documents stamped by the previous fallback stay "current format" (their
// boundaries only differ where the fallback ran, and an unchanged-content sync never re-chunks).
assert.ok(isCurrentFormatSignature('c1:enc=cl100k_base:max=800:overlap=0:fence=on:merge=400:fallback=cp-exact-800'));
assert.ok(!isCurrentFormatSignature('c1:enc=cl100k_base:max=800:overlap=0:fence=on:merge=400:fallback=cp-other-800'), 'unknown fallback = unknown');
assert.ok(isCurrentFormatSignature(effectiveSignature(800)));
assert.ok(isCurrentFormatSignature(effectiveSignature(400)));
assert.ok(isCurrentFormatSignature(effectiveSignature(401)), 'merge = floor(max/2)');
assert.ok(!isCurrentFormatSignature(LEGACY_SIGNATURE));
assert.ok(!isCurrentFormatSignature('bpe-800-160'));
assert.ok(!isCurrentFormatSignature('c1:enc=cl100k_base:max=800:overlap=0:fence=on:fallback=cp-exact-800'), 'r11 이전 형식(merge 부재) = unknown');
assert.ok(!isCurrentFormatSignature('c1:enc=cl100k_base:max=800:overlap=0:fence=on:merge=100:fallback=cp-exact-800'), 'merge 파생값 불일치 = unknown');
assert.ok(!isCurrentFormatSignature('c1:enc=cl100k_base:max=400:overlap=0:fence=on:merge=200:fallback=cp-exact-800'), 'max/fallback mismatch = unknown');
assert.ok(!isCurrentFormatSignature('c1:enc=cl100k_base:max=0:overlap=0:fence=on:merge=0:fallback=cp-exact-0'), 'max=0 = unknown');
// r12: >>1 은 2^31 에서 wrap — floor 로 전 양의 정수 범위에서 자기 signature 를 인식해야 한다
assert.equal(mergeMinTokens(2147483648), 1073741824, '32-bit 경계: floor, not bitshift');
assert.ok(isCurrentFormatSignature(effectiveSignature(2147483648)), '2^31 signature round-trip');
assert.ok(isCurrentFormatSignature(effectiveSignature(Number.MAX_SAFE_INTEGER - 1)), 'MAX_SAFE_INTEGER-1 round-trip');

// ---------- kg-relation-evidence D3: windowed fallback ----------
{
  const { splitOversize } = await import('../dist/src/chunkerC.js');
  const { accessibilityTree, jsonDump, minifiedJs, cjkAstralCrlf } = await import('./helpers/oversize-corpus.mjs');
  // '/sdkX'.repeat(400) is exactly 800 tokens (fits max=800, never reaches the fallback); 401 = 802 tokens.
  const inputs = [
    ['accessibility tree', accessibilityTree(6000)], ['JSON dump', jsonDump(6000)], ['minified JS', minifiedJs(6000)],
    ['CJK/astral/CRLF', cjkAstralCrlf(6000)], ['astral only', '🎉'.repeat(3000)], ['/sdkX repeated', '/sdkX'.repeat(401)],
  ];
  for (const [name, text] of inputs) {
    for (const max of [800, 5]) {
      const segs = chunkStructured(text, enc, max);
      checkInvariants(text, segs, max);
      assert.ok(segs.length > 1, `${name} max=${max}: split happened`);
      assert.deepEqual(chunkStructured(text, enc, max), segs, `${name} max=${max}: deterministic`);
    }
    console.log(`fallback ok: ${name} (max 800 and 5)`);
  }
  // shrink path: an encoder whose standalone encoding of mid-length strings is far over budget forces
  // the window candidate to fail verification; the split must still be lossless and within budget.
  const poisoned = { encode: (s) => { const t = enc.encode(s); const n = [...s].length; return n >= 10 && n < 64 ? Uint32Array.from([...t, ...new Array(100).fill(0)]) : t; },
                     decode: (t) => enc.decode(t) };
  const text = 'abcdefghij'.repeat(300);
  const parts = splitOversize(text, poisoned, 5);
  assert.equal(parts.join(''), text, 'shrink path: lossless');
  assert.ok(parts.every(p => [...p].length < 10 && enc.encode(p).length <= 5), 'shrink path: every piece verified short and within budget');
  // ^ with poison [10,64) every window candidate (keep 5, 4, 2 -> 28, 20, 10 cp) is rejected, so linearFit
  //   produced those pieces. Successful shrink (REVIEW-T10 I1): poison [11,64) rejects keep 5 and 4 (28, 20 cp)
  //   and accepts keep 2 (10 cp). Per chunk that is 1 window encode + 3 verifies = 4 encode calls; linearFit
  //   needs >= 26 (10 fitting probes + LOOKAHEAD 16 misses). Output invariants alone cannot tell the two paths
  //   apart (both yield 10-cp pieces), so the call bound is what fails if the shrunk candidate is not taken.
  {
    let calls = 0;
    const poison11 = { encode: (s) => { calls++; const t = enc.encode(s); const n = [...s].length; return n >= 11 && n < 64 ? Uint32Array.from([...t, ...new Array(100).fill(0)]) : t; },
                       decode: (t) => enc.decode(t) };
    const text11 = 'abcdefghij'.repeat(300);
    const shrunk = splitOversize(text11, poison11, 5);
    const used = calls;
    assert.equal(shrunk.join(''), text11, 'successful shrink: lossless');
    assert.ok(shrunk.every(p => [...p].length === 10 && enc.encode(p).length <= 5), 'successful shrink: every piece is 10 cp and within the real budget');
    assert.ok(used <= 5 * shrunk.length,
      `successful shrink: ${used} encode calls for ${shrunk.length} chunks (${(used / shrunk.length).toFixed(1)}/chunk) exceeds 5/chunk — the shrunk candidate was not taken (linearFit needs >= 26/chunk)`);
    assert.deepEqual(splitOversize(text11, poison11, 5), shrunk, 'successful shrink: deterministic');
    console.log(`fallback ok: successful shrink (${used} encode calls / ${shrunk.length} chunks)`);
  }
  // linear fallback: a decode that yields no bytes gives no window candidate; the old scan takes over
  const blind = { encode: (s) => enc.encode(s), decode: () => new Uint8Array(0) };
  const linearRef = (block, max) => {          // the 6.4.0 algorithm, restated as the oracle
    const cps = [...block]; const out = []; let start = 0;
    while (start < cps.length) {
      let lastFit = 0, miss = 0;
      for (let probe = start + 1; probe <= cps.length && miss < 16; probe++) {
        if (enc.encode(cps.slice(start, probe).join('')).length <= max) { lastFit = probe - start; miss = 0; } else miss++;
      }
      if (lastFit === 0) throw new Error('exceeds maxTokens');
      out.push(cps.slice(start, start + lastFit).join('')); start += lastFit;
    }
    return out;
  };
  const small = 'abcdefghij'.repeat(30);
  assert.deepEqual(splitOversize(small, blind, 5), linearRef(small, 5), 'no window candidate -> exactly the old linear scan');
  assert.throws(() => splitOversize('🎉', enc, 1), /exceeds maxTokens/, 'a single codepoint over budget still throws');
  console.log('fallback ok: shrink path, linear fallback, throw');
}

console.log('chunker-c: ALL PASS');
