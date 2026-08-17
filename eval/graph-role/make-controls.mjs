// Builds the R5 controls for one corpus: R degree-preserving shuffles, RT type-preserving
// shuffles, and 1 Erdos-Renyi (same |E|) baseline. Only `relationships` is rewritten in each
// copy; vec0 chunk/entity embedding tables and `chunk_entities` travel unchanged (seed-linked
// chunks do not move under edge shuffles — that is why graph-seed/graph-n1 are reported
// separately, see T5). Node-level (in,out) degree is verified after every shuffled/typeshuf
// write; a mismatch aborts with exit 6.
import { copyFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { CORPORA, dbFor } from './lib/paths.mjs';
import { degreePreservingSwap, degreeSignature, sameSignature, erdosRenyi } from './lib/controls.mjs';

const label = process.argv[2];
const th = JSON.parse(readFileSync(new URL('./thresholds.json', import.meta.url), 'utf8'));
const R = th.controls.shuffled_replicates, RT = th.controls.typeshuf_replicates, PASSES = th.controls.swap_passes_per_edge;

const src = new Database(CORPORA[label].copy, { readonly: true });
const edges = src.prepare(`SELECT id, source_entity AS source, target_entity AS target, relationType AS type, confidence, metadata, created_at FROM relationships ORDER BY id`).all();
const nodes = src.prepare(`SELECT id FROM entities`).all().map(r => r.id); src.close();
const base = degreeSignature(edges);

// A raw copyFileSync of a WAL-mode SQLite DB silently drops un-checkpointed pages. The corpus
// copy is normally quiescent (written once by snapshot.mjs's `.backup`), but if anything left
// pending frames in `<copy>-wal`, checkpoint them into the main file before every raw copy.
function ensureCheckpointed(path) {
  const walPath = `${path}-wal`;
  if (existsSync(walPath) && statSync(walPath).size > 0) {
    execFileSync('sqlite3', [path, 'PRAGMA wal_checkpoint(TRUNCATE);']);
  }
}

function writeControl(cond, newEdges, checkSig) {
  const p = dbFor(label, cond);
  ensureCheckpointed(CORPORA[label].copy);
  copyFileSync(CORPORA[label].copy, p);
  const db = new Database(p);
  db.transaction(() => {
    db.prepare(`DELETE FROM relationships`).run();
    const ins = db.prepare(`INSERT INTO relationships (id, source_entity, target_entity, relationType, confidence, metadata, created_at) VALUES (?,?,?,?,?,?,?)`);
    for (const e of newEdges) ins.run(e.id, e.source, e.target, e.type, e.confidence, e.metadata, e.created_at);
  })();
  const back = db.prepare(`SELECT source_entity AS source, target_entity AS target FROM relationships`).all(); db.close();
  if (checkSig && !sameSignature(base, degreeSignature(back))) { console.error(`CONTROL_DEGREE_MISMATCH ${cond}`); process.exit(6); }
  console.log(`${label}.${cond}: |E|=${back.length}`);
}

for (let i = 0; i < R; i++) { const { edges: e2, swaps } = degreePreservingSwap(edges, { seed: i, passes: PASSES }); console.log(`shuffled-r${i} swaps=${swaps} (target ${edges.length * PASSES})`); writeControl(`shuffled-r${i}`, e2, true); }
for (let i = 0; i < RT; i++) { const { edges: e2, swaps } = degreePreservingSwap(edges, { seed: 100 + i, passes: PASSES, typePreserving: true }); console.log(`typeshuf-r${i} swaps=${swaps}`); writeControl(`typeshuf-r${i}`, e2, true); }
writeControl('random', erdosRenyi(edges, nodes, 999), false);
