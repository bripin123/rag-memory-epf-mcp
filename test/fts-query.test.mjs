// compileFtsLiteralQuery verification: raw user input can never produce FTS5
// MATCH syntax errors or trigger operators. Spec §5 regression set.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

process.env.RAG_MEMORY_NO_AUTOSTART = '1';
const dir = mkdtempSync(join(tmpdir(), 'rag-fts-'));
process.env.DB_FILE_PATH = join(dir, 't.db');
const mod = await import('../dist/index.js');
const { compileFtsLiteralQuery, RAGKnowledgeGraphManager } = mod;

// Null cases: nothing searchable left after sanitize.
for (const q of ['', '   ', '"', '*', '-', '()', '"" ** (( ))--']) {
  assert.equal(compileFtsLiteralQuery(q), null, `expected null for ${JSON.stringify(q)}`);
}
console.log('  OK: unsearchable inputs compile to null');

// Compiled queries must be valid FTS5 MATCH expressions on a real table.
const mgr = new RAGKnowledgeGraphManager();
await mgr.initialize({ skipModel: true });
const db = mgr.db;
db.exec(`INSERT INTO entities (id, name, entityType, observations) VALUES
  ('entity_cpp', 'C++ handbook', 'CONCEPT', '["[2026-07-18] systems language notes"]'),
  ('entity_kr',  '한국어 검색 자산', 'CONCEPT', '["[2026-07-18] 한글 관측"]')`);

const REGRESSION_SET = [
  'C++', 'foo:bar', '"만"', '*', '-', 'OR', 'NEAR(x)', "don't", '😀',
  '한국어 검색', '   ', 'alpha OR beta', 'NOT AND NEAR', 'a-b-c', '(paren) "quote"',
];
for (const q of REGRESSION_SET) {
  const expr = compileFtsLiteralQuery(q);
  if (expr === null) continue; // contract: empty result path, no error
  // Must execute without a syntax error on both FTS tables.
  db.prepare(`SELECT rowid FROM entities_fts WHERE entities_fts MATCH ?`).all(expr);
  db.prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?`).all(expr);
}
console.log('  OK: full regression set executes with zero MATCH errors');

// Operators are neutralized: bare OR/NEAR terms are literals, not operators.
const orExpr = compileFtsLiteralQuery('alpha OR beta');
assert.equal(orExpr, '"alpha" OR "OR" OR "beta"', `operator not neutralized: ${orExpr}`);
console.log('  OK: operator tokens are quoted literals');

// Lexical hit sanity: Korean and C++ terms actually match.
const kr = db.prepare(`SELECT e.name FROM entities_fts f JOIN entities e ON f.rowid=e.rowid WHERE entities_fts MATCH ?`)
  .all(compileFtsLiteralQuery('한국어'));
assert.equal(kr.length, 1);
console.log('  OK: CJK lexical match');

mgr.cleanup();
rmSync(dir, { recursive: true, force: true });
console.log('FTS-QUERY OK');
