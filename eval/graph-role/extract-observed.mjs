// Re-derives suite/observed.<label>.jsonl -- for each non-K query, which of its expected_paths
// edges actually exist in the corpus KG -- from the frozen corpus copy in dbs/.
//
// Every row is preceded by a `{meta:true, snapshot_sha256, ...}` line naming the snapshot this was
// derived from, and run-upstream.mjs refuses an observation file whose stamp does not match the
// current snapshot.json (review finding, 2026-08-22: DECISION.md §9's re-evaluation command list
// never re-ran this script, so shipping a graph change and re-running §9 would have re-measured
// Stage 1's observations against the new graph and reported "no change" for a mechanical reason).
//
// The stamp keys on snapshot.json's *recorded* sha256, not a live hash of dbs/<label>.db: later
// pipeline stages (run-candidates/run-final) open that copy through the engine and mutate it, so a
// re-hash would flap for reasons that have nothing to do with staleness.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCorpus, exitOnRefuse } from './lib/db.mjs';
import { CORPORA, EVAL_DIR } from './lib/paths.mjs';
import { assertFrozen } from './lib/freeze.mjs';

// The snapshot identity this extraction is derived from. Absent snapshot.json means the pipeline
// was not started at its first step (`snapshot.mjs`), which is a setup error, not a default.
export function snapshotStamp(evalDir, label) {
  const p = join(evalDir, 'snapshot.json');
  if (!existsSync(p)) { console.error(`SNAPSHOT_MISSING ${p} -- run: node eval/graph-role/snapshot.mjs`); process.exit(12); }
  const snap = JSON.parse(readFileSync(p, 'utf8'));
  const c = snap.corpora?.[label];
  if (!c?.sha256) { console.error(`SNAPSHOT_MISSING corpus ${label} in ${p}`); process.exit(12); }
  return { meta: true, snapshot_sha256: c.sha256, snapshot_taken_at: snap.taken_at, engine_commit: snap.engine_commit, generated_at: new Date().toISOString() };
}

const label = process.argv[2];
assertFrozen({ rel: `queries.${label}.jsonl` });
await exitOnRefuse(async () => {
  const { db, close } = await openCorpus({ dbPath: CORPORA[label].copy, label });
  const rows = readFileSync(join(EVAL_DIR, 'suite', `queries.${label}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const idOf = new Map(db.prepare(`SELECT id, name FROM entities`).all().map(r => [r.name, r.id]));
  const edge = db.prepare(`SELECT id, relationType, confidence, source_entity, target_entity FROM relationships WHERE (source_entity=? AND target_entity=?) OR (source_entity=? AND target_entity=?) ORDER BY id`);
  const out = [];
  for (const r of rows) {
    if (r.class === 'K') continue;
    const observed = [];
    for (const path of (r.expected_paths || [])) for (const e of path) {
      const a = idOf.get(e.from), b = idOf.get(e.to); if (!a || !b) { if (!a) observed.push({ from: e.from, to: e.to, missing_entity: e.from }); if (!b) observed.push({ from: e.from, to: e.to, missing_entity: e.to }); continue; }
      for (const row of edge.all(a, b, b, a)) observed.push({ from: e.from, to: e.to, edge_id: row.id, relation_type: row.relationType, direction: row.source_entity === a ? 'out' : 'in', confidence: row.confidence });
    }
    out.push({ id: r.id, observed_paths: observed });
  }
  const stamp = snapshotStamp(EVAL_DIR, label);
  writeFileSync(join(EVAL_DIR, 'suite', `observed.${label}.jsonl`), [stamp, ...out].map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log(`${label}: observed rows ${out.length} snapshot=${stamp.snapshot_sha256.slice(0, 12)}`); close();
});
