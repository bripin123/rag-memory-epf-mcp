const Database = require("better-sqlite3");
const path = "/Users/heesongkoh/Library/CloudStorage/GoogleDrive-heesong.koh@gmail.com/My Drive/PARADocumentSystem/--0-CollectLOG/Ultimate_AI_Personal_Assistant/.memory/rag-memory.db";
const db = new Database(path, { readonly: true });
const all = db.prepare("SELECT id, name FROM entities").all();
const compute = n => "entity_" + n.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "_");
let same = 0, diff = 0;
const mapping = [];
for (const e of all) {
  const newId = compute(e.name);
  if (e.id === newId) same++;
  else { diff++; mapping.push({ old: e.id, new: newId, name: e.name }); }
}
console.log("total:", all.length, "same:", same, "diff (legacy):", diff);
const existingIds = new Set(all.map(e => e.id));
const collisions = mapping.filter(m => existingIds.has(m.new) && m.old !== m.new);
console.log("collisions (new id == existing different entity id):", collisions.length);
if (collisions.length > 0) {
  console.log("--- Collisions sample ---");
  collisions.slice(0, 15).forEach(c => console.log(JSON.stringify(c)));
}
const newIdCounts = {};
mapping.forEach(m => { newIdCounts[m.new] = (newIdCounts[m.new] || 0) + 1; });
const dup = Object.entries(newIdCounts).filter(([k,v]) => v > 1);
console.log("duplicates among new IDs (multiple legacy names -> same new id):", dup.length);
if (dup.length > 0) {
  dup.slice(0, 15).forEach(([k, v]) => {
    console.log("  ", k, " <- ", mapping.filter(m => m.new === k).map(m => m.name));
  });
}
db.close();
