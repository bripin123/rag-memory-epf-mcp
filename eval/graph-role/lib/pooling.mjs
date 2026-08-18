// Two-pass incremental pooling (D2): after pass-1 (top30) grades exist, decide which queries' deep
// (ranks 31-100) tier is worth judging in pass 2. Pure, deterministic, no I/O.
//
// Natural id order: split into digit / non-digit runs, compare digit runs numerically and other runs
// lexicographically. So "hub-A-2" sorts before "hub-A-10" (numeric run 2 < 10), while class letters
// ("hub-A-1" vs "hub-M-1") keep their usual lexicographic order. A prefix of another id sorts first
// (fewer runs). Real query ids are `<corpus>-<class>-<n>` with unpadded n -- default string sort gets
// these wrong (e.g. "hub-A-10" before "hub-A-2"), which is why this is not just `.sort()`.
export function naturalCompare(a, b) {
  const ax = String(a).match(/\d+|\D+/g) || [];
  const bx = String(b).match(/\d+|\D+/g) || [];
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const x = ax[i], y = bx[i];
    if (x === y) continue;
    const xNum = /^\d+$/.test(x), yNum = /^\d+$/.test(y);
    if (xNum && yNum) { const d = Number(x) - Number(y); if (d !== 0) return d < 0 ? -1 : 1; continue; }
    return x < y ? -1 : 1;
  }
  return ax.length - bx.length;
}
//
// A query qualifies for the deep tier when its top30 rows contain >= 1 relevant document (doc-level
// grade = max over that document's judged top30 chunks; relevant = grade >= 1) whose channel union
// (union of `channels` across that document's top30 rows for this query) has size exactly 1 -- i.e. a
// relevant document that only one channel surfaced, meaning the top30 pool for this query is not
// saturated yet. `grades` should already resolve disagreements conservatively (adjudicated grade when
// present, else max(A, B), never min) -- that only ever makes a query MORE likely to qualify, never less.
//
// Qualifying queries are granted their deep tier in ascending qid order -- NATURAL order, not lexicographic
// (default string sort would put "hub-A-10" before "hub-A-2") -- until the running total of pass-1 + planned
// pass-2 rows would exceed `budget`; that query and every later qualifying query are then truncated (their
// deep rows are not planned).
export function planDeep({ poolRows, judgeRows, grades, budget }) {
  const byQid = new Map();
  for (const r of poolRows) { const a = byQid.get(r.qid); if (a) a.push(r); else byQid.set(r.qid, [r]); }

  const qualifying = [];
  for (const qid of [...byQid.keys()].sort(naturalCompare)) {
    const byDoc = new Map();
    for (const r of byQid.get(qid)) { if (r.tier !== 'top30') continue; const a = byDoc.get(r.doc_id); if (a) a.push(r); else byDoc.set(r.doc_id, [r]); }
    let qualifies = false;
    for (const docRows of byDoc.values()) {
      const grade = Math.max(...docRows.map(r => grades.get(r.jid) ?? -1));
      if (grade < 1) continue;
      const channels = new Set(); for (const r of docRows) for (const ch of r.channels) channels.add(ch);
      if (channels.size === 1) { qualifies = true; break; }
    }
    if (qualifies) qualifying.push(qid);
  }

  const pass1_rows = poolRows.filter(r => r.tier === 'top30').length;
  const deepJidsByQid = new Map();
  for (const r of judgeRows) { if (r.tier !== 'deep') continue; const a = deepJidsByQid.get(r.qid); if (a) a.push(r.jid); else deepJidsByQid.set(r.qid, [r.jid]); }

  const truncated = []; const planned = new Set(); let running = pass1_rows; let truncating = false;
  for (const qid of qualifying) {
    const n = (deepJidsByQid.get(qid) || []).length;
    if (!truncating && running + n <= budget) { planned.add(qid); running += n; }
    else { truncating = true; truncated.push(qid); }
  }

  const pass2_jids = judgeRows.filter(r => r.tier === 'deep' && planned.has(r.qid)).map(r => r.jid);
  return { qualifying, truncated, pass2_jids, pass1_rows, pass2_rows: pass2_jids.length };
}
