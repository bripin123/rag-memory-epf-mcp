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
