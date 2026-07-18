const Database = require("better-sqlite3");
const path = "/Users/heesongkoh/Library/CloudStorage/GoogleDrive-heesong.koh@gmail.com/My Drive/PARADocumentSystem/--0-CollectLOG/Ultimate_AI_Personal_Assistant/.memory/rag-memory.db";
const db = new Database(path);

const compute = n => "entity_" + n.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "_");

const all = db.prepare("SELECT id, name FROM entities").all();
const mapping = [];
for (const e of all) {
  const newId = compute(e.name);
  if (e.id !== newId) mapping.push({ old: e.id, new: newId, name: e.name });
}
console.log("Legacy entities to migrate:", mapping.length);

// Pre-counts for verification
const pre = {
  entities: db.prepare("SELECT COUNT(*) AS c FROM entities").get().c,
  relationships: db.prepare("SELECT COUNT(*) AS c FROM relationships").get().c,
  chunk_entities: db.prepare("SELECT COUNT(*) AS c FROM chunk_entities").get().c,
  entity_embedding_metadata: db.prepare("SELECT COUNT(*) AS c FROM entity_embedding_metadata").get().c,
};
console.log("Pre counts:", pre);

db.pragma("foreign_keys = OFF");
const trx = db.transaction((maps) => {
  const stmtE = db.prepare("UPDATE entities SET id = ? WHERE id = ?");
  const stmtRS = db.prepare("UPDATE relationships SET source_entity = ? WHERE source_entity = ?");
  const stmtRT = db.prepare("UPDATE relationships SET target_entity = ? WHERE target_entity = ?");
  const stmtCE = db.prepare("UPDATE chunk_entities SET entity_id = ? WHERE entity_id = ?");
  const stmtEM = db.prepare("UPDATE entity_embedding_metadata SET entity_id = ? WHERE entity_id = ?");
  let updated = 0;
  for (const m of maps) {
    stmtE.run(m.new, m.old);
    stmtRS.run(m.new, m.old);
    stmtRT.run(m.new, m.old);
    stmtCE.run(m.new, m.old);
    stmtEM.run(m.new, m.old);
    updated++;
  }
  return updated;
});

const updated = trx(mapping);
console.log("Migration committed. Updated entities:", updated);
db.pragma("foreign_keys = ON");

// Post-counts
const post = {
  entities: db.prepare("SELECT COUNT(*) AS c FROM entities").get().c,
  relationships: db.prepare("SELECT COUNT(*) AS c FROM relationships").get().c,
  chunk_entities: db.prepare("SELECT COUNT(*) AS c FROM chunk_entities").get().c,
  entity_embedding_metadata: db.prepare("SELECT COUNT(*) AS c FROM entity_embedding_metadata").get().c,
};
console.log("Post counts:", post);

// Foreign key integrity check
const fkErrors = db.pragma("foreign_key_check");
console.log("Foreign key violations:", fkErrors.length);
if (fkErrors.length > 0) {
  console.log("--- FK violations ---");
  fkErrors.slice(0, 10).forEach(e => console.log(JSON.stringify(e)));
}

// Re-verify: any remaining legacy?
const all2 = db.prepare("SELECT id, name FROM entities").all();
let remaining = 0;
for (const e of all2) {
  if (e.id !== compute(e.name)) remaining++;
}
console.log("Remaining legacy entities after migration:", remaining);

db.close();
console.log("Done.");
