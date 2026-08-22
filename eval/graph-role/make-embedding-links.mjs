// Arm A4 builder: replace chunk_entities with embedding-derived links.
// Pre-registered rule (2026-08-22, before results were seen): for each chunk, link the
// TOP_N nearest entities by bge-m3 cosine. TOP_N = 8 = the median links-per-chunk of the
// current lexical graph, so the two arms carry a comparable link budget.
// Never touches a live DB: it only writes dbs/<label>.emb.db, built from dbs/<label>.db.
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './lib/paths.mjs';

const TOP_N = 8;
for (const label of process.argv.slice(2).length ? process.argv.slice(2) : ['hub', 'hal']) {
  const src = join(EVAL_DIR, 'dbs', `${label}.db`);
  const dst = join(EVAL_DIR, 'dbs', `${label}.emb.db`);
  copyFileSync(src, dst);
  const db = new Database(dst);
  sqliteVec.load(db);
  const before = db.prepare('SELECT COUNT(*) c FROM chunk_entities').get().c;
  const chunks = db.prepare('SELECT rowid FROM chunk_metadata').all();
  const vecOf = db.prepare('SELECT embedding FROM chunks WHERE rowid = ?');
  const near = db.prepare(`SELECT eem.entity_id FROM entity_embeddings ee
                           JOIN entity_embedding_metadata eem ON eem.rowid = ee.rowid
                           WHERE ee.embedding MATCH ? AND k = ? ORDER BY ee.distance`);
  db.exec('DELETE FROM chunk_entities');
  const ins = db.prepare('INSERT OR IGNORE INTO chunk_entities (chunk_rowid, entity_id) VALUES (?, ?)');
  let written = 0, novec = 0;
  const tx = db.transaction(() => {
    for (const { rowid } of chunks) {
      const row = vecOf.get(rowid);
      if (!row?.embedding) { novec++; continue; }
      for (const r of near.all(row.embedding, TOP_N)) written += ins.run(rowid, r.entity_id).changes;
    }
  });
  tx();
  const after = db.prepare('SELECT COUNT(*) c FROM chunk_entities').get().c;
  console.log(`${label}: ${before} -> ${after} links (written ${written}, chunks ${chunks.length}, no-vector ${novec}, TOP_N=${TOP_N})`);
  db.close();
}
