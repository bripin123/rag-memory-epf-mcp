# Entity Embedding Text Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap `generateEntityEmbeddingText` to a char budget (newest observations win, identity always kept) so `addObservations`/`/sync` stops paying for ever-growing single-entity embeddings and stops silently truncating the newest facts past the 8192-token model limit.

**Architecture:** One pure-string method (`generateEntityEmbeddingText`) gets a newest-first char-budget cap driven by `ENTITY_EMBED_OBS_CHAR_BUDGET`. `embedEntity` gets observability logging (raw vs embedded size, duration). No tool schema or method signature changes, so all three CLIs are unaffected.

**Tech Stack:** TypeScript, better-sqlite3, transformers.js (bge-m3 1024-dim), node test runner (`test/*.test.mjs` against built `dist/`).

## Global Constraints

- API / tool schema unchanged: do NOT touch `src/tools/knowledge-graph-tools.ts` or the dispatch at `index.ts:3167`. Backward compatible for Claude Code / Codex / agy.
- Env var `ENTITY_EMBED_OBS_CHAR_BUDGET`, default `12000`, hard floor `1000` (`Math.max(1000, ...)`).
- Identity (`entityType` + `name`) is always prepended and never counted against the observation budget.
- Existing metadata-observation filter is preserved verbatim: drop observations starting with `Source:`, `Created:`, `Type:`, `Tags:`, `Content length:`.
- Newest-wins: select observations from the end (most recent) backward.
- No em-dash (`—`, U+2014) anywhere in code, comments, or commit messages. Use hyphen / colon / parentheses.
- Tests import the BUILT module (`dist/index.js`), so `npm run build` must run before any test. TS `private` is erased at runtime, so `.mjs` tests call `manager.generateEntityEmbeddingText(...)` directly.
- Each test file = its own `node` process (DB_FILE_PATH is read once at module load).

---

### Task 1: Char-budget cap for `generateEntityEmbeddingText`

**Files:**
- Create: `test/entity-embed-cap.test.mjs`
- Modify: `index.ts:896-901` (the `generateEntityEmbeddingText` method body)
- Modify: `package.json` (wire the new test into `verify:engine`)

**Interfaces:**
- Consumes: `makeManager`, `assert` from `test/helpers/engine-test-db.mjs`.
- Produces: `generateEntityEmbeddingText(entity: { name: string; entityType: string; observations: string[] }): string` with capping behavior. Signature unchanged from current; only behavior changes. `embedEntity` (Task 2) keeps calling it identically.

- [ ] **Step 1: Write the failing test**

Create `test/entity-embed-cap.test.mjs`:

```js
// Unit tests for generateEntityEmbeddingText char-budget cap.
// TS `private` is erased at runtime, so we call the method directly off the manager.
// skipModel:true is fine: this method is pure string work, no embedding model needed.
import { makeManager, assert } from './helpers/engine-test-db.mjs';

const { manager, cleanup } = await makeManager();
const gen = (e) => manager.generateEntityEmbeddingText(e);

try {
  // 1. Under default budget: all observations included, identical to legacy output.
  delete process.env.ENTITY_EMBED_OBS_CHAR_BUDGET;
  const small = gen({ name: 'X', entityType: 'PROJECT', observations: ['a', 'b', 'c'] });
  assert(small === 'PROJECT: X. a. b. c', 'under-budget: all observations kept, unchanged');

  // 5. Identity prefix always present.
  assert(small.startsWith('PROJECT: X.'), 'identity prefix present');

  // 4. Metadata observations are filtered out.
  const meta = gen({ name: 'X', entityType: 'T', observations: ['Source: foo', 'real obs', 'Created: 2026'] });
  assert(meta === 'T: X. real obs', 'metadata observations filtered');

  // 2. Over budget: newest kept, oldest dropped. budget 1000, two 600-char obs.
  process.env.ENTITY_EMBED_OBS_CHAR_BUDGET = '1000';
  const oldO = 'A'.repeat(600);   // oldest
  const newO = 'B'.repeat(600);   // newest
  const over = gen({ name: 'X', entityType: 'T', observations: [oldO, newO] });
  assert(over === `T: X. ${newO}`, 'over-budget: newest 600 kept, older 600 dropped');
  assert(!over.includes('A'), 'over-budget: oldest observation dropped');

  // 3. Single giant observation: truncated to budget (never empty).
  process.env.ENTITY_EMBED_OBS_CHAR_BUDGET = '1000';
  const giant = 'C'.repeat(1500);
  const trunc = gen({ name: 'X', entityType: 'T', observations: [giant] });
  assert(trunc === `T: X. ${'C'.repeat(1000)}`, 'single giant obs truncated to budget');

  // 6. Korean text capped by char count the same way.
  process.env.ENTITY_EMBED_OBS_CHAR_BUDGET = '1000';
  const koOld = '가'.repeat(600);
  const koNew = '나'.repeat(600);
  const ko = gen({ name: '프로젝트', entityType: '프로젝트', observations: [koOld, koNew] });
  assert(ko === `프로젝트: 프로젝트. ${koNew}`, 'korean: newest kept by char budget');

  // 7. Env below floor 1000 is ignored (floor applies).
  process.env.ENTITY_EMBED_OBS_CHAR_BUDGET = '10';
  const floorObs = 'D'.repeat(500);
  const floor = gen({ name: 'X', entityType: 'T', observations: [floorObs] });
  assert(floor === `T: X. ${floorObs}`, 'env below floor 1000 ignored, 500-char obs fully kept');

  console.log(process.exitCode ? 'ENTITY-EMBED-CAP FAILED' : 'ENTITY-EMBED-CAP OK');
} finally {
  delete process.env.ENTITY_EMBED_OBS_CHAR_BUDGET;
  cleanup();
}
```

- [ ] **Step 2: Build and run the test to verify it fails**

Run:
```bash
npm run build && node test/entity-embed-cap.test.mjs
```
Expected: FAIL. The current method joins ALL observations and ignores `ENTITY_EMBED_OBS_CHAR_BUDGET`, so the over-budget assert reports `FAIL: over-budget: newest 600 kept, older 600 dropped` (it returns `T: X. AAA....BBB...`), giant/floor asserts also fail, and the script prints `ENTITY-EMBED-CAP FAILED`. Under-budget / metadata / identity asserts pass.

- [ ] **Step 3: Implement the cap**

Replace `index.ts:896-901` (the whole `generateEntityEmbeddingText` method) with:

```ts
  // Generate embedding text for an entity (identity + newest observations within a char budget).
  // The char budget keeps the entity vector representative of CURRENT state and stays under the
  // bge-m3 8192-token ceiling; older history lives in RAG document chunks / dated entities.
  private generateEntityEmbeddingText(entity: { name: string; entityType: string; observations: string[] }): string {
    const maxObservationChars = Math.max(
      1000,
      Number.parseInt(process.env.ENTITY_EMBED_OBS_CHAR_BUDGET || '12000', 10) || 12000
    );

    const observations = entity.observations.filter(o =>
      !o.startsWith('Source:') && !o.startsWith('Created:') && !o.startsWith('Type:') &&
      !o.startsWith('Tags:') && !o.startsWith('Content length:')
    );

    const selected: string[] = [];
    let remaining = maxObservationChars;
    for (let i = observations.length - 1; i >= 0 && remaining > 0; i--) {
      const obs = observations[i];
      const separatorCost = selected.length > 0 ? 2 : 0; // '. ' joiner
      const available = remaining - separatorCost;
      if (available <= 0) break;
      if (obs.length <= available) {
        selected.push(obs);
        remaining -= obs.length + separatorCost;
      } else if (selected.length === 0) {
        selected.push(obs.slice(0, available)); // single giant obs: keep a truncated head, never empty
        break;
      } else {
        break;
      }
    }

    const observationsText = selected.reverse().join('. ');
    return `${entity.entityType}: ${entity.name}. ${observationsText}`.trim();
  }
```

- [ ] **Step 4: Wire the new test into `verify:engine`**

In `package.json`, append ` && node test/entity-embed-cap.test.mjs` to the `verify:engine` script. After the edit it reads:

```json
    "verify:engine": "node test/engine-smoke.test.mjs && node test/launch-smoke.test.mjs && node test/sync-atomicity.test.mjs && node test/dedup.test.mjs && node test/search-degradation.test.mjs && node test/entity-embed-cap.test.mjs",
```

- [ ] **Step 5: Build and run the test to verify it passes**

Run:
```bash
npm run build && node test/entity-embed-cap.test.mjs
```
Expected: every assert prints `OK:` and the script prints `ENTITY-EMBED-CAP OK` (exit 0).

- [ ] **Step 6: Run the full regression suite**

Run:
```bash
npm test
```
Expected: `npm run build` succeeds, `verify:invariants` prints invariant OK lines, `verify:engine` runs all six engine tests including `ENTITY-EMBED-CAP OK`, overall exit 0. No existing test regresses.

- [ ] **Step 7: Commit**

```bash
git add index.ts test/entity-embed-cap.test.mjs package.json
git commit -m "$(cat <<'EOF'
feat: cap entity embedding text to a char budget

generateEntityEmbeddingText now keeps identity + newest observations
within ENTITY_EMBED_OBS_CHAR_BUDGET (default 12000, floor 1000) instead
of concatenating all observations. Cuts inference time on large entities
(PROJECT) and fixes silent 8192-token truncation of the newest facts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Embedding instrumentation in `embedEntity`

**Files:**
- Modify: `index.ts:1066-1074` (inside `embedEntity`, around the `generateEntityEmbeddingText` + `generateEmbedding` calls)

**Interfaces:**
- Consumes: `generateEntityEmbeddingText` (Task 1), `this.generateEmbedding`.
- Produces: no API change. Adds one `console.error` log line per entity embed (stderr, does not touch MCP stdio).

- [ ] **Step 1: Add instrumentation**

In `index.ts`, replace the current block at lines 1066-1074:

```ts
    const parsedObservations = JSON.parse(entity.observations);
    const embeddingText = this.generateEntityEmbeddingText({
      name: entity.name,
      entityType: entity.entityType,
      observations: parsedObservations
    });
    
    // Generate embedding
    const embedding = await this.generateEmbedding(embeddingText);
```

with:

```ts
    const parsedObservations = JSON.parse(entity.observations);
    const rawObsChars = parsedObservations.reduce(
      (sum: number, o: unknown) => sum + (typeof o === 'string' ? o.length : 0),
      0
    );
    const embeddingText = this.generateEntityEmbeddingText({
      name: entity.name,
      entityType: entity.entityType,
      observations: parsedObservations
    });

    // Instrumentation (stderr only): how big was the entity vs what we actually embed, and how long.
    const capped = embeddingText.length < rawObsChars;
    const embedStart = Date.now();
    const embedding = await this.generateEmbedding(embeddingText);
    const embedMs = Date.now() - embedStart;
    console.error(
      `[embed] ${entity.name}: ${parsedObservations.length} obs, raw ${rawObsChars}ch -> embed ${embeddingText.length}ch${capped ? ' (capped)' : ''}, ${embedMs}ms`
    );
```

(No TDD test for this step: it is a stderr log with no return-value or DB effect. Correctness is covered by the regression suite still passing plus a manual log check.)

- [ ] **Step 2: Build and run the regression suite**

Run:
```bash
npm test
```
Expected: exit 0, all engine tests still pass (behavior unchanged; only a log line added). The `[embed]` lines appear on stderr during embedding-dependent tests.

- [ ] **Step 3: Commit**

```bash
git add index.ts
git commit -m "$(cat <<'EOF'
feat: log entity embedding size and duration

embedEntity now logs obs count, raw-vs-embedded char size, capped flag,
and embed duration to stderr for observability of the char-budget cap.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Spec 4.1(1) char budget cap -> Task 1 (Steps 1-7).
- Spec 4.1(2) instrumentation -> Task 2.
- Spec 4.2 excluded scope (targeted embedAllEntities / skipEmbed) -> intentionally absent. Covered.
- Spec 5 compatibility (no schema change) -> Global Constraints + no edits to tool/dispatch files.
- Spec 6 test cases 1-7 -> all seven asserts present in Step 1 test.
- Spec 6 regression -> Task 1 Step 6, Task 2 Step 2 (`npm test`).
- Spec 7 risks -> behavioral (recall/char-token), no code task needed; default-value sanity is a manual check at execution.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases". Every code step has full code. Test step has full assertions. Pass.

**3. Type consistency:** `generateEntityEmbeddingText(entity: {name, entityType, observations})` signature identical in Task 1 impl and Task 2 caller. `ENTITY_EMBED_OBS_CHAR_BUDGET` env name identical across spec, impl, and all test asserts. `makeManager`/`assert` match the helper exports verified in the repo. Pass.
