import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCorpus, exitOnRefuse } from './lib/db.mjs';
import { CORPORA, EVAL_DIR } from './lib/paths.mjs';
import { assertFrozen } from './lib/freeze.mjs';
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
      const a = idOf.get(e.from), b = idOf.get(e.to); if (!a || !b) { observed.push({ from: e.from, to: e.to, missing_entity: !a ? e.from : e.to }); continue; }
      for (const row of edge.all(a, b, b, a)) observed.push({ from: e.from, to: e.to, edge_id: row.id, relation_type: row.relationType, direction: row.source_entity === a ? 'out' : 'in', confidence: row.confidence });
    }
    out.push({ id: r.id, observed_paths: observed });
  }
  writeFileSync(join(EVAL_DIR, 'suite', `observed.${label}.jsonl`), out.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log(`${label}: observed rows ${out.length}`); close();
});
