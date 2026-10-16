// kg-relation-evidence C7.3: dump what the no-argument generateKnowledgeGraphChunks() writes for a fixed
// synthetic graph. Run once with the 6.4.0 build and once with the new build; the two files must be
// byte-identical. Pre-dated observations keep the dump independent of the day it runs.
// usage: node eval/kg-defaults/generate-snapshot.mjs <path to dist/index.js> <out.json>
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildIdentity } from './build-digest.mjs';

const [dist, out] = process.argv.slice(2);
if (!dist || !out || existsSync(out)) { console.error('usage: generate-snapshot.mjs <dist/index.js> <out.json> (out must not exist)'); process.exit(2); }
const dir = mkdtempSync(join(tmpdir(), 'kg-snap-'));
process.env.DB_FILE_PATH = join(dir, 'snap.db');
process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const { RAGKnowledgeGraphManager } = await import(pathToFileURL(resolve(dist)).href);
const m = new RAGKnowledgeGraphManager();
await m.initialize({ skipModel: true });
try {
  const D = '[2026-01-01] ';
  await m.createEntities([
    { name: 'Snap Alpha', entityType: 'ORG', observations: [`${D}alpha one`, `${D}alpha two`] },
    { name: '스냅 베타', entityType: 'TEAM', observations: [`${D}베타 🎉 관찰`] },
    { name: 'Snap Empty', entityType: 'CONCEPT', observations: [] },
  ]);
  await m.createRelations([
    { from: 'Snap Alpha', to: '스냅 베타', relationType: 'FUNDS_PROJECT' },
    { from: '스냅 베타', to: 'Snap Empty', relationType: 'uses' },
    { from: 'Snap Alpha', to: 'Snap Auto', relationType: 'MENTIONS' },
  ]);
  await m.updateRelations([{ from: 'Snap Alpha', to: '스냅 베타', relationType: 'FUNDS_PROJECT', confidence: 0.7 }]);
  const counts = await m.generateKnowledgeGraphChunks();
  const rows = m.db.prepare(`SELECT chunk_id, chunk_type, entity_id, relationship_id, chunk_index, text, start_pos, end_pos, metadata
    FROM chunk_metadata WHERE chunk_type IN ('entity','relationship') ORDER BY chunk_id`).all();
  // Two empty dumps are byte-identical without proving anything, so an empty or miscounted dump is
  // refused (no file written). The build identity (build-digest.mjs) goes to stdout, not into the file,
  // because the file itself must stay byte-comparable across builds.
  const kinds = new Set(rows.map(r => r.chunk_type));
  if (rows.length === 0 || !kinds.has('entity') || !kinds.has('relationship')
      || rows.length !== counts.entityChunks + counts.relationshipChunks) {
    console.error(`REFUSE: empty or inconsistent snapshot (rows=${rows.length}, counts=${JSON.stringify(counts)})`);
    process.exitCode = 3;
  } else {
    writeFileSync(out, JSON.stringify({ counts, rows }, null, 2) + '\n');
    const id = buildIdentity(dist);
    console.log(`snapshot: dist=${resolve(dist)} build_digest=${id.build_digest} build_files=${id.build_files} entry_sha256=${id.entry_sha256} rows=${rows.length} counts=${JSON.stringify(counts)}`);
  }
} finally { m.cleanup(); rmSync(dir, { recursive: true, force: true }); }
