import { openCorpus, exitOnRefuse } from './lib/db.mjs';
import { CORPORA } from './lib/paths.mjs';
const [label, mode, ...args] = process.argv.slice(2);   // mode: doc <docId> | names | cooccur <EntityName>
await exitOnRefuse(async () => {
  const { db, close } = await openCorpus({ dbPath: CORPORA[label].copy, label });
  if (mode === 'names') { for (const r of db.prepare(`SELECT name FROM entities ORDER BY name`).all()) console.log(r.name); }
  else if (mode === 'doc') { const d = db.prepare(`SELECT content FROM documents WHERE id = ?`).get(args[0]); console.log(d ? d.content : `NO_DOC ${args[0]}`); }
  else if (mode === 'cooccur') {  // documents mentioning the entity literally, with the other entity names they also mention (text-based, for M bridging)
    const nm = args[0].toLowerCase(); const names = db.prepare(`SELECT name FROM entities`).all().map(r => r.name).filter(x => x.length >= 4);
    for (const d of db.prepare(`SELECT id, content FROM documents`).all()) { const c = d.content.toLowerCase(); if (!c.includes(nm)) continue;
      const others = names.filter(x => x.toLowerCase() !== nm && c.includes(x.toLowerCase())).slice(0, 15); console.log(`${d.id}\t${others.join(' | ')}`); }
  } else console.error('usage: author-context.mjs <corpus> names|doc <id>|cooccur <EntityName>');
  close();
});
