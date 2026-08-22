import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './lib/paths.mjs';
import { splitRows, validateBatch, mergeRows, trimContext } from './lib/judging.mjs';

const [cmd, label, ...rest] = process.argv.slice(2);
const get = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const poolDir = join(EVAL_DIR, 'pool');
const dir = label ? join(poolDir, 'batches', label) : null;
const SETS = ['pass1', 'pass2', 'unpooled', 'deepsample'];
const srcFile = (set) => ({ pass1: `${label}.judge.jsonl`, pass2: `${label}.judge-pass2.jsonl`, unpooled: `${label}.unpooled.jsonl`, deepsample: `${label}.deepsample.jsonl` }[set]);

if (cmd === 'split') {
  const set = get('--set');
  if (!label || !SETS.includes(set)) { console.error('usage: judge-batches.mjs split <corpus> --set pass1|pass2|unpooled|deepsample [--size N] [--context-chars N]'); process.exit(2); }
  // Defensive numeric flags: a flag with no value or a non-numeric/out-of-range value must exit 2 with a
  // usage message naming the flag, not silently become NaN (Number(undefined) is NaN, which used to sail
  // through and either hang splitRows forever or corrupt context_chars).
  const getNum = (flag, d, min) => {
    const i = rest.indexOf(flag);
    if (i < 0) return d;
    const v = Number(rest[i + 1]);
    if (!Number.isInteger(v) || v < min) { console.error(`usage: judge-batches.mjs split <corpus> --set pass1|pass2|unpooled|deepsample [--size N] [--context-chars N] (${flag} needs an integer >= ${min}, got ${JSON.stringify(rest[i + 1])})`); process.exit(2); }
    return v;
  };
  const size = getNum('--size', 25, 1);
  const contextChars = getNum('--context-chars', 500, 0);
  const srcP = join(poolDir, srcFile(set));
  if (!existsSync(srcP)) { console.error(`POOL_INCOMPLETE missing ${srcFile(set)}`); process.exit(7); }
  const rows = set === 'pass1' ? readJsonl(srcP).filter(r => r.tier === 'top10') : readJsonl(srcP);
  const batches = splitRows(rows, size);
  mkdirSync(dir, { recursive: true });
  for (const b of batches) writeFileSync(join(dir, `${set}-${b.nnn}.jsonl`), b.rows.map(r => JSON.stringify(trimContext(r, contextChars))).join('\n') + '\n');
  const index = { set, size, context_chars: contextChars, batches: batches.map(b => ({ file: `${set}-${b.nnn}.jsonl`, n: b.rows.length, jids: b.jids })), total: rows.length };
  writeFileSync(join(dir, `${set}.index.json`), JSON.stringify(index, null, 2) + '\n');
  console.log(`${label}/${set}: split ${rows.length} rows into ${batches.length} batches of <=${size} (context <=${contextChars} chars) -> pool/batches/${label}/`);

} else if (cmd === 'merge') {
  const judge = get('--judge'); const set = get('--set');
  if (!label || !['A', 'B', 'C'].includes(judge) || !SETS.includes(set)) { console.error('usage: judge-batches.mjs merge <corpus> --judge A|B|C --set pass1|pass2|unpooled|deepsample'); process.exit(2); }
  const indexP = join(dir, `${set}.index.json`);
  if (!existsSync(indexP)) { console.error(`POOL_INCOMPLETE run "judge-batches.mjs split ${label} --set ${set}" first`); process.exit(7); }
  const index = JSON.parse(readFileSync(indexP, 'utf8'));
  const invalid = []; const validRows = []; let meta = null; const models = new Set();
  for (const b of index.batches) {
    const bp = join(dir, `${judge}-${b.file}`);
    if (!existsSync(bp)) { invalid.push(`${b.file}: missing ${judge}-${b.file}`); continue; }
    let v; try { v = validateBatch(b.jids, readJsonl(bp)); } catch (e) { invalid.push(`${b.file}: unreadable (${e instanceof Error ? e.message : String(e)})`); continue; }
    if (!v.ok) { invalid.push(`${b.file}: ${v.errors.join('; ')}`); continue; }
    if (!meta) meta = v.meta; if (v.meta?.model) models.add(v.meta.model);
    validRows.push(...v.rows);
  }
  if (invalid.length) { for (const m of invalid) console.error(`INVALID ${m}`); console.error(`JUDGE_INCOMPLETE ${invalid.length} of ${index.batches.length} batches`); process.exit(11); }
  const now = new Date().toISOString();
  if (set === 'pass1' || set === 'pass2') {
    // Append-or-create: existing header is immutable once written -- never rewritten on append, only new
    // (by-jid) rows get appended below it.
    const outP = join(poolDir, judge === 'C' ? `${label}.adjudicated.jsonl` : `${label}.judge-${judge}.jsonl`);
    const existingLines = existsSync(outP) ? readJsonl(outP) : [];
    const existingHeader = existingLines[0]?.meta ? existingLines[0] : null;
    const existingRows = existingHeader ? existingLines.slice(1) : existingLines;
    const header = existingHeader || { meta: true, judge, model: meta?.model ?? null, models: [...models], at: now, ...(judge === 'C' ? { role: 'adjudicator' } : {}) };
    const merged = mergeRows(existingRows, validRows);
    writeFileSync(outP, [header, ...merged].map(r => JSON.stringify(r)).join('\n') + '\n');
    console.log(`${label}/${set}/${judge}: ${merged.length - existingRows.length} new of ${validRows.length} rows merged into ${outP.split('/').pop()} (${merged.length} total) · ${index.batches.length} batches ok`);
  } else {
    // unpooled / deepsample: one-shot diagnostic samples, create-or-overwrite, no incremental append semantics.
    const outP = join(poolDir, `${label}.${set}-${judge}.jsonl`);
    const header = { meta: true, judge, model: meta?.model ?? null, models: [...models], at: now, ...(judge === 'C' ? { role: 'adjudicator' } : {}) };
    writeFileSync(outP, [header, ...validRows].map(r => JSON.stringify(r)).join('\n') + '\n');
    console.log(`${label}/${set}/${judge}: wrote ${validRows.length} rows to ${outP.split('/').pop()} · ${index.batches.length} batches ok`);
  }

} else if (cmd === 'status') {
  if (!label) { console.error('usage: judge-batches.mjs status <corpus>'); process.exit(2); }
  for (const set of SETS) {
    const indexP = dir ? join(dir, `${set}.index.json`) : null;
    if (!indexP || !existsSync(indexP)) { console.log(`${label}/${set}: not split yet`); continue; }
    const index = JSON.parse(readFileSync(indexP, 'utf8'));
    for (const judge of ['A', 'B', 'C']) {
      let present = 0, valid = 0;
      for (const b of index.batches) {
        const bp = join(dir, `${judge}-${b.file}`);
        if (!existsSync(bp)) continue;
        present++;
        try { if (validateBatch(b.jids, readJsonl(bp)).ok) valid++; } catch { /* unreadable batch file: present but not valid */ }
      }
      console.log(`${label}/${set}/${judge}: expected ${index.batches.length} present ${present} valid ${valid}`);
    }
  }

} else {
  console.error('usage: judge-batches.mjs split|merge|status <corpus> [...]');
  process.exit(2);
}
