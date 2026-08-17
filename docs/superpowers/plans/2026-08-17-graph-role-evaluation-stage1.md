# graph-role-evaluation — Stage 1 Implementation Plan (seam · harness · pilot · power)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the evaluation harness that measures, on frozen suites over three real corpora, whether the knowledge graph should generate candidates, re-rank, or leave ranking — and produce the pilot variance needed to size the holdout (Stage 2).

**Architecture:** One behaviour-preserving diagnostic seam in the engine (`explainGraphContext`, proven by a differential golden), plus a stdlib-only harness under `eval/graph-role/` (open DB copies → freeze-checked suites → per-channel candidates at fixed budgets → degree-preserving edge controls → blind pooling/judging → paired statistics → power). Everything runs on `.backup` copies with summaries off; nothing here changes search behaviour or ships.

**Tech Stack:** Node ≥ 24 ESM `.mjs`, better-sqlite3 (via the built engine `dist/index.js`), `node:assert/strict` tests wired into `verify:engine`, `node:crypto` sha256, seeded PRNG (mulberry32) — no new dependencies.

**Spec:** `specs/changes/graph-role-evaluation/{proposal.md, delta-specs/graph-role-evaluation.spec.md, tasks.md}` (this repo, v2) · design SSOT = framework repo `docs/superpowers/specs/2026-08-17-graph-role-redesign-design.md` §2 · advisor r4 = framework repo `raw/advisor/2026-08-17-ranking-root-fix/r4-codex-last.md`.

## Global Constraints

- Repo conventions (CODE_CONTEXT.md): ESM only, `.js` extensions in relative imports, `strict: true`, no markdown frontmatter, no commit trailers, commit messages `type(scope): summary` + prose body.
- `npm test` = `build → verify:invariants → verify:engine`; **never pipe** it (`npm test > log 2>&1; echo EXIT:$?`); every new `test/*.test.mjs` must be appended to `verify:engine`.
- One `makeManager()` per test process (DB_FILE_PATH is read once at import) — each test file is its own `node` invocation.
- Harness isolation (R10): `RAG_MEMORY_SEARCH_SUMMARIES=off` forced; refuse the three live DB paths (exit 4); one measuring process at a time.
- Freeze discipline (R1, R9): suites/thresholds are sha256-recorded in `eval/graph-role/suite/FREEZE.md` before any run; runners exit 3 on mismatch unless `--unfrozen`.
- Product-code touch is limited to `explainGraphContext` extraction (D11); scorer 0 lines; no release.
- Determinism: every ranking has an explicit tie-break `(score desc, chunk_id asc)`; every random step takes a seed.

---

## File Structure (Stage 1)

```
index.ts                                   Modify: extract explainGraphContext (T1)
package.json                               Modify: verify:engine += 2 tests (T1, T2)
test/helpers/engine-test-db.mjs            Modify: add installControlledEmbedder (T1)
test/fixtures/graph-context/build.mjs      Create: fixture DB + case runner shared by golden writer & test (T1)
test/fixtures/graph-context-golden.json    Create: recorded BEFORE extraction, committed (T1)
test/graph-context-explain.test.mjs        Create: seam contract + differential parity (T1)
test/eval-graph-role-libs.test.mjs         Create: pure-lib tests (T2, T4, T5, T8 append)
eval/graph-role/README.md                  Create (T2), complete (T8)
eval/graph-role/.gitignore                 Create: dbs/ (T2)
eval/graph-role/thresholds.json            Create (T2)
eval/graph-role/lib/paths.mjs              Create: LIVE_PATHS, corpus registry (T2)
eval/graph-role/lib/db.mjs                 Create: openCorpus (T2)
eval/graph-role/lib/freeze.mjs             Create: sha256/FREEZE/validate (T2)
eval/graph-role/lib/rrf.mjs                Create: rrf/cut/uniqueDocCut (T2)
eval/graph-role/lib/prng.mjs               Create: mulberry32 + shuffle (T2)
eval/graph-role/snapshot.mjs               Create: online backups + snapshot.json (T2)
eval/graph-role/suite/PROTOCOL.md          Create (T3)
eval/graph-role/make-known-item.mjs        Create (T3)
eval/graph-role/list-seeds.mjs             Create (T3)
eval/graph-role/author-context.mjs         Create (T3)
eval/graph-role/extract-observed.mjs       Create (T3)
eval/graph-role/suite/queries.<c>.jsonl    Create ×3 (T3, frozen)
eval/graph-role/suite/FREEZE.md            Create (T3), append (T6, T8)
eval/graph-role/lib/controls.mjs           Create (T4)
eval/graph-role/make-controls.mjs          Create (T4)
eval/graph-role/lib/stages.mjs             Create (T5)
eval/graph-role/run-candidates.mjs         Create (T5)
eval/graph-role/run-final.mjs              Create (T5)
eval/graph-role/pool.mjs                   Create (T6)
eval/graph-role/suite/JUDGING.md           Create (T6)
eval/graph-role/judge-merge.mjs            Create (T6)
eval/graph-role/run-upstream.mjs           Create (T7)
eval/graph-role/link-audit-sample.mjs      Create (T7)
eval/graph-role/link-audit-merge.mjs       Create (T7)
eval/graph-role/lib/metrics.mjs            Create (T8)
eval/graph-role/report.mjs                 Create (T8)
eval/graph-role/power.mjs                  Create (T8)
eval/graph-role/suite/POWER.md             Create (T8, frozen)
```

---

### Task 1: Product seam `explainGraphContext` + differential parity golden

**Files:**
- Create: `test/fixtures/graph-context/build.mjs`
- Modify: `test/helpers/engine-test-db.mjs` (append `installControlledEmbedder`)
- Create: `test/fixtures/graph-context-golden.json` (generated, committed BEFORE the extraction commit)
- Modify: `index.ts:3654-3730` (extract), plus a new public method next to `hybridSearch`
- Create: `test/graph-context-explain.test.mjs`
- Modify: `package.json` scripts.`verify:engine` (append `&& node test/graph-context-explain.test.mjs`)

**Interfaces:**
- Produces: `RAGKnowledgeGraphManager.explainGraphContext(query: string): Promise<GraphContext>` where
  ```ts
  type GraphContext = {
    status: 'vector' | 'entity-text-fallback' | 'chunk-vector-disabled' | 'error';
    query_variants: string[];
    seeds: Array<{ entity_id: string; name: string; similarity: number }>;
    connected: Array<{ entity_id: string; name: string; via_seed_id: string; via_seed_name: string;
                       edge_id: string; relation_type: string; direction: 'out' | 'in'; confidence: number | null }>;
  };
  ```
- Produces: `installControlledEmbedder(manager, table: Map<string, Float32Array>)` — exact vectors per text, unit-length axis vectors; unknown texts fall back to the char-code fake.
- Consumed by: T5 `lib/stages.mjs` (`m.explainGraphContext(q)`).

- [ ] **Step 1: Add the controlled embedder helper**

Append to `test/helpers/engine-test-db.mjs`:

```js
// Controlled embedder: exact unit vectors for known texts (fixture design needs cosines at
// the 0.4-similarity threshold). sim = 1 - L2/2 on unit vectors  =>  sim > 0.4  <=>  cos > 0.28.
export function axisVec(cos, axis = 1) {
  const v = new Float32Array(1024);
  v[0] = cos; v[axis] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}
export function installControlledEmbedder(manager, table) {
  const counter = { calls: 0 };
  const gate = manager.gate;
  gate.state = 'ready'; gate.shuttingDown = false;
  gate.embedFn = async (text) => {
    counter.calls++;
    const hit = table.get(text);
    if (hit) return hit;
    const v = new Float32Array(1024);
    for (let i = 0; i < text.length; i++) v[i % 1024] += text.charCodeAt(i) / 1000;
    v[0] += 0.01;
    return v;
  };
  manager.embeddingCache = new Map();
  return counter;
}
```

- [ ] **Step 2: Write the fixture/case runner (shared by golden writer and test)**

Create `test/fixtures/graph-context/build.mjs`:

```js
// Builds the parity fixture and runs the 9 differential cases. Used twice:
//   (a) BEFORE extraction: `node test/fixtures/graph-context/build.mjs --write` records the golden
//   (b) AFTER extraction: the test replays and byte-compares.
import { writeFileSync } from 'node:fs';
import { makeManager, installControlledEmbedder, axisVec } from '../../helpers/engine-test-db.mjs';

export const QUERY = 'graph context probe query';
export async function buildFixture() {
  const { manager: m, dir } = await makeManager();
  m.embeddingsMode = 'lazy';
  // Entity name -> vector so that similarity to QUERY is controlled (QUERY = axis 0 unit vector).
  const table = new Map([
    [QUERY, axisVec(1.0)],
    ['Alpha Node', axisVec(0.60)],      // seed (sim ≈ 0.55)
    ['Beta Node',  axisVec(0.31)],      // just above threshold (sim ≈ 0.41)
    ['Gamma Node', axisVec(0.25)],      // just below threshold (sim ≈ 0.39)
    ['Delta Node', axisVec(-0.5)],      // far
    ['Alpha Node observations', axisVec(0.60)],
  ]);
  installControlledEmbedder(m, table);
  await m.createEntities([
    { name: 'Alpha Node', entityType: 'CONCEPT', observations: ['Alpha Node observations'] },
    { name: 'Beta Node',  entityType: 'CONCEPT', observations: ['beta text'] },
    { name: 'Gamma Node', entityType: 'CONCEPT', observations: ['gamma text'] },
    { name: 'Delta Node', entityType: 'CONCEPT', observations: ['delta text'] },
    { name: 'Lonely Node', entityType: 'CONCEPT', observations: ['no relations at all'] },
  ]);
  await m.createRelations([
    { from: 'Alpha Node', to: 'Delta Node', relationType: 'REFERENCES' },   // out-edge from seed
    { from: 'Delta Node', to: 'Alpha Node', relationType: 'SUPPORTS' },     // in-edge to seed (bidirectional pair)
    { from: 'Alpha Node', to: 'Delta Node', relationType: 'EXTENDS' },      // parallel edge, different type
    { from: 'Beta Node',  to: 'Gamma Node', relationType: 'RELATED_TO' },
  ]);
  // confidence null case: set one edge's confidence to NULL directly (schema allows).
  m.db.prepare(`UPDATE relationships SET confidence = NULL WHERE relationType = 'EXTENDS'`).run();
  await m.syncDocumentFromFile('/alpha.md', 'd-alpha', { content: 'Alpha Node appears here with searchable alpha words. Delta Node too.' });
  await m.syncDocumentFromFile('/beta.md',  'd-beta',  { content: 'Beta Node and Gamma Node appear here with searchable beta gamma words.' });
  await m.syncDocumentFromFile('/plain.md', 'd-plain', { content: 'plain document with no entity mention, only searchable filler words.' });
  await m.startReconciliation();
  return { m, dir };
}

const strip = (res) => ({
  search_mode: res.search_mode,
  results: res.results.map(r => ({ chunk_id: r.chunk_id, vs: r.vector_similarity, gb: r.graph_boost, fts: r.fts_boost, fin: r.relevance_score })),
});

export async function runCases(m) {
  const out = {};
  out.c1_multi_seed_threshold = strip(await m.hybridSearch(QUERY, 10, true));          // Alpha+Beta seeds, Gamma below
  out.c2_default_off          = strip(await m.hybridSearch(QUERY, 10));                // no graph_boost at all
  out.c3_no_candidate         = strip(await m.hybridSearch('zzqx nothing matches', 10, true));
  out.c4_cross_lingual        = strip(await m.hybridSearch('알파 노드 검색', 10, true)); // variants path (may equal single variant)
  // c5: entity-vector exception forced -> text fallback path
  const origPrepare = m.db.prepare.bind(m.db);
  m.db.prepare = (sql) => { if (/FROM entity_embeddings ee/.test(sql)) throw new Error('forced entity-vector failure'); return origPrepare(sql); };
  out.c5_entity_vector_exception = strip(await m.hybridSearch(QUERY, 10, true));
  m.db.prepare = origPrepare;
  // c6: chunk-vector degraded (model down) -> fts-only, graph block skipped
  const { simulateModelDown } = await import('../../helpers/engine-test-db.mjs');
  const savedFn = m.gate.embedFn, savedState = m.gate.state;
  simulateModelDown(m);
  out.c6_chunk_vector_degraded = strip(await m.hybridSearch(QUERY, 10, true));
  m.gate.state = savedState; m.gate.embedFn = savedFn; m.embeddingCache = new Map();
  // c7: relations emptied -> seeds but no connected
  const rels = m.db.prepare(`SELECT * FROM relationships`).all();
  m.db.prepare(`DELETE FROM relationships`).run();
  out.c7_no_relations = strip(await m.hybridSearch(QUERY, 10, true));
  const ins = m.db.prepare(`INSERT INTO relationships (id, source_entity, target_entity, relationType, confidence, metadata, created_at) VALUES (?,?,?,?,?,?,?)`);
  for (const r of rels) ins.run(r.id, r.source_entity, r.target_entity, r.relationType, r.confidence, r.metadata, r.created_at);
  out.c8_limit_1  = strip(await m.hybridSearch(QUERY, 1, true));
  out.c9_limit_50 = strip(await m.hybridSearch(QUERY, 50, true));
  return out;
}

if (process.argv.includes('--write')) {
  const { m } = await buildFixture();
  const cases = await runCases(m);
  writeFileSync(new URL('../graph-context-golden.json', import.meta.url), JSON.stringify(cases, null, 2) + '\n');
  console.log('golden written:', Object.keys(cases).length, 'cases');
  m.cleanup();
}
```

- [ ] **Step 3: Record the golden BEFORE touching index.ts**

Run: `npm run build > /tmp/b.log 2>&1; echo EXIT:$?` then `node test/fixtures/graph-context/build.mjs --write`
Expected: `golden written: 9 cases`; inspect `test/fixtures/graph-context-golden.json` — `c1` must show `gb` numeric on chunks of d-alpha (Alpha seed, Delta connected) and `c2` must have `gb: undefined` (serialised as absent).

- [ ] **Step 4: Commit the golden (pre-extraction baseline)**

```bash
git add test/helpers/engine-test-db.mjs test/fixtures/graph-context/build.mjs test/fixtures/graph-context-golden.json
git commit -m "test(search): record graph-context parity golden before seam extraction

The golden captures hybridSearch(useGraph:true) result order and score components on a
controlled-embedding fixture across nine cases (threshold boundary, multi-seed, parallel and
bidirectional edges, null confidence, no candidate, entity-vector exception fallback, chunk-vector
degradation, empty relations, cross-lingual variants). The next commit extracts the graph-context
block into a diagnostic method; this file is the proof that the extraction changes nothing."
```

- [ ] **Step 5: Write the failing seam test**

Create `test/graph-context-explain.test.mjs`:

```js
// explainGraphContext contract (evaluation seam) + differential parity with the pre-extraction golden.
import { readFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { buildFixture, runCases, QUERY } from './fixtures/graph-context/build.mjs';

const { m, dir } = await buildFixture();
const golden = JSON.parse(readFileSync(new URL('./fixtures/graph-context-golden.json', import.meta.url), 'utf8'));

// (A) differential parity: byte-identical to the golden recorded before extraction
{
  const now = await runCases(m);
  assert.equal(JSON.stringify(now), JSON.stringify(golden), 'hybridSearch(useGraph:true) must be byte-identical to pre-extraction golden');
  console.log('  OK: differential parity — 9 cases identical');
}
// (B) seam contract on the normal path
{
  const g = await m.explainGraphContext(QUERY);
  assert.equal(g.status, 'vector');
  const seedNames = g.seeds.map(s => s.name);
  assert.deepEqual(seedNames, ['Alpha Node', 'Beta Node'], 'seeds = above-threshold entities, similarity desc');
  assert.ok(!seedNames.includes('Gamma Node'), 'Gamma (sim≈0.39) must be below the 0.4 threshold');
  const viaAlpha = g.connected.filter(c => c.via_seed_name === 'Alpha Node');
  assert.equal(viaAlpha.length, 3, 'parallel + bidirectional edges are all kept as rows');
  assert.deepEqual(viaAlpha.map(c => c.direction).sort(), ['in', 'out', 'out']);
  assert.ok(viaAlpha.some(c => c.relation_type === 'EXTENDS' && c.confidence === null), 'null confidence preserved');
  const ids = viaAlpha.map(c => c.edge_id);
  assert.deepEqual(ids, [...ids].sort(), 'connected ordered by edge_id within a seed');
  console.log('  OK: seam contract (status vector, seeds, connected rows with edge/type/direction/confidence)');
}
// (C) branch preservation
{
  const origPrepare = m.db.prepare.bind(m.db);
  m.db.prepare = (sql) => { if (/FROM entity_embeddings ee/.test(sql)) throw new Error('forced'); return origPrepare(sql); };
  const g = await m.explainGraphContext(QUERY);
  m.db.prepare = origPrepare;
  assert.equal(g.status, 'entity-text-fallback');
  const { simulateModelDown } = await import('./helpers/engine-test-db.mjs');
  const savedFn = m.gate.embedFn, savedState = m.gate.state;
  simulateModelDown(m);
  const d = await m.explainGraphContext(QUERY);
  m.gate.state = savedState; m.gate.embedFn = savedFn; m.embeddingCache = new Map();
  assert.equal(d.status, 'chunk-vector-disabled'); assert.equal(d.seeds.length, 0); assert.equal(d.connected.length, 0);
  console.log('  OK: branch preservation (entity-text-fallback / chunk-vector-disabled)');
}
// (D) default call still carries no graph_boost
{
  const r = await m.hybridSearch(QUERY, 5);
  for (const x of r.results) assert.equal(x.graph_boost, undefined);
  console.log('  OK: default call has no graph_boost');
}
m.cleanup(); rmSync(dir, { recursive: true, force: true });
console.log('graph-context-explain: ALL OK');
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm run build > /tmp/b.log 2>&1; echo EXIT:$?; node test/graph-context-explain.test.mjs; echo EXIT:$?`
Expected: parity (A) passes (nothing extracted yet), then FAIL at (B) with `m.explainGraphContext is not a function`.

- [ ] **Step 7: Extract the seam in index.ts (behaviour-preserving)**

In `index.ts`, add the public method (place it directly above `async hybridSearch(`):

```ts
  /**
   * Diagnostic seam for the graph re-ranker (evaluation change graph-role-evaluation, R2).
   * Returns the seed entities (query-vector matched, similarity > 0.4, top-10 per variant) and the
   * 1-hop connected entities exactly as hybridSearch(useGraph:true) computes them, plus edge detail
   * that hybridSearch itself does not use (edge id, type, direction, confidence). It never generates
   * candidates and never changes ranking; hybridSearch consumes only the name sets.
   */
  async explainGraphContext(query: string, queryVariants?: string[]): Promise<{
    status: 'vector' | 'entity-text-fallback' | 'chunk-vector-disabled' | 'error';
    query_variants: string[];
    seeds: Array<{ entity_id: string; name: string; similarity: number }>;
    connected: Array<{ entity_id: string; name: string; via_seed_id: string; via_seed_name: string;
                       edge_id: string; relation_type: string; direction: 'out' | 'in'; confidence: number | null }>;
  }> {
    if (!this.db) throw new Error('Database not initialized');
    const variants = queryVariants ?? this.buildCrossLingualVariants(query);
    const empty = { query_variants: variants, seeds: [] as any[], connected: [] as any[] };
    if (!(this.coordinator?.eligible ?? false)) return { status: 'chunk-vector-disabled', ...empty };
    try {
      const searchEntities = (embedding: Float32Array) => this.db!.prepare(`
            SELECT em.entity_id, e.name, ee.distance
            FROM entity_embeddings ee
            JOIN entity_embedding_metadata em ON ee.rowid = em.rowid
            JOIN entities e ON e.id = em.entity_id
            WHERE ee.embedding MATCH ? AND k = 10
            ORDER BY ee.distance
          `).all(Buffer.from(embedding.buffer)) as Array<{ entity_id: string; name: string; distance: number }>;
      const entityMap = new Map<string, { entity_id: string; name: string; distance: number }>();
      for (const variant of variants) {
        const embedding = await this.generateEmbedding(variant, 1024, true);
        for (const e of searchEntities(embedding)) {
          const existing = entityMap.get(e.entity_id);
          if (!existing || e.distance < existing.distance) entityMap.set(e.entity_id, e);
        }
      }
      const similar = Array.from(entityMap.values()).sort((a, b) => a.distance - b.distance || (a.entity_id < b.entity_id ? -1 : 1));
      const seeds: Array<{ entity_id: string; name: string; similarity: number }> = [];
      const connected: any[] = [];
      const edgeStmt = this.db.prepare(`
            SELECT r.id AS edge_id, r.relationType AS relation_type, r.confidence,
                   CASE WHEN r.source_entity = ? THEN e2.id ELSE e1.id END AS entity_id,
                   CASE WHEN r.source_entity = ? THEN e2.name ELSE e1.name END AS name,
                   CASE WHEN r.source_entity = ? THEN 'out' ELSE 'in' END AS direction
            FROM relationships r
            JOIN entities e1 ON e1.id = r.source_entity
            JOIN entities e2 ON e2.id = r.target_entity
            WHERE r.source_entity = ? OR r.target_entity = ?
            ORDER BY r.id`);
      for (const entity of similar) {
        const similarity = Math.max(0, 1 - entity.distance / 2);
        if (similarity > 0.4) {
          seeds.push({ entity_id: entity.entity_id, name: entity.name, similarity });
          for (const row of edgeStmt.all(entity.entity_id, entity.entity_id, entity.entity_id, entity.entity_id, entity.entity_id) as any[]) {
            connected.push({ entity_id: row.entity_id, name: row.name, via_seed_id: entity.entity_id, via_seed_name: entity.name,
                             edge_id: row.edge_id, relation_type: row.relation_type, direction: row.direction,
                             confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence) });
          }
        }
      }
      return { status: 'vector', query_variants: variants, seeds, connected };
    } catch (error) {
      console.error('⚠️ Entity vector search for graph enhancement failed:', error);
      // Fallback: text-based matching (original behavior) — same SQL as before extraction.
      const connected: any[] = [];
      const queryEntities = this.extractTermsFromText(query);
      for (const entity of queryEntities) {
        const rows = this.db.prepare(`
            SELECT DISTINCT
              CASE WHEN r.source_entity = e1.id THEN e2.name ELSE e1.name END as connected_name,
              CASE WHEN r.source_entity = e1.id THEN e2.id ELSE e1.id END as connected_id,
              r.id AS edge_id, r.relationType AS relation_type, r.confidence,
              CASE WHEN r.source_entity = e1.id THEN 'out' ELSE 'in' END AS direction
            FROM entities e1
            JOIN relationships r ON (r.source_entity = e1.id OR r.target_entity = e1.id)
            JOIN entities e2 ON (e2.id = r.source_entity OR e2.id = r.target_entity)
            WHERE e1.name = ? AND e2.name != ?
            ORDER BY r.id`).all(entity, entity) as any[];
        for (const row of rows) connected.push({ entity_id: row.connected_id, name: row.connected_name, via_seed_id: '', via_seed_name: entity,
                                                  edge_id: row.edge_id, relation_type: row.relation_type, direction: row.direction,
                                                  confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence) });
      }
      return { status: 'entity-text-fallback', query_variants: variants, seeds: [], connected };
    }
  }
```

Then replace the block at `index.ts:3652-3730` (from `// Get entity information for graph enhancement via vector similarity` through the closing `}` of `if (useGraph && !vectorDegraded) { ... }`) with:

```ts
    // Get entity information for graph enhancement — via the diagnostic seam (evaluation change
    // graph-role-evaluation R2). Same SQL, same threshold, same fallback; hybridSearch consumes only names.
    let connectedEntities = new Set<string>();
    let queryMatchedEntities = new Set<string>();
    if (useGraph && !vectorDegraded) {
      const ctx = await this.explainGraphContext(query, queryVariants);
      for (const s of ctx.seeds) queryMatchedEntities.add(s.name);
      for (const c of ctx.connected) connectedEntities.add(c.name);
    }
```

⚠ Keep the pre-existing behaviour that the fallback path leaves `queryMatchedEntities` empty (it only filled `connectedEntities`) — the seam returns `seeds: []` on fallback, so the sets match. ⚠ The original loop dedups via `Set` semantics; the seam keeps rows, but the sets are rebuilt from names, so downstream is unchanged.

- [ ] **Step 8: Build, run parity + contract tests**

Run: `npm run build > /tmp/b.log 2>&1; echo EXIT:$?; node test/graph-context-explain.test.mjs; echo EXIT:$?; node test/search-graph-default.test.mjs; echo EXIT:$?`
Expected: `graph-context-explain: ALL OK` (parity identical + contract), `search-graph-default: ALL OK`, all EXIT:0. If parity differs, the diff tells you exactly which case/field moved — fix the extraction, not the golden.

- [ ] **Step 9: Wire into verify:engine and run the whole gate**

Edit `package.json` `verify:engine`: append `&& node test/graph-context-explain.test.mjs`.
Run: `npm test > /tmp/t.log 2>&1; echo EXIT:$?` → Expected `EXIT:0` (37 test commands).

- [ ] **Step 10: Commit**

```bash
git add index.ts package.json test/graph-context-explain.test.mjs
git commit -m "feat(search): extract explainGraphContext diagnostic seam (behaviour-preserving)

hybridSearch(useGraph:true) now obtains its seed and connected entity name sets from a public
diagnostic method that also exposes edge id, relation type, seed-relative direction and confidence.
Ranking is unchanged: the pre-extraction golden (nine cases, controlled embeddings) replays
byte-identical, and the useGraph default/opt-in contract tests still pass. The seam exists so the
graph-role evaluation harness measures exactly what the product computes instead of a copy."
```

---

### Task 2: Harness foundation — paths, DB copies, freeze, RRF, PRNG, thresholds

**Files:**
- Create: `eval/graph-role/.gitignore`, `eval/graph-role/README.md`, `eval/graph-role/thresholds.json`
- Create: `eval/graph-role/lib/paths.mjs`, `lib/db.mjs`, `lib/freeze.mjs`, `lib/rrf.mjs`, `lib/prng.mjs`
- Create: `eval/graph-role/snapshot.mjs`
- Create: `test/eval-graph-role-libs.test.mjs` (pure-lib tests; later tasks append sections)
- Modify: `package.json` `verify:engine` (append `&& node test/eval-graph-role-libs.test.mjs`)

**Interfaces:**
- Produces: `CORPORA = { hub, uap, hal }` each `{ label, live: absolutePath, copy: 'eval/graph-role/dbs/<label>.db' }`; `LIVE_PATHS: Set<string>`
- Produces: `openCorpus({ dbPath, label }) → { m, db, fallbackHits(), close() }` (throws `RefuseLiveDb` → exit 4 in CLIs)
- Produces: `sha256File(p)`, `readFreeze(dir)`, `assertFrozen({ dir, rel, allowUnfrozen }) → { frozen:boolean }`, `validateSuite(rows) → string[]` (errors)
- Produces: `rrf(lists, k=60) → Array<{id, score}>`, `cutK(list, K)`, `cutUniqueDoc(list, K, docOf)`
- Produces: `mulberry32(seed) → () => number`, `shuffle(arr, rng)`, `pick(arr, n, rng)`
- Consumed by: every runner (T3–T8).

- [ ] **Step 1: gitignore, thresholds, README skeleton**

`eval/graph-role/.gitignore`:
```
dbs/
```
`eval/graph-role/thresholds.json` (proposal D8 values — frozen before holdout; every number carries its rationale key):
```json
{
  "version": 1,
  "MCID_candidate_recall30_doc": 0.05,
  "MCID_rerank_ndcg10": 0.05,
  "MCID_semantics_vs_shuffle_null": 0.03,
  "p_null_max": 0.05,
  "K_noninferiority_delta_hit5": 0.02,
  "latency_slo_ms": { "warm_p95_max": 1000, "record_cold_p95": true },
  "upstream_gate": { "seed_recall_min": 0.70, "link_precision_name_min": 0.60, "edge_validity_min": 0.80 },
  "kappa_gate_weighted": 0.67,
  "human_audit": { "pairs_per_corpus": 50, "max_disagreement_rate": 0.20 },
  "judging_budget_per_corpus": 8000,
  "bootstrap": { "iters": 10000, "seed": 20260817 },
  "power": { "target": 0.8, "alpha": 0.05 },
  "budgets_K": [10, 30, 100],
  "controls": { "shuffled_replicates": 20, "typeshuf_replicates": 5, "swap_passes_per_edge": 20, "n2_fanout_cap": 50 },
  "rationale": "MCID_rerank raised from +0.02 (needs ~784 queries per r4) to a product-meaningful +0.05; all values are pre-registered, not validated; may only change before holdout is opened (log in FREEZE.md)."
}
```
`eval/graph-role/README.md` (skeleton; T8 completes the run order):
```markdown
# graph-role evaluation harness

Runs ONLY on `.backup` copies (`dbs/`, gitignored). Summaries are forced off. One measuring process at a time.
Order: snapshot → suite freeze → controls → run-candidates/run-final (all conditions) → pool → judging → qrel freeze → upstream → report → power.
Exit codes: 3 FROZEN_MISMATCH · 4 REFUSE_LIVE_DB · 5 SUITE_INVALID · 6 CONTROL_DEGREE_MISMATCH · 7 POOL_INCOMPLETE · 8 KAPPA_BELOW_GATE · 9 MODEL_NOT_READY · 10 SOURCE_MTIME_CHANGED · 11 JUDGE_INCOMPLETE · 12 ADJUDICATION_PENDING.
```

- [ ] **Step 2: paths + PRNG + RRF libs**

`eval/graph-role/lib/paths.mjs`:
```js
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
export const EVAL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));       // eval/graph-role
export const REPO_ROOT = resolve(EVAL_DIR, '..', '..');
export const DIST_INDEX = join(REPO_ROOT, 'dist', 'index.js');
const HOME = process.env.HOME;
export const CORPORA = {
  hub: { label: 'hub', live: `${HOME}/Library/CloudStorage/GoogleDrive-heesong.koh@gmail.com/My Drive/PARADocumentSystem/--1-PROJECTS/RAGMemory-Claude-memory-management-and-optimised-workflow/.memory/rag-memory.db` },
  uap: { label: 'uap', live: `${HOME}/Library/CloudStorage/GoogleDrive-heesong.koh@gmail.com/My Drive/PARADocumentSystem/--0-CollectLOG/Ultimate_AI_Personal_Assistant/.memory/rag-memory.db` },
  hal: { label: 'hal', live: `${HOME}/Development/Halal_Assistant_incubator_active/.memory/rag-memory.db` },
};
for (const c of Object.values(CORPORA)) c.copy = join(EVAL_DIR, 'dbs', `${c.label}.db`);
export const LIVE_PATHS = new Set(Object.values(CORPORA).map(c => resolve(c.live)));
export const dbFor = (label, cond = 'real') => cond === 'real' ? CORPORA[label].copy : join(EVAL_DIR, 'dbs', `${label}.${cond}.db`);
```
`eval/graph-role/lib/prng.mjs`:
```js
export function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function shuffle(arr, rng) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
export function pick(arr, n, rng) { return shuffle(arr, rng).slice(0, n); }
```
`eval/graph-role/lib/rrf.mjs`:
```js
// Reciprocal rank fusion over ranked id lists. Deterministic: ties broken by id asc.
export function rrf(lists, k = 60) {
  const score = new Map();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (k + i + 1)));
  return [...score.entries()].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}
export const cutK = (list, K) => list.slice(0, K);
export function cutUniqueDoc(list, K, docOf) {   // first K distinct documents, keeps chunk order
  const seen = new Set(); const out = [];
  for (const x of list) { const d = docOf(x.id ?? x); if (seen.has(d)) continue; seen.add(d); out.push(x); if (out.length >= K) break; }
  return out;
}
```

- [ ] **Step 3: freeze lib**

`eval/graph-role/lib/freeze.mjs`:
```js
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './paths.mjs';
export const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
export function readFreeze(dir = join(EVAL_DIR, 'suite')) {
  const p = join(dir, 'FREEZE.md'); if (!existsSync(p)) return new Map();
  const m = new Map();
  for (const line of readFileSync(p, 'utf8').split('\n')) { const mm = line.match(/^\| `([^`]+)` \| ([0-9a-f]{64}) \|/); if (mm) m.set(mm[1], mm[2]); }
  return m;
}
export function assertFrozen({ rel, allowUnfrozen = false, dir = join(EVAL_DIR, 'suite'), fileDir = dir }) {
  const want = readFreeze(dir).get(rel); const have = sha256File(join(fileDir, rel));
  if (want === have) return { frozen: true };
  if (allowUnfrozen) { console.error(`UNFROZEN ${rel} (recorded=${want ?? 'none'} actual=${have.slice(0, 12)})`); return { frozen: false }; }
  console.error(`FROZEN_MISMATCH ${rel}`); process.exit(3);
}
const CLASSES = new Set(['K', 'A', 'M']), SPLITS = new Set(['dev', 'holdout']), DIRS = new Set(['out', 'in', 'any']);
export function validateSuite(rows) {
  const errs = []; const ids = new Set(); const famSplit = new Map(); const kDocs = new Map();
  rows.forEach((r, i) => {
    const at = `row ${i} (${r.id})`;
    if (!r.id || ids.has(r.id)) errs.push(`${at}: missing/duplicate id`); ids.add(r.id);
    if (!CLASSES.has(r.class)) errs.push(`${at}: class`); if (!SPLITS.has(r.split)) errs.push(`${at}: split`);
    if (!r.family) errs.push(`${at}: family`); if (typeof r.text !== 'string' || r.text.length < 8) errs.push(`${at}: text`);
    if (famSplit.has(r.family) && famSplit.get(r.family) !== r.split) errs.push(`${at}: family ${r.family} spans splits`); famSplit.set(r.family, r.split);
    if (r.class === 'K') { if (!r.oracle_chunk_id || !r.document_id) errs.push(`${at}: K needs oracle_chunk_id+document_id`); if (kDocs.has(r.document_id)) errs.push(`${at}: document ${r.document_id} used twice in K`); kDocs.set(r.document_id, r.id); }
    else {
      if (!Array.isArray(r.expected_entities) || r.expected_entities.length === 0) errs.push(`${at}: expected_entities`);
      if (!Array.isArray(r.seed_candidates) || r.seed_candidates.length === 0) errs.push(`${at}: seed_candidates`);
      if (!Array.isArray(r.source_docs) || r.source_docs.length === 0) errs.push(`${at}: source_docs`);
      if (!['source-grounded', 'kg-informed'].includes(r.author_mode)) errs.push(`${at}: author_mode`);
      for (const path of (r.expected_paths || [])) for (const e of path) if (!e.from || !e.to || !e.type || !DIRS.has(e.direction) || typeof e.required !== 'boolean') errs.push(`${at}: malformed edge ${JSON.stringify(e)}`);
      if (r.class === 'M' && !(r.expected_paths || []).some(p => p.length >= 2)) errs.push(`${at}: M needs a path with >= 2 edges`);
    }
  });
  return errs;
}
```

- [ ] **Step 4: DB opener (refuse live · summaries off · ready gate · fallback counter)**

`eval/graph-role/lib/db.mjs`:
```js
import { resolve } from 'node:path';
import { LIVE_PATHS, DIST_INDEX } from './paths.mjs';
export class RefuseLiveDb extends Error {}
export async function openCorpus({ dbPath, label }) {
  const abs = resolve(dbPath);
  if (LIVE_PATHS.has(abs)) throw new RefuseLiveDb(`REFUSE_LIVE_DB ${abs}`);
  process.env.DB_FILE_PATH = abs;                                   // read once at import — one corpus per process
  process.env.RAG_MEMORY_NO_AUTOSTART = '1';
  process.env.RAG_MEMORY_SEARCH_SUMMARIES = 'off';                  // R10: isolate incident C
  const mod = await import(DIST_INDEX);
  const m = new mod.RAGKnowledgeGraphManager();
  await m.initialize();
  await m.gate.start();
  try { await m.startReconciliation(); } catch {}
  if (!m.gate.isReady) { console.error(`ABORT model_not_ready state=${m.gate.status?.state}`); process.exit(9); }
  let fallbackHits = 0;
  const _err = console.error.bind(console);
  console.error = (...a) => { const s = a.map(String).join(' '); if (s.includes('Entity vector search for graph enhancement failed')) fallbackHits++; if (process.env.PROBE_QUIET !== '0') return; _err(...a); };
  return { m, db: m.db, label, fallbackHits: () => fallbackHits, log: _err, close: () => { try { m.cleanup(); } catch {} } };
}
export function exitOnRefuse(fn) { return fn().catch(e => { if (e instanceof RefuseLiveDb) { console.error(e.message); process.exit(4); } throw e; }); }
```

- [ ] **Step 5: snapshot script (online backup, hash, mtime proof)**

`eval/graph-role/snapshot.mjs`:
```js
// Makes .backup copies of the three corpora into eval/graph-role/dbs/ and records snapshot.json.
// Uses the sqlite3 CLI's `.backup` (Online Backup API; WAL-safe). Never opens the live DB for writing.
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPORA, EVAL_DIR, REPO_ROOT } from './lib/paths.mjs';
import { sha256File } from './lib/freeze.mjs';
mkdirSync(join(EVAL_DIR, 'dbs'), { recursive: true });
const engineCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim();
const snap = { taken_at: new Date().toISOString(), engine_commit: engineCommit, corpora: {} };
for (const c of Object.values(CORPORA)) {
  const before = statSync(c.live).mtimeMs;
  execFileSync('sqlite3', [c.live, `.backup '${c.copy}'`]);
  const after = statSync(c.live).mtimeMs;
  if (before !== after) { console.error(`SOURCE_MTIME_CHANGED ${c.label}`); process.exit(10); }
  snap.corpora[c.label] = { source: c.live, copy: c.copy, bytes: statSync(c.copy).size, sha256: sha256File(c.copy) };
  console.log(`${c.label}: ${snap.corpora[c.label].bytes} bytes sha256=${snap.corpora[c.label].sha256.slice(0, 12)}`);
}
writeFileSync(join(EVAL_DIR, 'snapshot.json'), JSON.stringify(snap, null, 2) + '\n');
```

- [ ] **Step 6: Failing pure-lib test (freeze/validate/rrf/prng)**

Create `test/eval-graph-role-libs.test.mjs` (T4/T5/T8 append sections to this file):
```js
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rrf, cutK, cutUniqueDoc } from '../eval/graph-role/lib/rrf.mjs';
import { mulberry32, shuffle } from '../eval/graph-role/lib/prng.mjs';
import { validateSuite, sha256File, readFreeze } from '../eval/graph-role/lib/freeze.mjs';
import { LIVE_PATHS } from '../eval/graph-role/lib/paths.mjs';

// rrf: deterministic fusion + tie-break by id
{
  const f = rrf([['a', 'b', 'c'], ['b', 'a', 'd']]);
  assert.deepEqual(f.map(x => x.id).slice(0, 2), ['a', 'b']);
  assert.equal(cutK(f, 2).length, 2);
  const uniq = cutUniqueDoc([{ id: 'x1' }, { id: 'x2' }, { id: 'y1' }], 2, id => id[0]);
  assert.deepEqual(uniq.map(u => u.id), ['x1', 'y1']);
  console.log('  OK: rrf/cutK/cutUniqueDoc');
}
// prng: seeded, reproducible
{ const a = shuffle([1, 2, 3, 4, 5], mulberry32(7)), b = shuffle([1, 2, 3, 4, 5], mulberry32(7)); assert.deepEqual(a, b); console.log('  OK: mulberry32 reproducible'); }
// validateSuite: leakage + family + schema
{
  const ok = [{ id: 'k1', class: 'K', split: 'dev', family: 'doc1', text: 'known item query text', oracle_chunk_id: 'c1', document_id: 'doc1' },
              { id: 'a1', class: 'A', split: 'dev', family: 'fam1', text: 'what relates to X', expected_entities: ['X'], seed_candidates: ['X'], source_docs: ['d'], author_mode: 'source-grounded', expected_paths: [] }];
  assert.deepEqual(validateSuite(ok), []);
  const bad = ok.concat([{ id: 'k2', class: 'K', split: 'holdout', family: 'doc1', text: 'another', oracle_chunk_id: 'c2', document_id: 'doc1' }]);
  const errs = validateSuite(bad);
  assert.ok(errs.some(e => /spans splits/.test(e)) && errs.some(e => /used twice/.test(e)));
  console.log('  OK: validateSuite catches leakage/family');
}
// freeze table parse + live paths present
{
  const d = mkdtempSync(join(tmpdir(), 'gr-'));
  writeFileSync(join(d, 'x.jsonl'), 'a\n');
  const h = sha256File(join(d, 'x.jsonl'));
  writeFileSync(join(d, 'FREEZE.md'), `| file | sha256 | at |\n|---|---|---|\n| \`x.jsonl\` | ${h} | now |\n`);
  assert.equal(readFreeze(d).get('x.jsonl'), h);
  rmSync(d, { recursive: true, force: true });
  assert.equal(LIVE_PATHS.size, 3);
  console.log('  OK: readFreeze parses table; 3 live paths registered');
}
console.log('eval-graph-role-libs: ALL OK');
```

- [ ] **Step 7: Run test (expect module-not-found until libs exist), then create libs, run again**

Run: `node test/eval-graph-role-libs.test.mjs; echo EXIT:$?` → after Steps 2–4 exist: `eval-graph-role-libs: ALL OK` EXIT:0.

- [ ] **Step 8: Take the snapshots (one process, live DBs idle) and verify refuse-live**

Run: `node eval/graph-role/snapshot.mjs` → Expected three lines with bytes/sha256, `snapshot.json` written, `dbs/` has 3 files, live mtimes unchanged (script exits 10 otherwise).
Run: `node -e "import('./eval/graph-role/lib/db.mjs').then(({openCorpus,exitOnRefuse})=>exitOnRefuse(()=>openCorpus({dbPath:process.env.HOME+'/Development/Halal_Assistant_incubator_active/.memory/rag-memory.db',label:'hal'})))"; echo EXIT:$?` → Expected `REFUSE_LIVE_DB …` EXIT:4.

- [ ] **Step 9: Wire test, run gate, commit**

`package.json` `verify:engine` += `&& node test/eval-graph-role-libs.test.mjs`. Run `npm test > /tmp/t.log 2>&1; echo EXIT:$?` → 0.
```bash
git add eval/graph-role/.gitignore eval/graph-role/README.md eval/graph-role/thresholds.json eval/graph-role/lib eval/graph-role/snapshot.mjs test/eval-graph-role-libs.test.mjs package.json
git commit -m "eval(graph-role): harness foundation — copies only, freeze discipline, RRF, seeded PRNG

Adds the evaluation harness skeleton for the graph-role decision (specs/changes/graph-role-evaluation).
Runners can only open .backup copies (live paths refuse with exit 4), summaries are forced off,
suites are sha256-frozen before any run, and thresholds are pre-registered in thresholds.json."
```
(Do NOT commit `dbs/` or `snapshot.json` secrets? — `snapshot.json` contains only paths/hashes; commit it.)

---

### Task 3: Suite protocol, authoring tools, pilot suites, first freeze

**Files:**
- Create: `eval/graph-role/suite/PROTOCOL.md`
- Create: `eval/graph-role/make-known-item.mjs`, `list-seeds.mjs`, `author-context.mjs`, `extract-observed.mjs`
- Create: `eval/graph-role/suite/queries.{hub,uap,hal}.jsonl` (authored), `suite/observed.{hub,uap,hal}.jsonl` (generated after freeze), `suite/FREEZE.md`

**Interfaces:**
- Consumes: `openCorpus`, `validateSuite`, `sha256File`, `mulberry32`
- Produces: query rows per R1 schema; `observed.<c>.jsonl` rows `{id, observed_paths:[{from,to,edge_id,relation_type,direction,confidence}]}`
- Consumed by: T5 runners (query text, class, split), T7 upstream (expected_* vs observed), T8 stats (family/document clusters)

- [ ] **Step 1: Write PROTOCOL.md (the authoring contract — the AI author follows it verbatim)**

`eval/graph-role/suite/PROTOCOL.md`:
```markdown
# Suite authoring protocol (frozen with the suites)

## Classes and units
- K known-item: unit = chunk. Generated by make-known-item.mjs (rowid-uniform sample, text ≥ 200 chars, query = 180-char excerpt starting at offset min(60, len-220)). One row per document; dev/holdout split by document (rowid parity of the document's first chunk).
- A associative: unit = document, graded 0/1/2. Question form = "what is connected to / what follows from / what does X relate to" about a topic entity.
- M multi-hop/bridge: unit = document, graded 0/1/2. Question mentions the context of A and asks for something reachable through B (bridge entity) — the answer document is not the one that mentions A.

## Source-grounded rule (independence from the graph)
The author may read ONLY: `documents.content` (via author-context.mjs) and the canonical `entities.name` list (to spell names exactly).
The author must NOT read `relationships`, `chunk_entities`, getNeighbors, or any search result while authoring.
Seed candidates come from list-seeds.mjs = entities whose canonical name appears literally in ≥ 3 documents (text count, not link count), stratified random by that count (low 3–5 / mid 6–20 / high > 20).
M queries: pick two documents that share a literal mention of one entity B: doc1 mentions A and B, doc2 mentions B and C. Write the question from doc1's context so that doc2 is the target. Record `expected_paths = [[{from:A,to:B,...},{from:B,to:C,...}]]` with `type`/`direction` as the text states them, else `"any"`.
`author_mode` = "source-grounded" for every row authored this way. If, for any row, the author consulted the KG (should not happen), mark "kg-informed" — such rows are excluded from edge-validity gold and counted only in encoded-path coverage.

## Row schema
See delta-spec R1. `family` = the seed entity name (A rows) or the target document id (M rows). `seed_candidates` = every canonical name in the question that could reasonably be the vector seed. `source_docs` = document ids read while authoring.

## Sizes (Stage 1 pilot, per corpus)
K: 30 dev + 30 holdout (holdout generated now but not used until Stage 2). A: 30 dev. M: 30 dev. Holdout A/M are authored in Stage 2 with N from POWER.md.

## Freeze
`freeze.mjs --validate` must pass; then record sha256 of each queries file in FREEZE.md and commit. Nothing under out/ may exist before the freeze commit. After the freeze commit, run extract-observed.mjs (writes observed.<c>.jsonl; queries files untouched).
```

- [ ] **Step 2: make-known-item.mjs (K rows, one per document, document-split)**

```js
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCorpus, exitOnRefuse } from './lib/db.mjs';
import { CORPORA, EVAL_DIR } from './lib/paths.mjs';
const label = process.argv[2]; const perSplit = parseInt(process.argv[3] || '30', 10);
if (!CORPORA[label]) { console.error('usage: node make-known-item.mjs <hub|uap|hal> [perSplit]'); process.exit(2); }
await exitOnRefuse(async () => {
  const { db, close } = await openCorpus({ dbPath: CORPORA[label].copy, label });
  const rows = db.prepare(`SELECT rowid, chunk_id, document_id, text FROM chunk_metadata WHERE chunk_type='document' AND LENGTH(text) >= 200 ORDER BY rowid`).all();
  const firstRowidOfDoc = new Map(); for (const r of rows) if (!firstRowidOfDoc.has(r.document_id)) firstRowidOfDoc.set(r.document_id, r.rowid);
  const total = rows.length, step = Math.max(1, Math.floor(total / (perSplit * 4)));
  const out = []; const usedDocs = new Set();
  for (let i = 0; i < rows.length && out.length < perSplit * 2; i += step) {
    const r = rows[i]; if (usedDocs.has(r.document_id)) continue;
    const start = Math.min(60, Math.max(0, r.text.length - 220)); const q = r.text.slice(start, start + 180).replace(/\s+/g, ' ').trim();
    if (q.length < 40) continue;
    const split = (firstRowidOfDoc.get(r.document_id) % 2 === 0) ? 'dev' : 'holdout';
    if (out.filter(x => x.split === split).length >= perSplit) continue;
    usedDocs.add(r.document_id);
    out.push({ id: `${label}-K-${out.length + 1}`, class: 'K', split, family: r.document_id, text: q, oracle_chunk_id: r.chunk_id, document_id: r.document_id, notes: `rowid ${r.rowid} step ${step}` });
  }
  const p = join(EVAL_DIR, 'suite', `queries.${label}.jsonl`);
  writeFileSync(p, out.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log(`${label}: K rows ${out.length} (dev ${out.filter(x => x.split === 'dev').length} / holdout ${out.filter(x => x.split === 'holdout').length}) -> ${p}`);
  close();
});
```
Run: `node eval/graph-role/make-known-item.mjs hub 30` (then uap, hal). Expected: `K rows 60 (dev 30 / holdout 30)` each.

- [ ] **Step 3: list-seeds.mjs (text-based seed candidates; NO degree, NO neighbours)**

```js
import { openCorpus, exitOnRefuse } from './lib/db.mjs';
import { CORPORA } from './lib/paths.mjs';
import { mulberry32, shuffle } from './lib/prng.mjs';
const label = process.argv[2]; const n = parseInt(process.argv[3] || '45', 10);
await exitOnRefuse(async () => {
  const { db, close } = await openCorpus({ dbPath: CORPORA[label].copy, label });
  const ents = db.prepare(`SELECT id, name, entityType FROM entities`).all();
  const docs = db.prepare(`SELECT id, content FROM documents`).all();
  const lower = docs.map(d => ({ id: d.id, c: d.content.toLowerCase(), title: (d.content.match(/^#\s*(.+)$/m) || [, d.id])[1].slice(0, 80) }));
  const rows = [];
  for (const e of ents) {
    const nm = e.name.toLowerCase(); if (nm.length < 4) continue;
    const hits = lower.filter(d => d.c.includes(nm));
    if (hits.length >= 3) rows.push({ name: e.name, type: e.entityType, docs: hits.length, titles: hits.slice(0, 3).map(h => h.title) });
  }
  const strat = { low: rows.filter(r => r.docs <= 5), mid: rows.filter(r => r.docs > 5 && r.docs <= 20), high: rows.filter(r => r.docs > 20) };
  const rng = mulberry32(2026); const per = Math.ceil(n / 3);
  for (const [k, arr] of Object.entries(strat)) for (const r of shuffle(arr, rng).slice(0, per)) console.log(`${k}\t${r.docs}\t${r.type}\t${r.name}\t${r.titles.join(' | ')}`);
  console.error(`candidates low/mid/high = ${strat.low.length}/${strat.mid.length}/${strat.high.length} of ${rows.length} (text-mention ≥3)`);
  close();
});
```

- [ ] **Step 4: author-context.mjs (document text for authoring; entity names for spelling)**

```js
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
```

- [ ] **Step 5: Author A 30 + M 30 per corpus (AI author, protocol §Source-grounded)**

For each corpus: run `list-seeds.mjs <c> 45`, pick 30 seeds (10 per stratum); for each seed run `author-context.mjs <c> cooccur "<name>"` to find co-mentioning documents and `doc <id>` to read them; write A rows; for M, choose bridge pairs (doc1: A,B · doc2: B,C) from the same tool; append rows to `suite/queries.<c>.jsonl` after the K rows. Every row: `author_mode: "source-grounded"`, `source_docs` = ids actually read, `seed_candidates` ⊇ names mentioned in the question, `family` per PROTOCOL. ⚠ Do not run any search, getNeighbors, or read relationships/chunk_entities while authoring.

- [ ] **Step 6: Validate, freeze, commit; then extract observed paths**

`freeze.mjs --validate` CLI (append to `lib/freeze.mjs` bottom):
```js
if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--validate')) {
  const { readFileSync, existsSync, readdirSync } = await import('node:fs');
  const dir = join(EVAL_DIR, 'suite'); let bad = 0;
  for (const f of readdirSync(dir).filter(f => /^queries\.\w+\.jsonl$/.test(f))) {
    const rows = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const errs = validateSuite(rows); console.log(`${f}: rows ${rows.length} errors ${errs.length}`); errs.forEach(e => console.log('  ' + e)); bad += errs.length;
  }
  if (existsSync(join(EVAL_DIR, 'out')) && readdirSync(join(EVAL_DIR, 'out')).length) { console.log('OUT_NOT_EMPTY: runners ran before freeze'); bad++; }
  process.exit(bad ? 5 : 0);
}
```
Run: `node eval/graph-role/lib/freeze.mjs --validate; echo EXIT:$?` → 0. Then write `suite/FREEZE.md`:
```markdown
# FREEZE — suites/thresholds are hashed here BEFORE any run
| file | sha256 | frozen_at | commit |
|---|---|---|---|
| `queries.hub.jsonl` | <sha256File> | 2026-08-.. | (fill after commit) |
| `queries.uap.jsonl` | ... | | |
| `queries.hal.jsonl` | ... | | |
| `../thresholds.json` | ... | | |
```
(fill the hashes with `node -e "import('./eval/graph-role/lib/freeze.mjs').then(f=>console.log(f.sha256File('eval/graph-role/suite/queries.hub.jsonl')))"` etc.), commit `eval(graph-role): freeze pilot suites (K 60 · A 30 · M 30 per corpus)`, then put the commit hash into FREEZE.md and amend? — no: make a second tiny commit `docs: record freeze commit hash`.
Then `extract-observed.mjs`:
```js
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
```
Run per corpus; commit `eval(graph-role): observed paths extracted after freeze`.

---

### Task 4: Controls — degree-preserving edge swaps (replicates), type-preserving, random

**Files:**
- Create: `eval/graph-role/lib/controls.mjs`, `eval/graph-role/make-controls.mjs`
- Modify: `test/eval-graph-role-libs.test.mjs` (append controls section)

**Interfaces:**
- Produces: `degreePreservingSwap(edges, { seed, passes, typePreserving }) -> { edges, swaps }` where an edge is `{ id, source, target, type, confidence, metadata, created_at }`; `erdosRenyi(edges, nodeIds, seed) -> edges`; `degreeSignature(edges) -> Map<nodeId, [inDeg, outDeg]>`; `sameSignature(a, b) -> boolean`
- Consumed by: `make-controls.mjs` (writes `dbs/<c>.shuffled-r{i}.db`, `dbs/<c>.typeshuf-r{i}.db`, `dbs/<c>.random.db`), T5 runners via `dbFor(label, cond)`.

- [ ] **Step 1: Failing test (append to test/eval-graph-role-libs.test.mjs)**

```js
// controls: node-level (in,out) degree preserved exactly; no self-loops; no duplicates; type-preserving keeps per-type degrees
{
  const { degreePreservingSwap, degreeSignature, sameSignature, erdosRenyi } = await import('../eval/graph-role/lib/controls.mjs');
  const mk = (i, s, t, ty) => ({ id: `e${i}`, source: s, target: t, type: ty, confidence: 1, metadata: '{}', created_at: 'x' });
  const edges = [mk(1,'a','b','R'), mk(2,'a','c','R'), mk(3,'b','c','S'), mk(4,'c','d','S'), mk(5,'d','a','R'), mk(6,'b','d','R'), mk(7,'e','a','S'), mk(8,'e','b','R')];
  const { edges: sh, swaps } = degreePreservingSwap(edges, { seed: 1, passes: 20 });
  assert.ok(sameSignature(degreeSignature(edges), degreeSignature(sh)), 'node-level (in,out) must be identical');
  assert.ok(sh.every(e => e.source !== e.target), 'no self-loops');
  assert.equal(new Set(sh.map(e => `${e.source}>${e.target}`)).size, sh.length, 'no duplicate directed edges');
  assert.ok(swaps > 0 && JSON.stringify(sh) !== JSON.stringify(edges), 'graph actually changed');
  const { edges: ts } = degreePreservingSwap(edges, { seed: 2, passes: 20, typePreserving: true });
  const byType = (es) => { const m = new Map(); for (const e of es) { const k = e.type; const sig = m.get(k) || new Map(); const s = sig.get(e.source) || [0,0]; s[1]++; sig.set(e.source, s); const t = sig.get(e.target) || [0,0]; t[0]++; sig.set(e.target, t); m.set(k, sig); } return m; };
  for (const [ty, sig] of byType(edges)) assert.ok(sameSignature(sig, byType(ts).get(ty)), `per-type degrees kept for ${ty}`);
  const er = erdosRenyi(edges, ['a','b','c','d','e'], 3);
  assert.equal(er.length, edges.length, 'ER keeps |E|');
  console.log('  OK: controls — degree-preserving swap (node-level), type-preserving, ER');
}
```

- [ ] **Step 2: Implement lib/controls.mjs**

```js
// Edge rewiring controls for the graph-role evaluation (R5). Directed double-edge swap:
// pick two edges (u->v, x->y), rewire to (u->y, x->v) if it creates no self-loop and no duplicate.
// Each node keeps its exact (in,out) degree; relation type/confidence travel with the edge row.
import { mulberry32 } from './prng.mjs';
export function degreeSignature(edges) {
  const m = new Map();
  for (const e of edges) { const s = m.get(e.source) || [0, 0]; s[1]++; m.set(e.source, s); const t = m.get(e.target) || [0, 0]; t[0]++; m.set(e.target, t); }
  return m;
}
export function sameSignature(a, b) {
  if (!b || a.size !== b.size) return false;
  for (const [k, v] of a) { const w = b.get(k); if (!w || w[0] !== v[0] || w[1] !== v[1]) return false; }
  return true;
}
export function degreePreservingSwap(edges, { seed = 0, passes = 20, typePreserving = false } = {}) {
  const rng = mulberry32(seed);
  const es = edges.map(e => ({ ...e }));
  const key = (s, t) => `${s} ${t}`;
  const present = new Set(es.map(e => key(e.source, e.target)));
  const groups = typePreserving ? [...new Set(es.map(e => e.type))].map(t => es.map((e, i) => e.type === t ? i : -1).filter(i => i >= 0)) : [es.map((_, i) => i)];
  let swaps = 0;
  for (const idx of groups) {
    if (idx.length < 2) continue;
    const target = idx.length * passes; let tries = 0; let done = 0;
    while (done < target && tries < target * 20) {
      tries++;
      const i = idx[Math.floor(rng() * idx.length)], j = idx[Math.floor(rng() * idx.length)]; if (i === j) continue;
      const a = es[i], b = es[j];
      const ns = a.source, nt = b.target, ms = b.source, mt = a.target;    // a: ns->nt, b: ms->mt
      if (ns === nt || ms === mt) continue;
      if (present.has(key(ns, nt)) || present.has(key(ms, mt))) continue;
      present.delete(key(a.source, a.target)); present.delete(key(b.source, b.target));
      a.target = nt; b.target = mt;
      present.add(key(a.source, a.target)); present.add(key(b.source, b.target));
      done++; swaps++;
    }
  }
  return { edges: es, swaps };
}
export function erdosRenyi(edges, nodeIds, seed = 0) {
  const rng = mulberry32(seed); const present = new Set(); const out = [];
  while (out.length < edges.length) {
    const s = nodeIds[Math.floor(rng() * nodeIds.length)], t = nodeIds[Math.floor(rng() * nodeIds.length)];
    if (s === t || present.has(`${s} ${t}`)) continue;
    present.add(`${s} ${t}`); const src = edges[out.length];
    out.push({ ...src, source: s, target: t });
  }
  return out;
}
```

- [ ] **Step 3: make-controls.mjs (copies + rewiring + node-level verification)**

```js
import { copyFileSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { CORPORA, dbFor } from './lib/paths.mjs';
import { degreePreservingSwap, degreeSignature, sameSignature, erdosRenyi } from './lib/controls.mjs';
const label = process.argv[2]; const th = JSON.parse(readFileSync(new URL('./thresholds.json', import.meta.url), 'utf8'));
const R = th.controls.shuffled_replicates, RT = th.controls.typeshuf_replicates, PASSES = th.controls.swap_passes_per_edge;
const src = new Database(CORPORA[label].copy, { readonly: true });
const edges = src.prepare(`SELECT id, source_entity AS source, target_entity AS target, relationType AS type, confidence, metadata, created_at FROM relationships ORDER BY id`).all();
const nodes = src.prepare(`SELECT id FROM entities`).all().map(r => r.id); src.close();
const base = degreeSignature(edges);
function writeControl(cond, newEdges, checkSig) {
  const p = dbFor(label, cond); copyFileSync(CORPORA[label].copy, p);
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
```
Run: `node eval/graph-role/make-controls.mjs hub` (then uap, hal). Expected: 26 files per corpus under `dbs/`, every `shuffled-r*`/`typeshuf-r*` passes the node-level check (no exit 6), swaps >= 0.9 x target (mixing). Note: the copies carry the vec0 tables (chunks/entity embeddings) unchanged — only `relationships` is rewritten; `chunk_entities` is intentionally untouched (that is the seed-linked-chunk caveat r4 raised: seed channels do not move under edge shuffles, which is why `graph-seed` and `graph-n1` are reported separately).

- [ ] **Step 4: Run libs test, commit**

`node test/eval-graph-role-libs.test.mjs; echo EXIT:$?` -> 0. Commit `eval(graph-role): edge-rewiring controls (degree-preserving replicates, type-preserving, ER)`.

---

### Task 5: Stage instrumentation, channels at fixed budgets, candidate + final runners

**Files:**
- Create: `eval/graph-role/lib/stages.mjs`, `eval/graph-role/run-candidates.mjs`, `eval/graph-role/run-final.mjs`
- Modify: `test/eval-graph-role-libs.test.mjs` (append: budgets/determinism using a fake `stages` input)

**Interfaces:**
- Produces: `channelsForQuery({ m, db, query, Ks, n2cap }) -> { seam, seeds, n_connected, n2_count, channels: { [name]: { chunk: {K: string[]}, doc: {K: string[]}, ms } }, reach: { chunks: number, docs: string[] }, docOf }` with channel names `vector | fts | graph-seed | graph-n1 | graph-n2 | graph-vec | rrf2 | rrf3 | rrf3-n2`
- Produces: `out/candidates.<c>.<cond>.jsonl` rows `{ id, class, split, cond, seam_status, seeds:[{name,sim}], n_connected, n2_count, channels:{name:{chunk10,chunk30,chunk100,doc10,doc30,doc100,ms}}, reach:{chunks, docs_n}, fallback, unfrozen }`
- Produces: `out/final.<c>.<cond>.jsonl` rows `{ id, class, split, cond, off:{top10:[{chunk_id,doc,vs,gb,fts,fin}], ms}, on:{...}, fixedpool_rerank:{base:[chunk ids], with_graph:[chunk ids], pool_n, ms}, mode, unfrozen }`
- Consumes: T1 seam, T2 libs, T3 suites, T4 controls.

- [ ] **Step 1: Failing pure test (budgets + determinism, using an in-memory fake)**

Append to `test/eval-graph-role-libs.test.mjs`:
```js
{
  const { rankGraphChunks, applyBudgets } = await import('../eval/graph-role/lib/stages.mjs');
  // rankGraphChunks: chunk score = sum over distinct matched entities of entity score; tie -> chunk_id asc
  const linked = [ { chunk_id: 'c2', entity_id: 'B' }, { chunk_id: 'c1', entity_id: 'A' }, { chunk_id: 'c1', entity_id: 'B' }, { chunk_id: 'c1', entity_id: 'B' } ];
  const ranked = rankGraphChunks(linked, new Map([['A', 0.6], ['B', 0.3]]));
  assert.deepEqual(ranked.map(r => r.chunk_id), ['c1', 'c2']); assert.ok(Math.abs(ranked[0].score - 0.9) < 1e-9, 'B counted once for c1');
  const tie = rankGraphChunks([{ chunk_id: 'z', entity_id: 'A' }, { chunk_id: 'y', entity_id: 'A' }], new Map([['A', 1]]));
  assert.deepEqual(tie.map(r => r.chunk_id), ['y', 'z'], 'tie-break chunk_id asc');
  const b = applyBudgets(['d1_c1', 'd1_c2', 'd2_c1', 'd3_c1'], [2, 3], id => id.split('_')[0]);
  assert.deepEqual(b.chunk[2], ['d1_c1', 'd1_c2']); assert.deepEqual(b.doc[2].map(x => x.id ?? x), ['d1_c1', 'd2_c1']);
  console.log('  OK: stages — graph chunk ranking (dedup, tie-break) and chunk/doc budgets');
}
```

- [ ] **Step 2: Implement lib/stages.mjs**

```js
// Stage instrumentation for one query: seam (product 1-hop) -> harness 2-hop -> chunk links -> channels at fixed budgets.
import { rrf, cutK, cutUniqueDoc } from './rrf.mjs';
import { DIST_INDEX } from './paths.mjs';
export function rankGraphChunks(linkRows, entityScore) {           // linkRows: {chunk_id, entity_id}
  const per = new Map();
  for (const r of linkRows) { const s = entityScore.get(r.entity_id); if (s === undefined) continue; const set = per.get(r.chunk_id) || new Map(); set.set(r.entity_id, s); per.set(r.chunk_id, set); }
  return [...per.entries()].map(([chunk_id, m]) => ({ chunk_id, score: [...m.values()].reduce((a, b) => a + b, 0) })).sort((a, b) => b.score - a.score || (a.chunk_id < b.chunk_id ? -1 : 1));
}
export function applyBudgets(chunkIds, Ks, docOf) {
  const out = { chunk: {}, doc: {} };
  for (const K of Ks) { out.chunk[K] = cutK(chunkIds, K); out.doc[K] = cutUniqueDoc(chunkIds, K, docOf); }
  return out;
}
const now = () => Number(process.hrtime.bigint() / 1000000n);
let compileFts = null;
async function ftsCompiler() { if (!compileFts) { const mod = await import(DIST_INDEX); compileFts = mod.compileFtsLiteralQuery; } return compileFts; }
export async function channelsForQuery({ m, db, query, Ks = [10, 30, 100], n2cap = 50 }) {
  const docOfStmt = db.prepare(`SELECT document_id FROM chunk_metadata WHERE chunk_id = ?`); const docCache = new Map();
  const docOf = (id) => { if (!docCache.has(id)) docCache.set(id, docOfStmt.get(id)?.document_id ?? id); return docCache.get(id); };
  const KMAX = Math.max(...Ks); const ms = {};
  // vector channel: product path with graph off at limit=KMAX (limit*3 pool -> top KMAX)
  let t = now(); const off = await m.hybridSearch(query, KMAX, false); ms.vector = now() - t;
  const vector = off.results.map(r => r.chunk_id);
  // fts channel: BM25 only (same expression builder as the product)
  t = now();
  const compile = await ftsCompiler(); const ftsExpr = compile ? compile(query) : null;
  const fts = ftsExpr ? db.prepare(`SELECT cm.chunk_id FROM chunks_fts JOIN chunk_metadata cm ON chunks_fts.rowid = cm.rowid WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`).all(ftsExpr, KMAX).map(r => r.chunk_id) : [];
  ms.fts = now() - t;
  // seam: seeds + 1-hop (product), then harness 2-hop
  t = now(); const seam = await m.explainGraphContext(query); ms.seam = now() - t;
  const seedScore = new Map(seam.seeds.map(s => [s.entity_id, s.similarity]));
  const n1Score = new Map();
  for (const c of seam.connected) { const via = seedScore.get(c.via_seed_id) ?? 0; const s = via * 0.5; if ((n1Score.get(c.entity_id) ?? -1) < s) n1Score.set(c.entity_id, s); }
  const nb = db.prepare(`SELECT CASE WHEN source_entity = ? THEN target_entity ELSE source_entity END AS nid FROM relationships WHERE source_entity = ? OR target_entity = ? ORDER BY id LIMIT ?`);
  const n2Score = new Map();
  for (const [eid, s1] of [...n1Score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    for (const r of nb.all(eid, eid, eid, n2cap)) { if (seedScore.has(r.nid) || n1Score.has(r.nid)) continue; const s = s1 * 0.5; if ((n2Score.get(r.nid) ?? -1) < s) n2Score.set(r.nid, s); }
  }
  const links = (ids) => ids.length ? db.prepare(`SELECT cm.chunk_id, ce.entity_id FROM chunk_entities ce JOIN chunk_metadata cm ON cm.rowid = ce.chunk_rowid WHERE ce.entity_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  t = now(); const gSeed = rankGraphChunks(links([...seedScore.keys()]), seedScore).map(r => r.chunk_id); ms['graph-seed'] = now() - t;
  t = now(); const gN1 = rankGraphChunks(links([...n1Score.keys()]), n1Score).map(r => r.chunk_id); ms['graph-n1'] = now() - t;
  t = now(); const gN2 = rankGraphChunks(links([...n2Score.keys()]), n2Score).map(r => r.chunk_id); ms['graph-n2'] = now() - t;
  const reachSet = new Set([...gSeed, ...gN1, ...gN2]);
  // graph-vec: graph-n1 eligible set ordered by query-chunk vector similarity (upper bound, not semantics)
  t = now(); let gVec = [];
  if (gN1.length && seam.status === 'vector') {
    const emb = await m.generateEmbedding(query, 1024, true);
    const rows = db.prepare(`SELECT cm.chunk_id, c.distance FROM chunks c JOIN chunk_metadata cm ON cm.rowid = c.rowid WHERE c.embedding MATCH ? AND k = ?`).all(Buffer.from(emb.buffer), Math.min(4096, Math.max(KMAX * 10, gN1.length)));
    const inSet = new Set(gN1); gVec = rows.filter(r => inSet.has(r.chunk_id)).sort((a, b) => a.distance - b.distance || (a.chunk_id < b.chunk_id ? -1 : 1)).map(r => r.chunk_id);
  } ms['graph-vec'] = now() - t;
  const rrf2 = rrf([vector, fts]).map(x => x.id), rrf3 = rrf([vector, fts, gN1]).map(x => x.id), rrf3n2 = rrf([vector, fts, gN1, gN2]).map(x => x.id);
  const chans = { vector, fts, 'graph-seed': gSeed, 'graph-n1': gN1, 'graph-n2': gN2, 'graph-vec': gVec, rrf2, rrf3, 'rrf3-n2': rrf3n2 };
  const channels = {}; for (const [name, ids] of Object.entries(chans)) channels[name] = { ...applyBudgets(ids, Ks, docOf), ms: ms[name] ?? null };
  return { seam, seeds: seam.seeds, n_connected: seam.connected.length, n2_count: n2Score.size, channels, reach: { chunks: reachSet.size, docs: [...new Set([...reachSet].map(docOf))] }, docOf };
}
```
`compileFtsLiteralQuery` is already exported from `index.ts` (line 84, `export function compileFtsLiteralQuery`), so the dynamic import from `DIST_INDEX` above works without touching product code (verified 2026-08-17 on main 5ae46c3). Note `cutUniqueDoc` returns the input elements (strings here), so `doc[K]` is a list of chunk ids.

- [ ] **Step 3: run-candidates.mjs**

```js
import { readFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openCorpus, exitOnRefuse } from './lib/db.mjs';
import { CORPORA, EVAL_DIR, dbFor } from './lib/paths.mjs';
import { assertFrozen } from './lib/freeze.mjs';
import { channelsForQuery } from './lib/stages.mjs';
const args = process.argv.slice(2); const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const label = get('--corpus'), cond = get('--cond', 'real'), split = get('--split', 'dev'), unfrozenFlag = args.includes('--unfrozen');
if (!CORPORA[label]) { console.error('usage: run-candidates.mjs --corpus <c> [--cond real|shuffled-rN|typeshuf-rN|random] [--split dev|holdout] [--unfrozen]'); process.exit(2); }
const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const { frozen } = assertFrozen({ rel: `queries.${label}.jsonl`, allowUnfrozen: unfrozenFlag });
assertFrozen({ rel: '../thresholds.json', allowUnfrozen: unfrozenFlag });
await exitOnRefuse(async () => {
  const { m, db, log, fallbackHits, close } = await openCorpus({ dbPath: dbFor(label, cond), label });
  const rows = readFileSync(join(EVAL_DIR, 'suite', `queries.${label}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.split === split);
  mkdirSync(join(EVAL_DIR, 'out'), { recursive: true });
  const outPath = join(EVAL_DIR, 'out', `candidates.${label}.${cond}.jsonl`); if (existsSync(outPath)) unlinkSync(outPath);
  let i = 0;
  for (const r of rows) {
    i++; const fb0 = fallbackHits();
    const c = await channelsForQuery({ m, db, query: r.text, Ks: th.budgets_K, n2cap: th.controls.n2_fanout_cap });
    const rec = { id: r.id, class: r.class, split: r.split, cond, seam_status: c.seam.status, seeds: c.seeds.map(s => ({ name: s.name, sim: +s.similarity.toFixed(4) })), n_connected: c.n_connected, n2_count: c.n2_count,
                  channels: Object.fromEntries(Object.entries(c.channels).map(([k, v]) => [k, { chunk10: v.chunk[10], chunk30: v.chunk[30], chunk100: v.chunk[100], doc10: v.doc[10], doc30: v.doc[30], doc100: v.doc[100], ms: v.ms }])),
                  reach: { chunks: c.reach.chunks, docs_n: c.reach.docs.length }, fallback: fallbackHits() - fb0, unfrozen: !frozen };
    appendFileSync(outPath, JSON.stringify(rec) + '\n');
    log(`[${label}/${cond}] ${i}/${rows.length} ${r.id} seeds=${c.seeds.length} n1=${c.n_connected} n2=${c.n2_count} reach=${c.reach.chunks}`);
  }
  close(); log(`DONE ${outPath} rows=${i}`);
});
```

- [ ] **Step 4: run-final.mjs (product off/on + fixed-pool rerank)**

```js
import { readFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openCorpus, exitOnRefuse } from './lib/db.mjs';
import { CORPORA, EVAL_DIR, dbFor } from './lib/paths.mjs';
import { assertFrozen } from './lib/freeze.mjs';
const args = process.argv.slice(2); const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const label = get('--corpus'), cond = get('--cond', 'real'), split = get('--split', 'dev'), unfrozenFlag = args.includes('--unfrozen');
if (!CORPORA[label]) { console.error('usage: run-final.mjs --corpus <c> [--cond ...] [--split dev|holdout] [--unfrozen]'); process.exit(2); }
const { frozen } = assertFrozen({ rel: `queries.${label}.jsonl`, allowUnfrozen: unfrozenFlag });
const now = () => Number(process.hrtime.bigint() / 1000000n);
const comp = (r) => ({ chunk_id: r.chunk_id, doc: r.source_id ?? null, vs: +(r.vector_similarity ?? 0).toFixed(4), gb: r.graph_boost === undefined ? null : +r.graph_boost.toFixed(4), fts: +(r.fts_boost ?? 0).toFixed(4), fin: +(r.relevance_score ?? 0).toFixed(4) });
await exitOnRefuse(async () => {
  const { m, log, close } = await openCorpus({ dbPath: dbFor(label, cond), label });
  const rows = readFileSync(join(EVAL_DIR, 'suite', `queries.${label}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.split === split);
  mkdirSync(join(EVAL_DIR, 'out'), { recursive: true });
  const outPath = join(EVAL_DIR, 'out', `final.${label}.${cond}.jsonl`); if (existsSync(outPath)) unlinkSync(outPath);
  let i = 0;
  for (const r of rows) {
    i++;
    let t = now(); const off = await m.hybridSearch(r.text, 10, false); const msOff = now() - t;   // first query of the process = cold, rest warm
    t = now(); const on = await m.hybridSearch(r.text, 10, true); const msOn = now() - t;
    // fixed-pool rerank: pool = product graph-off top-30; "with_graph" reorders that same pool by the product's useGraph:true score
    t = now(); const off30 = await m.hybridSearch(r.text, 30, false); const on30 = await m.hybridSearch(r.text, 30, true);
    const onScore = new Map(on30.results.map(x => [x.chunk_id, x.relevance_score]));
    const base = off30.results.map(x => x.chunk_id);
    const withGraph = off30.results.map(x => ({ id: x.chunk_id, s: onScore.get(x.chunk_id) ?? x.relevance_score })).sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1)).map(x => x.id);
    const msRerank = now() - t;
    const rec = { id: r.id, class: r.class, split: r.split, cond, off: { top10: off.results.map(comp), ms: msOff }, on: { top10: on.results.map(comp), ms: msOn }, fixedpool_rerank: { base: base.slice(0, 10), with_graph: withGraph.slice(0, 10), pool_n: base.length, ms: msRerank }, mode: on.search_mode, cold: i === 1, unfrozen: !frozen };
    appendFileSync(outPath, JSON.stringify(rec) + '\n');
    log(`[${label}/${cond}] final ${i}/${rows.length} ${r.id} ms off/on=${msOff}/${msOn}`);
  }
  close(); log(`DONE ${outPath} rows=${i}`);
});
```
Note: `with_graph` reuses the product's `useGraph:true` score only for chunks already in the graph-off pool; chunks the graph path would have *added* are deliberately excluded (fixed-pool = pure rerank evidence; candidate addition is measured by rrf3 in run-candidates). This definition goes into DECISION.md.

- [ ] **Step 5: Smoke on hub dev real, then run all conditions (one process at a time)**

Run: `node eval/graph-role/run-candidates.mjs --corpus hub --cond real --split dev` -> row count == dev rows of hub (K 30 + A 30 + M 30 = 90), `fallback` 0, `seam_status` `vector` for all rows (else stop and inspect).
Then a serial driver (bash), NEVER parallel:
```bash
for c in hub uap hal; do for cond in real $(seq -f "shuffled-r%g" 0 19) $(seq -f "typeshuf-r%g" 0 4) random; do
  node eval/graph-role/run-candidates.mjs --corpus $c --cond $cond --split dev > eval/graph-role/out/log.candidates.$c.$cond.txt 2>&1; echo "candidates $c $cond EXIT:$?"
  node eval/graph-role/run-final.mjs      --corpus $c --cond $cond --split dev > eval/graph-role/out/log.final.$c.$cond.txt 2>&1; echo "final $c $cond EXIT:$?"
done; done
```
Expected: 3 x 26 x 2 = 156 JSONL files; every EXIT:0. Cost estimate: 90 queries x ~1.5 s x 26 conds x 3 corpora x 2 runners ~ 6 h serial — run in the background with a completion notification; per-query timing is in the logs.

- [ ] **Step 6: Commit runners + outputs**

`git add eval/graph-role/lib/stages.mjs eval/graph-role/run-candidates.mjs eval/graph-role/run-final.mjs eval/graph-role/out test/eval-graph-role-libs.test.mjs` then commit `eval(graph-role): stage/channel/final runners + dev outputs (all conditions)`.

---

### Task 6: Pooling, blind judging, weighted-kappa gate, qrel freeze

**Files:**
- Create: `eval/graph-role/pool.mjs`, `eval/graph-role/suite/JUDGING.md`, `eval/graph-role/judge-merge.mjs`
- Create (generated): `eval/graph-role/pool/<c>.pool.jsonl`, `pool/<c>.judge.jsonl`, `pool/<c>.judge-A.jsonl`, `pool/<c>.judge-B.jsonl`, `pool/<c>.adjudicated.jsonl`, `pool/<c>.unpooled.jsonl`, `suite/qrels.<c>.jsonl`, `suite/human-audit.<c>.jsonl` (optional)
- Modify: `test/eval-graph-role-libs.test.mjs` (append weighted kappa test)

**Interfaces:**
- Produces: `pool.mjs --corpus <c>` -> `pool/<c>.judge.jsonl` rows `{ jid, qid, class, query, doc_id, doc_title, chunk_id, chunk_text, prev_text, next_text }` (channel/condition stripped; order = seeded shuffle); exit 7 if any channel x condition file (real + shuffled-r0 + random + final) is missing.
- Produces: judge output rows `{ jid, grade: 0|1|2, rationale }` (one file per judge); `judge-merge.mjs` -> `suite/qrels.<c>.jsonl` rows `{ qid, doc_id, chunk_id, grade, judges:[a,b,c?], grade_source:'agree'|'adjudicated', qrels_grade:'decision-grade'|'LLM-judged provisional' }` + kappa report; exit 8 if weighted kappa < gate.
- Produces: `weightedKappa(a, b, levels=3)` in `lib/metrics.mjs` (T8 file — created here first with just this function; T8 extends it).

- [ ] **Step 1: JUDGING.md (frozen protocol)**

```markdown
# Judging protocol (frozen with qrels)
- Unit judged: chunk (with title + adjacent chunks shown). Document grade = max over its judged chunks.
- Scale: 0 = not relevant to the question · 1 = partially relevant (touches the topic/relationship but does not answer it) · 2 = relevant (a reader exploring this question would want this passage).
- Blind: judges see jid, query text, class (K/A/M), doc title, chunk text, previous+next chunk text. They never see channel, condition, scores, or other judges' output.
- Judge A = Claude (fresh subagent per corpus; record model id in the output file header) · Judge B = codex (record model id) · Adjudicator C = a fresh context that sees the query, the chunk, and both grades+rationales, and outputs a final grade. temperature 0 where the API allows.
- Input order: `pool/<c>.judge.jsonl` is shuffled with seed 20260817 + corpus index; judges process in file order.
- Gate: quadratic weighted kappa (A vs B) per corpus and per class >= 0.67 (thresholds.json kappa_gate_weighted). Below the gate: revise the rubric examples in this file, re-run BOTH judges on the whole corpus, discard the earlier outputs (keep them in pool/rejected/).
- Adjudication: every A/B disagreement goes to C. Human adjudication replaces C when the user has time.
- Human audit: `suite/human-audit.<c>.jsonl` = 50 pairs per corpus, stratified by class x final grade, including agreed items. Disagreement rate <= 20% -> qrels are `decision-grade`; otherwise or if absent -> `LLM-judged provisional` (no `remove-from-ranking` decision may be issued on provisional qrels).
- Prompt (identical for A and B): "You judge relevance for a retrieval evaluation. For each item output JSON {jid, grade, rationale<=25 words}. Grade 2 if a reader exploring the QUESTION would want this PASSAGE, 1 if it only touches the topic, 0 otherwise. Judge the passage as it stands; do not reward length or link count."
```

- [ ] **Step 2: pool.mjs**

```js
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CORPORA, EVAL_DIR } from './lib/paths.mjs';
import { mulberry32, shuffle, pick } from './lib/prng.mjs';
const label = process.argv[2]; const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const need = ['real', 'shuffled-r0', 'random'];
const files = need.flatMap(c => [`candidates.${label}.${c}.jsonl`, `final.${label}.${c}.jsonl`]).map(f => join(EVAL_DIR, 'out', f));
const missing = files.filter(f => !existsSync(f)); if (missing.length) { console.error(`POOL_INCOMPLETE missing ${missing.map(f => f.split('/').pop()).join(', ')}`); process.exit(7); }
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const queries = new Map(readJsonl(join(EVAL_DIR, 'suite', `queries.${label}.jsonl`)).map(q => [q.id, q]));
const pooled = new Map();   // qid -> Map(chunk_id -> tier) ; tier 'top30' = in some channel's top-30 or a final list, 'deep' = only in ranks 31..100
const add = (qid, ids, tier) => { const s = pooled.get(qid) || new Map(); for (const id of ids) if (id && (tier === 'top30' || !s.has(id))) s.set(id, tier === 'top30' ? 'top30' : (s.get(id) || 'deep')); pooled.set(qid, s); };
for (const c of need) {
  for (const r of readJsonl(join(EVAL_DIR, 'out', `candidates.${label}.${c}.jsonl`))) { if (r.class === 'K') continue; for (const ch of Object.values(r.channels)) { add(r.id, ch.chunk30, 'top30'); add(r.id, ch.chunk100.slice(30), 'deep'); } }
  for (const r of readJsonl(join(EVAL_DIR, 'out', `final.${label}.${c}.jsonl`))) { if (r.class === 'K') continue; add(r.id, r.off.top10.map(x => x.chunk_id), 'top30'); add(r.id, r.on.top10.map(x => x.chunk_id), 'top30'); add(r.id, r.fixedpool_rerank.with_graph, 'top30'); }
}
const db = new Database(CORPORA[label].copy, { readonly: true });
const meta = db.prepare(`SELECT cm.chunk_id, cm.document_id, cm.chunk_index, cm.text FROM chunk_metadata cm WHERE cm.chunk_id = ?`);
const neighbor = db.prepare(`SELECT text FROM chunk_metadata WHERE document_id = ? AND chunk_index = ?`);
const title = db.prepare(`SELECT substr(content, 1, 120) AS t FROM documents WHERE id = ?`);
mkdirSync(join(EVAL_DIR, 'pool'), { recursive: true });
const rows = []; let jn = 0; const stats = { queries: 0, chunks: 0, docs: 0 };
for (const [qid, set] of pooled) {
  const q = queries.get(qid); stats.queries++;
  const docsSeen = new Set();
  for (const [chunk_id, tier] of [...set.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const m = meta.get(chunk_id); if (!m) continue; stats.chunks++; docsSeen.add(m.document_id);
    rows.push({ jid: `${label}-J${++jn}`, tier, qid, class: q.class, query: q.text, doc_id: m.document_id, doc_title: (title.get(m.document_id)?.t || m.document_id).replace(/\s+/g, ' ').slice(0, 100), chunk_id, chunk_text: m.text,
                prev_text: neighbor.get(m.document_id, m.chunk_index - 1)?.text ?? '', next_text: neighbor.get(m.document_id, m.chunk_index + 1)?.text ?? '' });
  }
  stats.docs += docsSeen.size;
}
const corpusIndex = { hub: 0, uap: 1, hal: 2 }[label];
const shuffled = shuffle(rows, mulberry32(th.bootstrap.seed + corpusIndex));
writeFileSync(join(EVAL_DIR, 'pool', `${label}.pool.jsonl`), rows.map(r => JSON.stringify({ qid: r.qid, chunk_id: r.chunk_id, doc_id: r.doc_id, jid: r.jid })).join('\n') + '\n');
writeFileSync(join(EVAL_DIR, 'pool', `${label}.judge.jsonl`), shuffled.map(r => JSON.stringify(r)).join('\n') + '\n');
// unpooled random sample (missed-relevant rate): 100 (query, chunk) pairs not in the pool
const allChunks = db.prepare(`SELECT chunk_id, document_id FROM chunk_metadata WHERE chunk_type='document'`).all();
const rng = mulberry32(th.bootstrap.seed + 100 + corpusIndex); const unp = [];
const qids = [...pooled.keys()];
while (unp.length < 100) { const qid = qids[Math.floor(rng() * qids.length)]; const c = allChunks[Math.floor(rng() * allChunks.length)]; if (pooled.get(qid).has(c.chunk_id)) continue; const m = meta.get(c.chunk_id); const q = queries.get(qid);
  unp.push({ jid: `${label}-U${unp.length + 1}`, qid, class: q.class, query: q.text, doc_id: m.document_id, doc_title: (title.get(m.document_id)?.t || m.document_id).slice(0, 100), chunk_id: c.chunk_id, chunk_text: m.text, prev_text: '', next_text: '' }); }
writeFileSync(join(EVAL_DIR, 'pool', `${label}.unpooled.jsonl`), unp.map(r => JSON.stringify(r)).join('\n') + '\n');
const nTop = rows.filter(r => r.tier === 'top30').length, nDeep = rows.length - nTop;
console.log(`${label}: pooled queries ${stats.queries} chunks ${stats.chunks} (top30 ${nTop} · deep ${nDeep}; query-doc pairs ${stats.docs}) budget ${th.judging_budget_per_corpus}${stats.chunks > th.judging_budget_per_corpus ? ' OVER_BUDGET' : ''}; unpooled 100`);
db.close();
```
Expected on hub dev: pooled queries 60 (A+M), chunks in the low thousands split into `tier: top30` and `tier: deep`. **Incremental pooling rule (proposal D2, always applied):** judges receive the `top30` tier first; the `deep` tier (ranks 31–100) is judged only for queries whose top-30 tier produced ≥ 1 relevant document that only ONE channel found (i.e. the pool is not saturated). Record which queries got the deep tier in FREEZE.md; if the total still exceeds `judging_budget_per_corpus`, the excess queries' deep tier is skipped and those queries are flagged `pool_truncated:true` in qrels.

- [ ] **Step 3: Judge runs (LLM steps, orchestrated; outputs are files)**

For each corpus: (A) dispatch a fresh Claude subagent with JUDGING.md prompt + `pool/<c>.judge.jsonl` in batches of 40 items -> `pool/<c>.judge-A.jsonl` (header line `{meta:true, judge:'A', model:'<id>', at:'<iso>'}`); (B) run codex (`mcp__codex-tool__codex`, read-only, cwd = worktree) with the same prompt in batches -> `pool/<c>.judge-B.jsonl`; also both judges on `pool/<c>.unpooled.jsonl` -> `pool/<c>.unpooled-A.jsonl` / `-B.jsonl`. Every output row: `{jid, grade, rationale}`.

- [ ] **Step 4: weightedKappa test (append) + judge-merge.mjs**

Append to `test/eval-graph-role-libs.test.mjs`:
```js
{
  const { weightedKappa } = await import('../eval/graph-role/lib/metrics.mjs');
  assert.equal(weightedKappa([0,1,2,0,1,2], [0,1,2,0,1,2]), 1);
  assert.ok(Math.abs(weightedKappa([0,0,1,1,2,2], [0,1,1,2,2,0]) - 0.0526) < 0.01, 'quadratic weighted kappa hand-computed');
  console.log('  OK: weighted kappa');
}
```
`eval/graph-role/lib/metrics.mjs` (initial content; T8 appends the rest):
```js
// Quadratic weighted Cohen's kappa for ordinal grades 0..L-1.
export function weightedKappa(a, b, L = 3) {
  const n = a.length; if (n !== b.length || n === 0) throw new Error('length');
  const O = Array.from({ length: L }, () => Array(L).fill(0)); const ra = Array(L).fill(0), rb = Array(L).fill(0);
  for (let i = 0; i < n; i++) { O[a[i]][b[i]]++; ra[a[i]]++; rb[b[i]]++; }
  let num = 0, den = 0;
  for (let i = 0; i < L; i++) for (let j = 0; j < L; j++) { const w = ((i - j) ** 2) / ((L - 1) ** 2); num += w * O[i][j]; den += w * (ra[i] * rb[j]) / n; }
  return den === 0 ? 1 : 1 - num / den;
}
```
`eval/graph-role/judge-merge.mjs`:
```js
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './lib/paths.mjs';
import { weightedKappa } from './lib/metrics.mjs';
const label = process.argv[2]; const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.meta);
const items = readJsonl(join(EVAL_DIR, 'pool', `${label}.judge.jsonl`));
const A = new Map(readJsonl(join(EVAL_DIR, 'pool', `${label}.judge-A.jsonl`)).map(r => [r.jid, r.grade]));
const B = new Map(readJsonl(join(EVAL_DIR, 'pool', `${label}.judge-B.jsonl`)).map(r => [r.jid, r.grade]));
const Cp = join(EVAL_DIR, 'pool', `${label}.adjudicated.jsonl`); const C = existsSync(Cp) ? new Map(readJsonl(Cp).map(r => [r.jid, r.grade])) : new Map();
const missing = items.filter(i => !A.has(i.jid) || !B.has(i.jid)); if (missing.length) { console.error(`JUDGE_INCOMPLETE ${missing.length} items lack a grade`); process.exit(11); }
const byClass = { all: [], A: [], M: [] };
for (const i of items) { byClass.all.push([A.get(i.jid), B.get(i.jid)]); (byClass[i.class] ||= []).push([A.get(i.jid), B.get(i.jid)]); }
const kap = {}; let below = false;
for (const [k, pairs] of Object.entries(byClass)) { if (!pairs.length) continue; kap[k] = +weightedKappa(pairs.map(p => p[0]), pairs.map(p => p[1])).toFixed(3); if (kap[k] < th.kappa_gate_weighted) below = true; }
console.log(`${label}: weighted kappa ${JSON.stringify(kap)} gate ${th.kappa_gate_weighted}`);
if (below) { console.error('KAPPA_BELOW_GATE'); process.exit(8); }
const disagreements = items.filter(i => A.get(i.jid) !== B.get(i.jid));
const unresolved = disagreements.filter(i => !C.has(i.jid));
if (unresolved.length) { writeFileSync(join(EVAL_DIR, 'pool', `${label}.to-adjudicate.jsonl`), unresolved.map(i => JSON.stringify({ ...i, grade_A: A.get(i.jid), grade_B: B.get(i.jid) })).join('\n') + '\n'); console.error(`ADJUDICATION_PENDING ${unresolved.length} of ${disagreements.length} disagreements -> pool/${label}.to-adjudicate.jsonl`); process.exit(12); }
const auditP = join(EVAL_DIR, 'suite', `human-audit.${label}.jsonl`); let grade = 'LLM-judged provisional', auditNote = 'no human audit';
if (existsSync(auditP)) { const H = readJsonl(auditP); const finalOf = (jid) => C.has(jid) ? C.get(jid) : A.get(jid); const dis = H.filter(h => finalOf(h.jid) !== h.grade).length; const rate = dis / H.length; auditNote = `human audit ${H.length} pairs, disagreement ${(rate * 100).toFixed(1)}%`; if (H.length >= th.human_audit.pairs_per_corpus && rate <= th.human_audit.max_disagreement_rate) grade = 'decision-grade'; }
const rows = items.map(i => { const a = A.get(i.jid), b = B.get(i.jid); const g = a === b ? a : C.get(i.jid); return { qid: i.qid, doc_id: i.doc_id, chunk_id: i.chunk_id, grade: g, judges: a === b ? [a, b] : [a, b, C.get(i.jid)], grade_source: a === b ? 'agree' : 'adjudicated', qrels_grade: grade }; });
writeFileSync(join(EVAL_DIR, 'suite', `qrels.${label}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`${label}: qrels ${rows.length} rows · ${grade} · ${auditNote} · disagreements ${disagreements.length}`);
```
Then FREEZE `qrels.<c>.jsonl` (append hashes to FREEZE.md, commit `eval(graph-role): qrels frozen (pilot dev)`).

---

### Task 7: Upstream metrics and link-precision audit

**Files:**
- Create: `eval/graph-role/run-upstream.mjs`, `eval/graph-role/link-audit-sample.mjs`, `eval/graph-role/link-audit-merge.mjs`
- Modify: `test/eval-graph-role-libs.test.mjs` (append provenance test)

**Interfaces:**
- Produces: `out/upstream.<c>.jsonl` rows `{ id, class, seed_recall: 0|1, seeds_hit:[names], edge_validity: { total, exists, direction_ok, type_ok, required_missing }, encoded_path_coverage: number|null, projection_recall: number|null, hubdeg_misrank: { gold_rank_off, above_gold_link_counts:[...] } }`
- Produces: `provenanceOf(chunkText, entityName) -> 'name' | 'nonliteral'` (in `lib/stages.mjs`, mirrors product `buildEntityMatcher`: Latin word boundary, CJK substring)
- Produces: `pool/<c>.links.judge.jsonl` rows `{ jid, chunk_id, chunk_text, entity_name, provenance, stratum }` and `out/link-precision.<c>.json` `{ by_stratum:{low,mid,high}, by_provenance:{name,nonliteral}, weighted_precision, ci95 }` (chunk-cluster bootstrap).

- [ ] **Step 1: provenance test (append)**
```js
{
  const { provenanceOf } = await import('../eval/graph-role/lib/stages.mjs');
  assert.equal(provenanceOf('The Alpha Node appears here', 'Alpha Node'), 'name');
  assert.equal(provenanceOf('The AlphaNode appears here', 'Alpha Node'), 'nonliteral');
  assert.equal(provenanceOf('할랄 인증 기준', '할랄'), 'name');
  assert.equal(provenanceOf('SuperAPI runs', 'API'), 'nonliteral');   // word boundary for Latin
  console.log('  OK: provenance name/nonliteral');
}
```
Add to `lib/stages.mjs`:
```js
const hasCJK = (s) => /[぀-ヿ㐀-鿿가-힯]/.test(s);
export function provenanceOf(text, name) {
  const lower = name.toLowerCase(), t = text.toLowerCase();
  if (hasCJK(name)) return t.includes(lower) ? 'name' : 'nonliteral';
  const esc = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i').test(text) ? 'name' : 'nonliteral';
}
```

- [ ] **Step 2: run-upstream.mjs**
```js
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CORPORA, EVAL_DIR } from './lib/paths.mjs';
import { assertFrozen } from './lib/freeze.mjs';
const label = process.argv[2];
assertFrozen({ rel: `queries.${label}.jsonl` }); assertFrozen({ rel: `qrels.${label}.jsonl` });
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const queries = readJsonl(join(EVAL_DIR, 'suite', `queries.${label}.jsonl`)).filter(q => q.class !== 'K');
const observed = new Map(readJsonl(join(EVAL_DIR, 'suite', `observed.${label}.jsonl`)).map(o => [o.id, o.observed_paths]));
const cand = new Map(readJsonl(join(EVAL_DIR, 'out', `candidates.${label}.real.jsonl`)).map(r => [r.id, r]));
const fin = new Map(readJsonl(join(EVAL_DIR, 'out', `final.${label}.real.jsonl`)).map(r => [r.id, r]));
const qrels = readJsonl(join(EVAL_DIR, 'suite', `qrels.${label}.jsonl`));
const goldDocs = new Map(); for (const q of qrels) if (q.grade >= 1) (goldDocs.get(q.qid) || goldDocs.set(q.qid, new Set()).get(q.qid)).add(q.doc_id);
const db = new Database(CORPORA[label].copy, { readonly: true });
const linkCount = db.prepare(`SELECT COUNT(*) c FROM chunk_entities ce JOIN chunk_metadata cm ON cm.rowid = ce.chunk_rowid WHERE cm.chunk_id = ?`);
const idOf = new Map(db.prepare(`SELECT id, name FROM entities`).all().map(r => [r.name, r.id]));
const docsOfEntities = (names) => { const ids = names.map(n => idOf.get(n)).filter(Boolean); if (!ids.length) return new Set(); return new Set(db.prepare(`SELECT DISTINCT cm.document_id d FROM chunk_entities ce JOIN chunk_metadata cm ON cm.rowid = ce.chunk_rowid WHERE ce.entity_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(r => r.d)); };
const out = [];
for (const q of queries) {
  const c = cand.get(q.id); if (!c) continue;
  const seedNames = new Set(c.seeds.map(s => s.name));
  const seeds_hit = q.seed_candidates.filter(n => seedNames.has(n));
  const obs = observed.get(q.id) || []; const expEdges = (q.expected_paths || []).flat();
  const ev = { total: expEdges.length, exists: 0, direction_ok: 0, type_ok: 0, required_missing: 0 };
  for (const e of expEdges) { const hits = obs.filter(o => o.from === e.from && o.to === e.to && o.edge_id); if (hits.length) { ev.exists++; if (e.direction === 'any' || hits.some(h => h.direction === e.direction)) ev.direction_ok++; if (e.type === 'any' || hits.some(h => h.relation_type === e.type)) ev.type_ok++; } else if (e.required) ev.required_missing++; }
  const gold = goldDocs.get(q.id) || new Set();
  const connectedDocs = docsOfEntities([...new Set((c.seeds.map(s => s.name)))]);   // seeds' docs; connected names are not in candidates rows -> recompute via seam if needed (harness keeps names in final run? no) -> use graph-n1 doc100 as the projection proxy
  const n1Docs = new Set((c.channels['graph-n1'].doc100 || []).map(id => id.split('_chunk_')[0]));
  const projection_recall = gold.size ? [...gold].filter(d => n1Docs.has(d) || connectedDocs.has(d)).length / gold.size : null;
  const f = fin.get(q.id); let hub = null;
  if (f && gold.size) { const top = f.off.top10; const gi = top.findIndex(x => gold.has(x.doc)); hub = { gold_rank_off: gi < 0 ? -1 : gi + 1, above_gold_link_counts: gi > 0 ? top.slice(0, gi).map(x => linkCount.get(x.chunk_id).c) : [] }; }
  out.push({ id: q.id, class: q.class, author_mode: q.author_mode, seed_recall: seeds_hit.length ? 1 : 0, seeds_hit, edge_validity: ev, encoded_path_coverage: q.author_mode === 'kg-informed' ? (ev.total ? ev.exists / ev.total : null) : null, projection_recall, hubdeg_misrank: hub });
}
writeFileSync(join(EVAL_DIR, 'out', `upstream.${label}.jsonl`), out.map(r => JSON.stringify(r)).join('\n') + '\n');
const n = out.length, sr = out.filter(o => o.seed_recall).length, evT = out.reduce((a, o) => a + o.edge_validity.total, 0), evE = out.reduce((a, o) => a + o.edge_validity.exists, 0);
console.log(`${label}: n=${n} seed_recall ${sr}/${n} edge_validity ${evE}/${evT} (source-grounded rows only counted where author_mode=source-grounded: ${out.filter(o => o.author_mode === 'source-grounded').length})`);
```
Note: `doc100` items are chunk ids; document id is recovered with `split('_chunk_')[0]` because chunk ids in this engine are `<documentId>_chunk_<n>` (verify once with `SELECT chunk_id, document_id FROM chunk_metadata LIMIT 3` on the copy; if the pattern differs, join through `chunk_metadata` instead).

- [ ] **Step 3: link-audit-sample.mjs + judging + link-audit-merge.mjs**
```js
// link-audit-sample.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CORPORA, EVAL_DIR } from './lib/paths.mjs';
import { mulberry32, shuffle } from './lib/prng.mjs';
import { provenanceOf } from './lib/stages.mjs';
const label = process.argv[2]; const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const db = new Database(CORPORA[label].copy, { readonly: true });
const chunks = db.prepare(`SELECT cm.rowid, cm.chunk_id, cm.text, (SELECT COUNT(*) FROM chunk_entities ce WHERE ce.chunk_rowid = cm.rowid) AS links FROM chunk_metadata cm WHERE cm.chunk_type='document'`).all();
const strata = { low: chunks.filter(c => c.links >= 1 && c.links <= 5), mid: chunks.filter(c => c.links > 5 && c.links <= 30), high: chunks.filter(c => c.links > 30) };
const rng = mulberry32(th.bootstrap.seed + 7); const linksOf = db.prepare(`SELECT e.name FROM chunk_entities ce JOIN entities e ON e.id = ce.entity_id WHERE ce.chunk_rowid = ? ORDER BY e.name`);
const rows = []; let j = 0; const prevalence = {};
for (const [s, arr] of Object.entries(strata)) { prevalence[s] = arr.length; for (const c of shuffle(arr, rng).slice(0, 20)) { const names = shuffle(linksOf.all(c.rowid).map(r => r.name), rng).slice(0, 15); for (const nm of names) rows.push({ jid: `${label}-L${++j}`, stratum: s, chunk_id: c.chunk_id, chunk_links: c.links, entity_name: nm, provenance: provenanceOf(c.text, nm), chunk_text: c.text }); } }
mkdirSync(join(EVAL_DIR, 'pool'), { recursive: true });
writeFileSync(join(EVAL_DIR, 'pool', `${label}.links.judge.jsonl`), shuffle(rows, rng).map(r => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(join(EVAL_DIR, 'pool', `${label}.links.prevalence.json`), JSON.stringify(prevalence) + '\n');
console.log(`${label}: link pairs ${rows.length} (name ${rows.filter(r => r.provenance === 'name').length} / nonliteral ${rows.filter(r => r.provenance === 'nonliteral').length}) prevalence ${JSON.stringify(prevalence)}`);
db.close();
```
Judging prompt (one judge + 20% second-judge sample): "Is ENTITY actually mentioned/referred to in this PASSAGE (exact concept, not a mere string coincidence)? Output {jid, mention: 1|0}." -> `pool/<c>.links.judge-A.jsonl`.
```js
// link-audit-merge.mjs — precision by stratum/provenance with chunk-cluster bootstrap CI and prevalence weighting
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './lib/paths.mjs';
import { mulberry32 } from './lib/prng.mjs';
const label = process.argv[2]; const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.meta);
const items = readJsonl(join(EVAL_DIR, 'pool', `${label}.links.judge.jsonl`)); const J = new Map(readJsonl(join(EVAL_DIR, 'pool', `${label}.links.judge-A.jsonl`)).map(r => [r.jid, r.mention]));
const prev = JSON.parse(readFileSync(join(EVAL_DIR, 'pool', `${label}.links.prevalence.json`), 'utf8'));
const byChunk = new Map(); for (const it of items) { if (!J.has(it.jid)) continue; (byChunk.get(it.chunk_id) || byChunk.set(it.chunk_id, []).get(it.chunk_id)).push({ ...it, ok: J.get(it.jid) }); }
const prec = (rows) => rows.length ? rows.filter(r => r.ok).length / rows.length : null;
const clusters = [...byChunk.values()];
const strat = (s) => clusters.filter(c => c[0].stratum === s).flat();
const by_stratum = Object.fromEntries(['low', 'mid', 'high'].map(s => [s, { n: strat(s).length, precision: prec(strat(s)) }]));
const by_provenance = Object.fromEntries(['name', 'nonliteral'].map(p => [p, { n: clusters.flat().filter(r => r.provenance === p).length, precision: prec(clusters.flat().filter(r => r.provenance === p)) }]));
const totalPrev = Object.values(prev).reduce((a, b) => a + b, 0);
const weighted = (cl) => ['low', 'mid', 'high'].reduce((acc, s) => { const rows = cl.filter(c => c[0].stratum === s).flat(); const p = prec(rows); return acc + (p === null ? 0 : p * (prev[s] / totalPrev)); }, 0);
const rng = mulberry32(th.bootstrap.seed + 8); const boots = [];
for (let b = 0; b < th.bootstrap.iters; b++) { const sample = Array.from({ length: clusters.length }, () => clusters[Math.floor(rng() * clusters.length)]); boots.push(weighted(sample)); }
boots.sort((a, b) => a - b);
const res = { by_stratum, by_provenance, weighted_precision: +weighted(clusters).toFixed(4), ci95: [+boots[Math.floor(0.025 * boots.length)].toFixed(4), +boots[Math.floor(0.975 * boots.length)].toFixed(4)], chunks: clusters.length, pairs: clusters.flat().length };
writeFileSync(join(EVAL_DIR, 'out', `link-precision.${label}.json`), JSON.stringify(res, null, 2) + '\n');
console.log(`${label}: link precision (name) ${by_provenance.name.precision} · weighted ${res.weighted_precision} CI ${res.ci95} · pairs ${res.pairs} in ${res.chunks} chunks`);
```
Commit `eval(graph-role): upstream metrics + link-precision audit`.

---

### Task 8: Metrics, report (gatekeeping), power -> POWER.md (freeze)

**Files:**
- Modify: `eval/graph-role/lib/metrics.mjs` (append), `test/eval-graph-role-libs.test.mjs` (append), `eval/graph-role/README.md` (complete run order)
- Create: `eval/graph-role/report.mjs`, `eval/graph-role/power.mjs`, `eval/graph-role/suite/POWER.md`

**Interfaces:**
- Produces (metrics.mjs): `hitAtK(rank, k)`, `recallAtKDoc(rankedChunkIds, goldDocs, docOf, K)`, `mrrDoc(ranked, goldDocs, docOf)`, `ndcg10Graded(ranked, gradeOfDoc, docOf)`, `signTestExact(worse, better) -> p(two-sided)`, `bootstrapPairedCI(deltas, clusterIds, { iters, seed }) -> [lo, hi]`, `oneSidedLowerCI(deltas, clusterIds, opts) -> lo95`, `holm(pvals) -> adjusted`, `powerN(sdDelta, mcid, { alpha, power }) -> n` (paired t approximation), `pctile(arr, p)`
- Produces: `out/report.md` (per corpus + stratified macro; primary endpoints in gatekeeping order; every metric line carries `n=... usable=...`), `suite/POWER.md` (paired SD/discordance per endpoint per corpus, N for power 0.8 at MCID, judging budget check).

- [ ] **Step 1: metrics tests (append) with hand-computed fixtures**
```js
{
  const M = await import('../eval/graph-role/lib/metrics.mjs');
  assert.equal(M.hitAtK(1, 1), 1); assert.equal(M.hitAtK(-1, 5), 0);
  const docOf = id => id.split('_')[0];
  assert.equal(M.recallAtKDoc(['d1_c1', 'd2_c1', 'd3_c1'], new Set(['d2', 'd9']), docOf, 2), 0.5);
  assert.equal(M.mrrDoc(['d1_c1', 'd2_c1'], new Set(['d2']), docOf), 0.5);
  const grade = { d1: 2, d2: 1 };
  const nd = M.ndcg10Graded(['d2_c1', 'd1_c1'], d => grade[d] || 0, docOf);   // DCG = 1/log2(2) + 3/log2(3) ; IDCG = 3/log2(2) + 1/log2(3)
  assert.ok(Math.abs(nd - ((1 + 3 / Math.log2(3)) / (3 + 1 / Math.log2(3)))) < 1e-9);
  assert.ok(Math.abs(M.signTestExact(8, 2) - 0.109375) < 1e-6, 'two-sided exact binomial 8 vs 2');
  const ci = M.bootstrapPairedCI([0.1, 0.2, 0.0, 0.3, 0.1, 0.2], ['a','a','b','b','c','c'], { iters: 2000, seed: 1 });
  assert.ok(ci[0] <= 0.15 && ci[1] >= 0.15 && ci[0] > -0.2 && ci[1] < 0.5);
  assert.deepEqual(M.holm([0.01, 0.04, 0.03]).map(x => +x.toFixed(2)), [0.03, 0.06, 0.06]);
  assert.ok(M.powerN(0.2, 0.05, { alpha: 0.05, power: 0.8 }) >= 120 && M.powerN(0.2, 0.05, { alpha: 0.05, power: 0.8 }) <= 130, 'n ≈ 126 (r4 example)');
  console.log('  OK: metrics (hit/recall/mrr/ndcg/sign/bootstrap/holm/power)');
}
```

- [ ] **Step 2: Implement metrics.mjs (append)**
```js
import { mulberry32 } from './prng.mjs';
export const hitAtK = (rank, k) => (rank > 0 && rank <= k) ? 1 : 0;
export function recallAtKDoc(ranked, goldDocs, docOf, K) { if (!goldDocs.size) return null; const seen = new Set(); for (const id of ranked.slice(0, K)) seen.add(docOf(id)); let hit = 0; for (const g of goldDocs) if (seen.has(g)) hit++; return hit / goldDocs.size; }
export function mrrDoc(ranked, goldDocs, docOf) { const seen = new Set(); let pos = 0; for (const id of ranked) { const d = docOf(id); if (seen.has(d)) continue; seen.add(d); pos++; if (goldDocs.has(d)) return 1 / pos; } return 0; }
export function ndcg10Graded(ranked, gradeOfDoc, docOf, allGoldDocs = null) {
  const seen = new Set(); const gains = [];
  for (const id of ranked) { const d = docOf(id); if (seen.has(d)) continue; seen.add(d); gains.push(gradeOfDoc(d)); if (gains.length === 10) break; }
  const dcg = gains.reduce((a, g, i) => a + (Math.pow(2, g) - 1) / Math.log2(i + 2), 0);
  const goldGrades = allGoldDocs ? [...allGoldDocs].map(gradeOfDoc) : gains.slice();
  const ideal = goldGrades.sort((a, b) => b - a).slice(0, 10).reduce((a, g, i) => a + (Math.pow(2, g) - 1) / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}
export function signTestExact(worse, better) { const n = worse + better; if (n === 0) return 1; const k = Math.min(worse, better); let p = 0; const C = (n, r) => { let x = 1; for (let i = 1; i <= r; i++) x = x * (n - r + i) / i; return x; }; for (let i = 0; i <= k; i++) p += C(n, i) / Math.pow(2, n); return Math.min(1, 2 * p); }
export function bootstrapPairedCI(deltas, clusterIds, { iters = 10000, seed = 20260817, alpha = 0.05 } = {}) {
  const groups = new Map(); deltas.forEach((d, i) => { const k = clusterIds ? clusterIds[i] : i; (groups.get(k) || groups.set(k, []).get(k)).push(d); });
  const cl = [...groups.values()]; const rng = mulberry32(seed); const means = [];
  for (let b = 0; b < iters; b++) { let s = 0, n = 0; for (let j = 0; j < cl.length; j++) { const g = cl[Math.floor(rng() * cl.length)]; for (const d of g) { s += d; n++; } } means.push(s / n); }
  means.sort((a, b) => a - b); return [means[Math.floor(alpha / 2 * iters)], means[Math.floor((1 - alpha / 2) * iters) - 1]];
}
export function oneSidedLowerCI(deltas, clusterIds, opts = {}) { return bootstrapPairedCI(deltas, clusterIds, { ...opts, alpha: 0.10 })[0]; }   // one-sided 95% lower = two-sided 90% lower
export function holm(pvals) { const idx = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]); const m = pvals.length; const adj = Array(m); let prev = 0; idx.forEach(([p, i], r) => { const v = Math.min(1, Math.max(prev, p * (m - r))); adj[i] = v; prev = v; }); return adj; }
export function powerN(sd, mcid, { alpha = 0.05, power = 0.8 } = {}) { const z = (p) => { /* inverse normal (Acklam) */ const a = [-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00], b = [-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01], c = [-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00], d = [7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00]; const pl = 0.02425; let q, r; if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); } if (p <= 1 - pl) { q = p - 0.5; r = q*q; return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1); } q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); };
  const za = z(1 - alpha / 2), zb = z(power); return Math.ceil(Math.pow((za + zb) * sd / mcid, 2)); }
export const pctile = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
```
(The test's `M.ndcg10Graded(['d2_c1','d1_c1'], ..., docOf)` uses the retrieved-only ideal because `allGoldDocs` is null; report.mjs passes the full gold set.)

- [ ] **Step 3: report.mjs (primary endpoints in gatekeeping order)**
```js
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './lib/paths.mjs';
import * as M from './lib/metrics.mjs';
const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const readJsonl = (p) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const docOf = (id) => id.split('_chunk_')[0];
const lines = ['# graph-role evaluation report (Stage 1 pilot · dev · SUMMARIES=off)', ''];
const line = (s) => lines.push(s);
const summary = {};   // corpus -> endpoint -> {delta, ci, n}
for (const label of ['hub', 'uap', 'hal']) {
  const Q = readJsonl(join(EVAL_DIR, 'suite', `queries.${label}.jsonl`)); const q = new Map(Q.map(x => [x.id, x]));
  const qrels = readJsonl(join(EVAL_DIR, 'suite', `qrels.${label}.jsonl`)); const gold = new Map(), grade = new Map();
  for (const r of qrels) { if (r.grade >= 1) (gold.get(r.qid) || gold.set(r.qid, new Set()).get(r.qid)).add(r.doc_id); const g = grade.get(r.qid) || grade.set(r.qid, new Map()).get(r.qid); g.set(r.doc_id, Math.max(g.get(r.doc_id) || 0, r.grade)); }
  const cand = readJsonl(join(EVAL_DIR, 'out', `candidates.${label}.real.jsonl`)); const fin = readJsonl(join(EVAL_DIR, 'out', `final.${label}.real.jsonl`));
  const shuf = Array.from({ length: th.controls.shuffled_replicates }, (_, i) => readJsonl(join(EVAL_DIR, 'out', `candidates.${label}.shuffled-r${i}.jsonl`))).filter(a => a.length);
  const qrelsGrade = qrels[0]?.qrels_grade ?? 'none';
  line(`## ${label} (qrels: ${qrelsGrade}; queries K ${Q.filter(x => x.class === 'K').length} A ${Q.filter(x => x.class === 'A').length} M ${Q.filter(x => x.class === 'M').length})`);
  // (1) K safety: paired hit@5 off vs on (product), one-sided lower CI vs -delta
  const K = fin.filter(f => f.class === 'K'); const kd = [], kcl = [];
  for (const f of K) { const oracle = q.get(f.id).oracle_chunk_id; const rOff = f.off.top10.findIndex(x => x.chunk_id === oracle) + 1, rOn = f.on.top10.findIndex(x => x.chunk_id === oracle) + 1; kd.push(M.hitAtK(rOn, 5) - M.hitAtK(rOff, 5)); kcl.push(q.get(f.id).family); }
  const kLo = kd.length ? M.oneSidedLowerCI(kd, kcl, th.bootstrap) : null; const kw = kd.filter(d => d < 0).length, kb = kd.filter(d => d > 0).length;
  line(`- K-safety Δhit@5(on−off): mean ${kd.length ? (kd.reduce((a, b) => a + b, 0) / kd.length).toFixed(3) : 'n/a'} · one-sided 95% lower ${kLo === null ? 'n/a' : kLo.toFixed(3)} vs −δ=${-th.K_noninferiority_delta_hit5} → ${kLo === null ? 'n/a' : (kLo > -th.K_noninferiority_delta_hit5 ? 'PASS' : 'FAIL')} · worse/same/better ${kw}/${kd.length - kw - kb}/${kb} · sign p=${M.signTestExact(kw, kb).toFixed(4)} · n=${kd.length} usable=${kd.length}`);
  // (2) latency SLO: warm p95 per channel (candidates) and per mode (final)
  const warm = cand.slice(1); const chNames = ['vector', 'fts', 'graph-seed', 'graph-n1', 'graph-n2', 'graph-vec'];
  line(`- latency-SLO warm p95 ms: ` + chNames.map(c => `${c}=${warm.length ? M.pctile(warm.map(r => r.channels[c].ms ?? 0), 0.95) : 'n/a'}`).join(' · ') + ` · final off/on=${fin.length > 1 ? M.pctile(fin.slice(1).map(f => f.off.ms), 0.95) : 'n/a'}/${fin.length > 1 ? M.pctile(fin.slice(1).map(f => f.on.ms), 0.95) : 'n/a'} · SLO ${th.latency_slo_ms.warm_p95_max} · cold(first)=${fin[0]?.on.ms ?? 'n/a'} · n=${warm.length} usable=${warm.length}`);
  // (3) candidate: Δrecall@30(doc) rrf3 − rrf2 on A+M with gold, cluster = family
  const AM = cand.filter(c => c.class !== 'K' && gold.has(c.id)); const cd = [], ccl = [];
  for (const c of AM) { const g = gold.get(c.id); cd.push(M.recallAtKDoc(c.channels.rrf3.chunk30, g, docOf, 30) - M.recallAtKDoc(c.channels.rrf2.chunk30, g, docOf, 30)); ccl.push(q.get(c.id).family); }
  const cci = cd.length ? M.bootstrapPairedCI(cd, ccl, th.bootstrap) : null; const cmean = cd.length ? cd.reduce((a, b) => a + b, 0) / cd.length : null;
  line(`- candidate Δrecall@30(doc) rrf3−rrf2: mean ${cmean === null ? 'n/a' : cmean.toFixed(3)} · 95% CI ${cci ? `[${cci[0].toFixed(3)}, ${cci[1].toFixed(3)}]` : 'n/a'} · MCID ${th.MCID_candidate_recall30_doc} · n=${cd.length} usable=${cd.length} (A+M with ≥1 gold doc)`);
  // (4) semantics: real graph-n1 recall@30 vs shuffle null (replicates)
  const realN1 = AM.length ? AM.reduce((a, c) => a + M.recallAtKDoc(c.channels['graph-n1'].chunk30, gold.get(c.id), docOf, 30), 0) / AM.length : null;
  const nulls = shuf.map(rep => { const m = new Map(rep.map(r => [r.id, r])); const v = AM.map(c => m.get(c.id)).filter(Boolean).map(c => M.recallAtKDoc(c.channels['graph-n1'].chunk30, gold.get(c.id), docOf, 30)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }).filter(x => x !== null);
  const pNull = nulls.length ? nulls.filter(x => x >= realN1).length / nulls.length : null; const nullMean = nulls.length ? nulls.reduce((a, b) => a + b, 0) / nulls.length : null;
  line(`- semantics graph-n1 recall@30(doc): real ${realN1 === null ? 'n/a' : realN1.toFixed(3)} · shuffle-null mean ${nullMean === null ? 'n/a' : nullMean.toFixed(3)} (R=${nulls.length}) · p_null ${pNull === null ? 'n/a' : pNull.toFixed(3)} · MCID ${th.MCID_semantics_vs_shuffle_null} · n=${AM.length} usable=${AM.length}`);
  // (5) rerank: fixed-pool ΔnDCG@10 (with_graph − base) on A+M
  const finAM = fin.filter(f => f.class !== 'K' && gold.has(f.id)); const rd = [], rcl = [];
  for (const f of finAM) { const gr = grade.get(f.id); const gof = (d) => gr.get(d) || 0; rd.push(M.ndcg10Graded(f.fixedpool_rerank.with_graph, gof, docOf, gold.get(f.id)) - M.ndcg10Graded(f.fixedpool_rerank.base, gof, docOf, gold.get(f.id))); rcl.push(q.get(f.id).family); }
  const rci = rd.length ? M.bootstrapPairedCI(rd, rcl, th.bootstrap) : null; const rmean = rd.length ? rd.reduce((a, b) => a + b, 0) / rd.length : null;
  line(`- rerank ΔnDCG@10 fixed-pool(with_graph−base): mean ${rmean === null ? 'n/a' : rmean.toFixed(3)} · 95% CI ${rci ? `[${rci[0].toFixed(3)}, ${rci[1].toFixed(3)}]` : 'n/a'} · MCID ${th.MCID_rerank_ndcg10} · n=${rd.length} usable=${rd.length}`);
  // exploratory: recall-depth curve and unique-doc budgets, upstream summary
  line(`- exploratory recall@K(doc) A+M: ` + ['vector', 'fts', 'graph-seed', 'graph-n1', 'graph-n2', 'graph-vec', 'rrf2', 'rrf3', 'rrf3-n2'].map(ch => `${ch}=` + [10, 30, 100].map(K => AM.length ? (AM.reduce((a, c) => a + M.recallAtKDoc(c.channels[ch][`chunk${K}`], gold.get(c.id), docOf, K), 0) / AM.length).toFixed(2) : 'n/a').join('/')).join(' · ') + ` · n=${AM.length} usable=${AM.length}`);
  const up = readJsonl(join(EVAL_DIR, 'out', `upstream.${label}.jsonl`)); const lp = existsSync(join(EVAL_DIR, 'out', `link-precision.${label}.json`)) ? JSON.parse(readFileSync(join(EVAL_DIR, 'out', `link-precision.${label}.json`), 'utf8')) : null;
  if (up.length) line(`- upstream: seed_recall ${up.filter(u => u.seed_recall).length}/${up.length} · edge_validity ${up.reduce((a, u) => a + u.edge_validity.exists, 0)}/${up.reduce((a, u) => a + u.edge_validity.total, 0)} · projection_recall mean ${(up.filter(u => u.projection_recall !== null).reduce((a, u) => a + u.projection_recall, 0) / Math.max(1, up.filter(u => u.projection_recall !== null).length)).toFixed(3)} · link precision(name) ${lp ? lp.by_provenance.name.precision : 'n/a'} weighted ${lp ? lp.weighted_precision : 'n/a'} · n=${up.length} usable=${up.length}`);
  summary[label] = { kLo, cd, ccl, rd, rcl, pNull, realN1, nullMean };
  line('');
}
// stratified macro across corpora (mean of per-corpus means; no naive pooling)
const macro = (key) => { const vals = Object.values(summary).map(s => s[key]).filter(v => Array.isArray(v) && v.length).map(v => v.reduce((a, b) => a + b, 0) / v.length); return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3) : 'n/a'; };
line(`## corpus-stratified macro (mean of corpus means; n=corpora ${Object.keys(summary).length})`);
line(`- candidate Δrecall@30 macro ${macro('cd')} · rerank ΔnDCG@10 macro ${macro('rd')}`);
line(''); line(`Primary endpoints (gatekeeping order): K-safety → latency-SLO → candidate → semantics → rerank; Holm over the three efficacy endpoints is applied in run-decision.mjs (Stage 2). Everything under "exploratory" is descriptive.`);
writeFileSync(join(EVAL_DIR, 'out', 'report.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
```

- [ ] **Step 4: power.mjs -> POWER.md (freeze)**
```js
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './lib/paths.mjs';
import * as M from './lib/metrics.mjs';
const th = JSON.parse(readFileSync(join(EVAL_DIR, 'thresholds.json'), 'utf8'));
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const docOf = (id) => id.split('_chunk_')[0];
const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const out = ['# POWER — holdout N from pilot variance (frozen before Stage 2)', '', `target power ${th.power.target} · alpha ${th.power.alpha} · MCID candidate ${th.MCID_candidate_recall30_doc} · rerank ${th.MCID_rerank_ndcg10} · K delta ${th.K_noninferiority_delta_hit5} · judging budget/corpus ${th.judging_budget_per_corpus}`, '', '| corpus | endpoint | pilot n | paired SD | discordance | N (power 0.8) | note |', '|---|---|---|---|---|---|---|'];
for (const label of ['hub', 'uap', 'hal']) {
  const Q = new Map(readJsonl(join(EVAL_DIR, 'suite', `queries.${label}.jsonl`)).map(x => [x.id, x]));
  const qrels = readJsonl(join(EVAL_DIR, 'suite', `qrels.${label}.jsonl`)); const gold = new Map(), grade = new Map();
  for (const r of qrels) { if (r.grade >= 1) (gold.get(r.qid) || gold.set(r.qid, new Set()).get(r.qid)).add(r.doc_id); const g = grade.get(r.qid) || grade.set(r.qid, new Map()).get(r.qid); g.set(r.doc_id, Math.max(g.get(r.doc_id) || 0, r.grade)); }
  const cand = readJsonl(join(EVAL_DIR, 'out', `candidates.${label}.real.jsonl`)).filter(c => c.class !== 'K' && gold.has(c.id));
  const fin = readJsonl(join(EVAL_DIR, 'out', `final.${label}.real.jsonl`));
  const cd = cand.map(c => M.recallAtKDoc(c.channels.rrf3.chunk30, gold.get(c.id), docOf, 30) - M.recallAtKDoc(c.channels.rrf2.chunk30, gold.get(c.id), docOf, 30));
  const rd = fin.filter(f => f.class !== 'K' && gold.has(f.id)).map(f => { const gr = grade.get(f.id); const gof = d => gr.get(d) || 0; return M.ndcg10Graded(f.fixedpool_rerank.with_graph, gof, docOf, gold.get(f.id)) - M.ndcg10Graded(f.fixedpool_rerank.base, gof, docOf, gold.get(f.id)); });
  const kd = fin.filter(f => f.class === 'K').map(f => { const o = Q.get(f.id).oracle_chunk_id; return M.hitAtK(f.on.top10.findIndex(x => x.chunk_id === o) + 1, 5) - M.hitAtK(f.off.top10.findIndex(x => x.chunk_id === o) + 1, 5); });
  const row = (ep, arr, mcid) => { if (arr.length < 2) { out.push(`| ${label} | ${ep} | ${arr.length} | n/a | n/a | n/a | too few |`); return; } const s = sd(arr), disc = arr.filter(x => x !== 0).length / arr.length, N = M.powerN(s, mcid, { alpha: th.power.alpha, power: th.power.target }); out.push(`| ${label} | ${ep} | ${arr.length} | ${s.toFixed(3)} | ${disc.toFixed(2)} | ${N} | ${N > 400 ? 'likely over judging budget → inconclusive risk' : ''} |`); };
  row('candidate Δrecall@30', cd, th.MCID_candidate_recall30_doc); row('rerank ΔnDCG@10', rd, th.MCID_rerank_ndcg10); row('K Δhit@5 (non-inferiority)', kd, th.K_noninferiority_delta_hit5);
}
out.push('', 'Rule: holdout A+M per corpus = max over efficacy endpoints of N (capped by judging budget: if the cap binds, that endpoint is pre-declared `inconclusive` unless the observed effect clears MCID with CI). K holdout = 30 per corpus already generated (document-split).');
writeFileSync(join(EVAL_DIR, 'suite', 'POWER.md'), out.join('\n') + '\n'); console.log(out.join('\n'));
```
Run: `node eval/graph-role/report.mjs` and `node eval/graph-role/power.mjs`; then append `POWER.md` and `thresholds.json` hashes to FREEZE.md; complete README (run order + exit codes + "one process at a time"); commit `eval(graph-role): pilot report + power → holdout N frozen`. **Stage 1 ends here; every conclusion in report.md is labelled provisional (dev pilot).**

---

## Self-Review (done while writing; fix inline)

1. **Spec coverage** — R1 (T3: schema, family/leakage, freeze, observed), R2 (T1: seam, branches, golden parity), R3 (T5: 9 channels, budgets chunk/doc, K 10/30/100, tie-break, reach, ms), R4 (T7: seed recall, edge validity flags, encoded-path coverage, projection, hub-degree misrank, link audit provenance name/nonliteral, chunk-cluster CI), R5 (T4: replicates 20+5+1, node-level degree check exit 6, p_null in T8), R6 (T5 driver order + T6 pool exit 7 + unpooled 100), R7 (T6: JUDGING.md, weighted κ gate exit 8, adjudication, human audit → decision-grade/provisional), R8 (T8: paired, sign, bootstrap 10k seed, one-sided CI, Holm noted, macro, n/usable), R9 (T2 thresholds + T8 POWER frozen; run-decision.mjs = Stage 2), R10 (T2 db.mjs), R11 (Stage 2 T11), R12 (.gitignore dbs/ only). Gaps deliberately deferred to Stage 2: run-decision.mjs, DECISION.md, follow-on change scaffolding — they need holdout data.
2. **Placeholder scan** — no TBD/TODO; the only "fill after commit" is FREEZE.md's commit-hash column (a value that cannot exist before the commit; the plan states the two-commit procedure). Judge/adjudicator steps are LLM-executed steps with exact I/O files and prompts.
3. **Type consistency** — `channelsForQuery` returns `channels[name].{chunk,doc,ms}` and runners flatten to `chunk10/30/100, doc10/30/100, ms` (report/power/pool read those flattened names); `docOf` in report/power = `id.split('_chunk_')[0]` (verify once on the copy — T7 note); `weightedKappa` lives in `lib/metrics.mjs` from T6 on and T8 appends without redefining; `oneSidedLowerCI` used by report for K-safety; `dbFor(label, cond)` names controls `shuffled-rN | typeshuf-rN | random` consistently in T4/T5/T6/T8.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-17-graph-role-evaluation-stage1.md`. Two execution options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks (T1 first: it is the only product-code touch and gates everything else).
2. **Inline Execution** — executing-plans in this session with checkpoints after T1, T3 (freeze), T5 (runs), T6 (qrels).
Phase 4 (CONTRACT) gate: the user confirms before Phase 5 starts (SDD). Advisor α = covered by r4 (design REVISE reflected in v2 docs); β applies before any commit that touches `index.ts` is merged to main.
