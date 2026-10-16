// Structure-anchored chunker "c1" (spec §4.3). Boundaries anchor to markdown
// structure so a top-of-file edit no longer shifts every downstream chunk.
// Contract locked by test/chunk-invariants.test.mjs (publish gate): ordered,
// non-overlapping, gap-free partition; exact codepoint offsets; every chunk's
// exact token count <= max; deterministic. start_token/end_token do not exist
// for c1 (spec §4.3, r4 D4).
import type { Tiktoken } from 'tiktoken';

export interface CSegment { text: string; start_pos: number; end_pos: number }

export const DEFAULT_MAX_TOKENS = 800;
export const LEGACY_SIGNATURE = 'legacy-unknown';

// r11: heading is a preferred cut, not a mandatory one. A cut happens only when
// the accumulated section group AND the next section are both >= this floor —
// short adjacent sections merge, so cross-section queries still land in one
// chunk (gate regression k05) and short log sections stop forming over-sharp
// competitor chunks (k09). Derived, not independent: one knob (maxTokens).
export function mergeMinTokens(maxTokens: number): number {
  return Math.floor(maxTokens / 2);   // NOT >>1 — bitshift wraps at 2^31 (r12)
}

// kg-relation-evidence D3: fallback=cp-window-N names the windowed oversize split below. Boundaries
// differ from cp-exact only for blocks that reach the fallback, so the signature says so.
export function effectiveSignature(maxTokens: number): string {
  return `c1:enc=cl100k_base:max=${maxTokens}:overlap=0:fence=on:merge=${mergeMinTokens(maxTokens)}:fallback=cp-window-${maxTokens}`;
}

// Strict parse (r5-15): the regex alone classified impossible signatures
// (max=0, max/fallback mismatch) as current. Cross-check the components.
// Both c1 fallbacks are the current FORMAT (stats "current" vs legacy/unknown, index.ts:4826-4831):
// a document stamped cp-exact by 6.4.0 is not re-chunked by an unchanged-content sync and must not be
// reported as an unknown format.
export function isCurrentFormatSignature(sig: string): boolean {
  const m = /^c1:enc=cl100k_base:max=(\d+):overlap=0:fence=on:merge=(\d+):fallback=cp-(?:exact|window)-(\d+)$/.exec(sig);
  if (!m) return false;
  const max = Number(m[1]);
  return Number.isInteger(max) && max > 0 && m[1] === m[3] && Number(m[2]) === mergeMinTokens(max);
}

function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') { lines.push(text.slice(start, i + 1)); start = i + 1; }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^#{1,4}[ \t]/;
const BULLET_RE = /^(\s*)([-*+]|\d+[.)])[ \t]/;
const BLANK_RE = /^\s*$/;

type Block = { lines: string[]; heading: boolean };

export function buildBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  const attachTrailingBlanks = (blk: Block) => {
    while (i < lines.length && BLANK_RE.test(lines[i])) blk.lines.push(lines[i++]);
  };
  while (i < lines.length) {
    const line = lines[i];
    const fm = line.match(FENCE_RE);
    if (fm) {
      const marker = fm[1][0]; const openLen = fm[1].length;
      const blk: Block = { lines: [lines[i++]], heading: false };
      const closeRe = new RegExp(`^\\s{0,3}\\${marker}{${openLen},}\\s*$`);
      while (i < lines.length) {
        const l = lines[i]; blk.lines.push(l); i++;
        if (closeRe.test(l.replace(/\r?\n$/, ''))) break;   // unclosed -> EOF
      }
      attachTrailingBlanks(blk);
      blocks.push(blk);
    } else if (HEADING_RE.test(line)) {
      const blk: Block = { lines: [lines[i++]], heading: true };
      attachTrailingBlanks(blk);
      blocks.push(blk);
    } else if (BULLET_RE.test(line)) {
      const indent = line.match(BULLET_RE)![1].length;
      const blk: Block = { lines: [lines[i++]], heading: false };
      while (i < lines.length) {
        const l = lines[i];
        if (BLANK_RE.test(l) || HEADING_RE.test(l) || FENCE_RE.test(l)) break;
        const bm = l.match(BULLET_RE);
        if (bm && bm[1].length <= indent) break;             // sibling/outer bullet
        const li = l.match(/^(\s*)/)![1].length;
        if (!bm && li <= indent) break;                      // dedented prose
        blk.lines.push(l); i++;
      }
      attachTrailingBlanks(blk);
      blocks.push(blk);
    } else if (BLANK_RE.test(line)) {
      const blk: Block = { lines: [], heading: false };
      while (i < lines.length && BLANK_RE.test(lines[i])) blk.lines.push(lines[i++]);
      blocks.push(blk);
    } else {
      const blk: Block = { lines: [lines[i++]], heading: false };
      while (i < lines.length && !BLANK_RE.test(lines[i]) && !HEADING_RE.test(lines[i])
             && !FENCE_RE.test(lines[i]) && !BULLET_RE.test(lines[i])) {
        blk.lines.push(lines[i++]);
      }
      attachTrailingBlanks(blk);
      blocks.push(blk);
    }
  }
  return blocks;
}

// Oversize split for a block with no structural cut (spec §4.3-6; kg-relation-evidence D3).
// 6.4.0 scanned every codepoint prefix and re-encoded it (one encode per codepoint, quadratic per
// chunk; 20k chars 4.6 s, 575k 162 s measured). Now: encode a window once, map the first maxTokens
// window tokens back to a codepoint count, then VERIFY that candidate by encoding the real substring —
// the window tokenisation is only an estimate, because BPE re-tokenises a truncated final piece
// differently (prefix counts are not monotonic: '/sdkX' -> 1,1,2,1,2). Shrink the token count
// (1, 2, 4, ... fewer) until a candidate verifies; if none does, fall back to the 6.4.0 linear scan for
// this chunk only, which also keeps its throw. Contract (chunk-invariants, chunker-c): lossless,
// contiguous codepoint offsets, every chunk's ACTUAL encode length <= maxTokens, deterministic, always
// advances. Not a longest-fit guarantee — neither was LOOKAHEAD.
const LOOKAHEAD = 16;
const WINDOW_MIN_CP = 64;
const WINDOW_CP_PER_TOKEN = 8;

function utf8Bytes(cp: string): number {
  const c = cp.codePointAt(0)!;
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;   // a lone surrogate encodes as U+FFFD = 3
}

function linearFit(cps: string[], start: number, enc: Tiktoken, maxTokens: number): number {
  let lastFit = 0;
  let missesSinceFit = 0;
  for (let probe = start + 1; probe <= cps.length && missesSinceFit < LOOKAHEAD; probe++) {
    const t = enc.encode(cps.slice(start, probe).join('')).length;
    if (t <= maxTokens) { lastFit = probe - start; missesSinceFit = 0; }
    else missesSinceFit++;
  }
  return lastFit;
}

function windowFit(cps: string[], start: number, enc: Tiktoken, maxTokens: number): number {
  const rest = cps.length - start;
  let w = Math.min(rest, Math.max(WINDOW_MIN_CP, maxTokens * WINDOW_CP_PER_TOKEN));
  let toks = enc.encode(cps.slice(start, start + w).join(''));
  while (toks.length <= maxTokens && w < rest) {
    w = Math.min(rest, w * 2);
    toks = enc.encode(cps.slice(start, start + w).join(''));
  }
  if (toks.length <= maxTokens) return rest;             // the whole remainder fits
  for (let keep = maxTokens, step = 1; keep >= 1; keep -= step, step *= 2) {
    const bytes = enc.decode(toks.slice(0, keep)).length;
    let used = 0;
    let c = 0;
    while (c < w && used + utf8Bytes(cps[start + c]) <= bytes) { used += utf8Bytes(cps[start + c]); c++; }
    if (c === 0) continue;
    if (enc.encode(cps.slice(start, start + c).join('')).length <= maxTokens) return c;
  }
  return 0;
}

export function splitOversize(block: string, enc: Tiktoken, maxTokens: number): string[] {
  const cps = [...block];
  const out: string[] = [];
  let start = 0;
  while (start < cps.length) {
    let take = windowFit(cps, start, enc, maxTokens);
    if (take === 0) take = linearFit(cps, start, enc, maxTokens);
    if (take === 0) {
      throw new Error(`chunker c1: codepoint at offset ${start} exceeds maxTokens=${maxTokens} on its own — cannot honor the token budget`);
    }
    out.push(cps.slice(start, start + take).join(''));
    start += take;
  }
  return out;
}

export function chunkStructured(text: string, enc: Tiktoken, maxTokens: number = DEFAULT_MAX_TOKENS): CSegment[] {
  if (text.length === 0) return [];
  const blocks = buildBlocks(splitLines(text));
  // r11 section pass: a section = one heading block through the next heading
  // (preamble = blocks before the first heading). Cut decisions are precomputed
  // per section so they depend only on section sizes, not packing state.
  const minSection = mergeMinTokens(maxTokens);
  const sectionOfBlock = new Array<number>(blocks.length);
  const sectionTexts: string[] = [];
  let sec = -1;
  blocks.forEach((b, bi) => {
    if (b.heading || sec === -1) { sec++; sectionTexts[sec] = ''; }
    sectionOfBlock[bi] = sec;
    sectionTexts[sec] += b.lines.join('');
  });
  const secTokens = sectionTexts.map(t => enc.encode(t).length);
  // Cut at section s iff the group accumulated since the last cut and section s
  // are BOTH >= minSection. Group size = sum of section token counts (token
  // counts are not additive across joins; the sum is a deterministic threshold
  // proxy, never used as a budget).
  const cutAtSection = new Array<boolean>(secTokens.length).fill(false);
  {
    let groupTokens = 0;
    for (let s = 0; s < secTokens.length; s++) {
      if (s > 0 && groupTokens >= minSection && secTokens[s] >= minSection) { cutAtSection[s] = true; groupTokens = 0; }
      groupTokens += secTokens[s];
    }
  }
  const pieces: string[] = [];
  let acc = '';
  const flush = () => { if (acc.length > 0) { pieces.push(acc); acc = ''; } };
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    const btext = b.lines.join('');
    if (btext.length === 0) continue;
    if (b.heading) {
      const s = sectionOfBlock[bi];
      // Preferred cut: honor the precomputed section cut. Merged headings still
      // flush when their whole section cannot join the open chunk — splitting
      // at the heading beats orphaning the heading line at a budget flush.
      if (cutAtSection[s]) flush();
      else if (acc.length > 0 && enc.encode(acc + sectionTexts[s]).length > maxTokens) flush();
    }
    if (acc.length > 0 && enc.encode(acc + btext).length > maxTokens) flush();
    if (acc.length === 0 && enc.encode(btext).length > maxTokens) {
      pieces.push(...splitOversize(btext, enc, maxTokens));   // mega-block fallback
      continue;
    }
    acc += btext;
  }
  flush();
  const segments: CSegment[] = [];
  let cursor = 0;
  for (const p of pieces) {
    const len = [...p].length;
    segments.push({ text: p, start_pos: cursor, end_pos: cursor + len });
    cursor += len;
  }
  return segments;
}
