// Pure helpers for the batch judging protocol (judge-batches.mjs). No I/O, no engine imports.

// Word count by whitespace split (the JUDGING.md rationale cap is "<=25 words").
export function wordCount(s) {
  const t = String(s).trim();
  return t ? t.split(/\s+/).length : 0;
}

// Split `rows` into batches of at most `size`, each tagged with a zero-padded 3-digit batch number ("001",
// "002", ...) for the `<set>-NNN.jsonl` filename convention. Order-preserving, no shuffling. `size` must be a
// finite integer >= 1 -- 0/negative would loop forever (i never advances) and NaN would silently yield one
// empty batch, so both are rejected up front instead.
export function splitRows(rows, size) {
  if (!Number.isInteger(size) || size < 1) throw new Error('size must be an integer >= 1');
  const batches = [];
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    batches.push({ nnn: String(batches.length + 1).padStart(3, '0'), rows: chunk, jids: chunk.map(r => r.jid) });
  }
  return batches;
}

// Validate one judge's batch output against the batch's expected jid set. `outputLines` = the batch file's
// parsed JSON lines, in file order; line 0 must be the meta header `{meta:true, judge, model, at, ...}`, the
// rest are grade rows `{jid, grade, rationale}`. Every error class is independent (a batch can trip more than
// one at once); `ok` is only true when `errors` is empty.
export function validateBatch(batchJids, outputLines) {
  const errors = [];
  const meta = outputLines[0]?.meta ? outputLines[0] : null;
  if (!meta) { errors.push('missing meta header (first line)'); return { ok: false, meta: null, rows: [], errors }; }
  const rows = outputLines.slice(1);
  const want = new Set(batchJids);
  const seen = new Set();
  for (const r of rows) {
    if (!want.has(r.jid)) { errors.push(`foreign jid ${r.jid}`); continue; }
    if (seen.has(r.jid)) { errors.push(`duplicate jid ${r.jid}`); continue; }
    seen.add(r.jid);
    if (!Number.isInteger(r.grade) || r.grade < 0 || r.grade > 2) errors.push(`bad grade for ${r.jid}: ${JSON.stringify(r.grade)}`);
    if (typeof r.rationale !== 'string' || r.rationale.trim().length === 0) errors.push(`missing rationale for ${r.jid}`);
    else if (wordCount(r.rationale) > 25) errors.push(`rationale too long for ${r.jid} (${wordCount(r.rationale)} words)`);
  }
  for (const jid of want) if (!seen.has(jid)) errors.push(`missing jid ${jid}`);
  return { ok: errors.length === 0, meta, rows, errors };
}

// Merge validated new rows into an existing (data-only, no header) row list, deduped by jid -- existing rows
// always win, only genuinely new jids get appended. Assumes `newRows` is already internally jid-unique (a
// batch with an internal duplicate fails validateBatch and never reaches merge).
export function mergeRows(existingRows, newRows) {
  const seen = new Set(existingRows.map(r => r.jid));
  const added = newRows.filter(r => !seen.has(r.jid));
  return [...existingRows, ...added];
}

// Bounded prev/next context window for blind judging batches (judge-batches.mjs split --context-chars).
// prev_text keeps only its LAST n chars, next_text only its FIRST n chars -- the window nearest the passage
// -- and a cut gets marked so judges know context was truncated. chunk_text (the passage) is never touched.
// n <= 0 means no window: the row is returned unchanged (same reference, not a copy).
const CONTEXT_CUT_PREFIX = '…[cut] ';
const CONTEXT_CUT_SUFFIX = ' …[cut]';
export function trimContext(row, n) {
  if (!(n > 0)) return row;
  const prev = row.prev_text, next = row.next_text;
  return {
    ...row,
    prev_text: prev.length > n ? CONTEXT_CUT_PREFIX + prev.slice(prev.length - n) : prev,
    next_text: next.length > n ? next.slice(0, n) + CONTEXT_CUT_SUFFIX : next,
  };
}
