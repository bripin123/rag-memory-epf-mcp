// Tokenize and chunk text using a BPE encoder while reporting both token-space
// and char-space (Unicode codepoint) offsets back into the original string.
//
// BPE tokenizers (cl100k_base) split multi-byte UTF-8 sequences across tokens.
// Slicing token arrays at arbitrary boundaries can leave incomplete UTF-8
// prefix/suffix bytes, which TextDecoder replaces with U+FFFD (�). We trim the
// incomplete sequences at chunk boundaries; overlap covers the removed bytes.
//
// Each chunk records both token-space offsets (start_token/end_token from the
// BPE encoder loop) and char-space offsets (start_pos/end_pos into the original
// text). Char offsets are Unicode codepoint counts — language-neutral, so SQL
// substr, Python str slicing, and JS [...str] iteration all line up. JS's
// native UTF-16 indexing differs for supplementary characters (emoji, rare CJK),
// so the function maintains parallel UTF-16 and codepoint cursors and reports
// codepoint offsets. On a coincidental indexOf miss the char offsets are NULL.
//
// Extracted to a standalone module so publish-time invariant tests can exercise
// the algorithm directly without booting the full RAG-Memory stack.

import type { Tiktoken } from 'tiktoken';

export interface ChunkSegment {
  text: string;
  start_pos: number | null;
  end_pos: number | null;
  start_token: number;
  end_token: number;
}

// trimIncompleteUtf8: strip incomplete UTF-8 sequences from the head/tail of a
// byte buffer produced by decoding an arbitrary token slice. A multi-byte
// codepoint that begins or ends on the cut edge belongs to an adjacent chunk
// and must be removed so TextDecoder does not emit U+FFFD. Pass
// trimHead/trimTail=false to preserve head/tail bytes (first/last chunks).
export function trimIncompleteUtf8(bytes: Uint8Array, trimHead: boolean, trimTail: boolean): Uint8Array {
  let start = 0;
  let end = bytes.length;

  if (trimHead) {
    while (start < end && (bytes[start] & 0xC0) === 0x80) start++;
  }

  if (trimTail) {
    let i = end - 1;
    while (i >= start && (bytes[i] & 0xC0) === 0x80) i--;
    if (i >= start) {
      const lead = bytes[i];
      let needed = 1;
      if ((lead & 0x80) === 0) needed = 1;
      else if ((lead & 0xE0) === 0xC0) needed = 2;
      else if ((lead & 0xF0) === 0xE0) needed = 3;
      else if ((lead & 0xF8) === 0xF0) needed = 4;
      if (end - i < needed) end = i;
    }
  }

  return bytes.subarray(start, end);
}

export function chunkText(
  text: string,
  encoding: Tiktoken,
  maxTokens = 800,
  overlap = 160
): ChunkSegment[] {
  const tokens = encoding.encode(text);
  const segments: ChunkSegment[] = [];
  let utf16Cursor = 0;
  let cpCursor = 0;

  for (let i = 0; i < tokens.length; i += maxTokens - overlap) {
    const chunkTokens = tokens.slice(i, i + maxTokens);
    const decodedBytes = encoding.decode(chunkTokens);

    const isFirst = i === 0;
    const isLast = i + chunkTokens.length >= tokens.length;
    const safeBytes = trimIncompleteUtf8(decodedBytes, !isFirst, !isLast);
    const chunkTextStr = new TextDecoder('utf-8').decode(safeBytes);

    let startPos: number | null;
    let endPos: number | null;
    if (isFirst) {
      startPos = 0;
      endPos = [...chunkTextStr].length;
      utf16Cursor = 0;
      cpCursor = 0;
    } else if (chunkTextStr.length === 0) {
      startPos = null;
      endPos = null;
    } else {
      const utfIdx = text.indexOf(chunkTextStr, utf16Cursor);
      if (utfIdx >= 0) {
        // Advance cpCursor by codepoints between the previous cursor and the
        // new chunk's start (handles overlap by anchoring at the previous
        // chunk's start, not its end).
        if (utfIdx > utf16Cursor) {
          cpCursor += [...text.slice(utf16Cursor, utfIdx)].length;
          utf16Cursor = utfIdx;
        }
        const cpLen = [...chunkTextStr].length;
        startPos = cpCursor;
        endPos = cpCursor + cpLen;
      } else {
        startPos = null;
        endPos = null;
      }
    }

    segments.push({
      text: chunkTextStr,
      start_pos: startPos,
      end_pos: endPos,
      start_token: i,
      end_token: i + chunkTokens.length
    });
  }

  return segments;
}
