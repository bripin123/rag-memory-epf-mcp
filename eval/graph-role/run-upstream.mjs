// Task 7 Step 2 — upstream metrics: seed recall, edge validity (typed/directed KG-encoding
// coverage against extract-observed.mjs's observed_paths), projection recall (does the harness's
// graph reach touch a gold document?), hub-degree misrank (link-count of chunks ranked above the
// gold doc in the product's graph-off top10). One row per non-K query, joined across
// queries/observed/candidates(real)/final(real)/qrels.
//
// Runs with or without qrels. Where suite/qrels.<label>.jsonl exists (Task 6 output) it is
// frozen-checked exactly as before and used as judged gold. Where it does not -- Stage 1's judging
// ended on the authored axis after the kappa gate failed, so no qrels were written -- the script
// prints QRELS_ABSENT on stderr and emits every judged-gold-dependent metric as null beside an
// explicit `skipped`/`skipped_metrics` marker, so a consumer can never read "not measured" as 0.
// The structural metrics (seed recall, edge validity, encoded-path coverage) need no gold and are
// computed either way; they are the upstream-first evidence this run exists to produce.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CORPORA, EVAL_DIR } from './lib/paths.mjs';
import { assertFrozen } from './lib/freeze.mjs';

const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

// Pure part (TDD'd in test/eval-graph-role-libs.test.mjs, no DB/file access): does the KG actually
// carry the edges a query's expected_paths encode? `hits` matches observed_paths rows by (from,to)
// that resolved to a real edge_id -- extract-observed.mjs leaves a bare {from,to,missing_entity}
// (no edge_id) when an endpoint entity itself does not exist in the KG, so `o.edge_id` truthy is
// the "this edge exists" filter. `type`/`direction` = 'any' always counts as satisfied once the
// edge exists (Stage 1's suite carries type/direction='any' on every hop -- see suite/FREEZE.md
// note 1 -- so direction_ok/type_ok are currently always in lockstep with `exists`, but the field
// is computed generally for when typed/directed queries are added).
export function computeEdgeValidity(expEdges, obs) {
  const ev = { total: expEdges.length, exists: 0, direction_ok: 0, type_ok: 0, required_missing: 0 };
  for (const e of expEdges) {
    const hits = obs.filter(o => o.from === e.from && o.to === e.to && o.edge_id);
    if (hits.length) {
      ev.exists++;
      if (e.direction === 'any' || hits.some(h => h.direction === e.direction)) ev.direction_ok++;
      if (e.type === 'any' || hits.some(h => h.relation_type === e.type)) ev.type_ok++;
    } else if (e.required) {
      ev.required_missing++;
    }
  }
  return ev;
}

// Judged gold, or the explicit absence of it. Pure (path in, data out) so the qrels-absent
// decision is unit-testable without a DB. An existing file is still frozen-checked by the caller;
// `skipped` is non-null only when the file itself is not there.
export function loadGoldDocs(path) {
  if (!existsSync(path)) return { goldDocs: new Map(), skipped: 'qrels-absent' };
  const goldDocs = new Map();
  for (const q of readJsonl(path)) if (q.grade >= 1) (goldDocs.get(q.qid) || goldDocs.set(q.qid, new Set()).get(q.qid)).add(q.doc_id);
  return { goldDocs, skipped: null };
}

export function run(label) {
  assertFrozen({ rel: `queries.${label}.jsonl` });
  const qrelsPath = join(EVAL_DIR, 'suite', `qrels.${label}.jsonl`);
  if (existsSync(qrelsPath)) assertFrozen({ rel: `qrels.${label}.jsonl` });
  else console.error(`QRELS_ABSENT ${label} (kappa gate fail — authored-axis run); judged-gold metrics skipped`);
  const queries = readJsonl(join(EVAL_DIR, 'suite', `queries.${label}.jsonl`)).filter(q => q.class !== 'K');
  const observed = new Map(readJsonl(join(EVAL_DIR, 'suite', `observed.${label}.jsonl`)).map(o => [o.id, o.observed_paths]));
  const cand = new Map(readJsonl(join(EVAL_DIR, 'out', `candidates.${label}.real.jsonl`)).map(r => [r.id, r]));
  const fin = new Map(readJsonl(join(EVAL_DIR, 'out', `final.${label}.real.jsonl`)).map(r => [r.id, r]));
  const { goldDocs, skipped } = loadGoldDocs(qrelsPath);
  const db = new Database(CORPORA[label].copy, { readonly: true });
  const linkCount = db.prepare(`SELECT COUNT(*) c FROM chunk_entities ce JOIN chunk_metadata cm ON cm.rowid = ce.chunk_rowid WHERE cm.chunk_id = ?`);
  const idOf = new Map(db.prepare(`SELECT id, name FROM entities`).all().map(r => [r.name, r.id]));
  const docsOfEntities = (names) => {
    const ids = names.map(n => idOf.get(n)).filter(Boolean);
    if (!ids.length) return new Set();
    return new Set(db.prepare(`SELECT DISTINCT cm.document_id d FROM chunk_entities ce JOIN chunk_metadata cm ON cm.rowid = ce.chunk_rowid WHERE ce.entity_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(r => r.d));
  };
  const out = [];
  for (const q of queries) {
    const c = cand.get(q.id); if (!c) continue;
    const seedNames = new Set(c.seeds.map(s => s.name));
    const seeds_hit = q.seed_candidates.filter(n => seedNames.has(n));
    const obs = observed.get(q.id) || [];
    const expEdges = (q.expected_paths || []).flat();
    const ev = computeEdgeValidity(expEdges, obs);
    const gold = goldDocs.get(q.id) || new Set();
    // Both of these read judged gold, so both are unmeasurable without qrels -- null here means
    // "no judged gold for this query", and `skipped` below says whether that is because the whole
    // qrels file is missing (not measured) rather than this one query having no graded document.
    let projection_recall = null, hub = null;
    if (!skipped) {
      // seeds' own docs, union with the harness's 2-hop reach proxy (graph-n1 doc100) for "the graph
      // made this doc reachable" -- connected (non-seed) entity names are not carried in candidates
      // rows, so they cannot be recomputed here without re-running the seam; graph-n1 doc100 stands
      // in for that reach.
      const connectedDocs = docsOfEntities([...new Set(c.seeds.map(s => s.name))]);
      const n1Docs = new Set((c.channels['graph-n1'].doc100 || []).map(id => id.split('_chunk_')[0]));
      projection_recall = gold.size ? [...gold].filter(d => n1Docs.has(d) || connectedDocs.has(d)).length / gold.size : null;
      const f = fin.get(q.id);
      if (f && gold.size) {
        const top = f.off.top10;
        const gi = top.findIndex(x => gold.has(x.doc));
        hub = { gold_rank_off: gi < 0 ? -1 : gi + 1, above_gold_link_counts: gi > 0 ? top.slice(0, gi).map(x => linkCount.get(x.chunk_id).c) : [] };
      }
    }
    out.push({
      id: q.id, class: q.class, author_mode: q.author_mode,
      seed_recall: seeds_hit.length ? 1 : 0, seeds_hit,
      edge_validity: ev,
      encoded_path_coverage: q.author_mode === 'kg-informed' ? (ev.total ? ev.exists / ev.total : null) : null,
      projection_recall, hubdeg_misrank: hub,
      ...(skipped ? { skipped, skipped_metrics: ['projection_recall', 'hubdeg_misrank'] } : {}),
    });
  }
  writeFileSync(join(EVAL_DIR, 'out', `upstream.${label}.jsonl`), out.map(r => JSON.stringify(r)).join('\n') + '\n');
  const n = out.length, sr = out.filter(o => o.seed_recall).length;
  const evT = out.reduce((a, o) => a + o.edge_validity.total, 0), evE = out.reduce((a, o) => a + o.edge_validity.exists, 0);
  console.log(`${label}: n=${n} seed_recall ${sr}/${n} edge_validity ${evE}/${evT} (source-grounded rows only counted where author_mode=source-grounded: ${out.filter(o => o.author_mode === 'source-grounded').length})${skipped ? ` · projection_recall/hubdeg_misrank null — ${skipped} (not measured, not 0)` : ''}`);
  db.close();
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const label = process.argv[2];
  if (!CORPORA[label]) { console.error('usage: run-upstream.mjs <hub|uap|hal>'); process.exit(2); }
  run(label);
}
