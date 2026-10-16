// kg-relation-evidence R5 (REVIEW-PLAN-2_): the evidence path end to end with the REAL bge-m3 model on a
// tiny synthetic temp DB: generate -> KG embed (dedicated) -> hybridSearch -> detail refs_available ->
// backfill re-embed -> cited source changes -> absent from search and detail -> explicit regeneration ->
// the new fact is retrieved. Stub-model counterparts of each step (same code paths, deterministic model):
// kg-relation-evidence (generate, search), kg-embed-cas + kg-evidence-cas (dedicated and backfill
// write-back), kg-detail-context (reference status), kg-evidence-invalidation (writer -> absent -> regenerate).
// Exit: 0 PASS · 1 a contract step failed · 3 NOT-RUN (model or reconciliation not ready, a disabled
// embedding gate, or deadline).
// The receipt is written in every case; a non-zero exit is never overridden by an existing receipt.
// P34/K2 (preflight): the temp dir, the dynamic import and the manager construction sit INSIDE the outer
// try, so a failure there still writes an ERROR receipt and still runs the finally.
// usage: node eval/kg-relation-evidence/real-model-e2e.mjs <path to dist/index.js> <out.json> <deadline seconds>
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [dist, out, deadlineArg] = process.argv.slice(2);
if (!dist || !out || !deadlineArg || existsSync(out)) { console.error('usage: real-model-e2e.mjs <dist/index.js> <out.json> <deadline seconds> (out must not exist)'); process.exit(2); }
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const cp = (s) => [...s].length;
const receipt = { dist: resolve(dist), started: new Date().toISOString(), verdict: null, reason: null, steps: [], timings_ms: {}, observations: {} };
const finish = (verdict, reason, code) => { receipt.verdict = verdict; receipt.reason = reason; writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n'); return code; };
const timer = setTimeout(() => { process.exit(finish('NOT-RUN', 'deadline exceeded', 3)); }, Number(deadlineArg) * 1000);
timer.unref?.();
class StepFailed extends Error {}
const step = (name, ok, detail = null) => { receipt.steps.push({ name, ok: !!ok, detail }); if (!ok) throw new StepFailed(name); };
const timed = async (key, fn) => { const t0 = Date.now(); try { return await fn(); } finally { receipt.timings_ms[key] = Date.now() - t0; } };

let dir = null;
let m = null;
let code = 1;
try {
  dir = mkdtempSync(join(tmpdir(), 'kg-real-'));
  process.env.DB_FILE_PATH = join(dir, 'real.db');
  process.env.RAG_MEMORY_NO_AUTOSTART = '1';
  delete process.env.RAG_MEMORY_SEARCH_SUMMARIES;
  delete process.env.EMBEDDING_MODEL;
  const { RAGKnowledgeGraphManager } = await import(pathToFileURL(resolve(dist)).href);
  m = new RAGKnowledgeGraphManager();
  await m.initialize();
  try { await timed('model_load', () => m.gate.start()); }
  catch (e) { code = finish('NOT-RUN', `model did not load: ${e?.message}`, 3); throw null; }
  // gate.start() resolves WITHOUT loading when the gate is disabled (embeddingGate.ts start()): that is
  // NOT-RUN, never a FAIL/ERROR in a later step and never a PASS.
  if (m.gate.isDisabled) { code = finish('NOT-RUN', 'embedding gate disabled', 3); throw null; }
  if (!m.gate.isReady) { code = finish('NOT-RUN', `model not ready (gate state ${m.gate.state})`, 3); throw null; }
  await m.startReconciliation();
  if (!['complete', 'n/a'].includes(m.coordinator.reconState)) { code = finish('NOT-RUN', `reconciliation ${m.coordinator.reconState}`, 3); throw null; }
  const D = '[2026-01-01] ';
  await timed('fixture', async () => {
    await m.createEntities([
      { name: 'Real Funder', entityType: 'ORG', observations: [`${D}Real Funder is a private foundation.`] },
      { name: 'Real Lab', entityType: 'ORG', observations: [`${D}Real Lab studies coral reef restoration with zqxrealgrant90 funding.`],
        sources: [{ source_kind: 'document', source_ref: 'real-doc', source_hash: null }] },
    ]);
    await m.createRelations([{ from: 'Real Funder', to: 'Real Lab', relationType: 'FUNDS' }]);
    await m.syncDocumentFromFile('/real.md', 'real-doc', { content: 'Annual report. Real Funder pays for the coral reef restoration programme run by Real Lab under grant zqxrealquote91.' });
    const distractors = ['Lighthouse maintenance schedules for the northern coast.', 'A recipe for sourdough bread with a long cold proof.',
      'Notes on tuning a cello before a concert.', 'Train timetable changes for the winter season.', 'How to repair a bicycle puncture on the road.', 'Field guide entry on alpine wildflowers.'];
    for (const [i, t] of distractors.entries()) await m.syncDocumentFromFile(`/d${i}.md`, `real-d${i}`, { content: t });
  });
  const R = 'rel_entity_real_funder_funds_entity_real_lab';
  const CH = `kg_relationship_${R}`;
  const docText = m.db.prepare(`SELECT text FROM chunk_metadata WHERE chunk_id = 'real-doc_chunk_0'`).get().text;
  const Q = 'Real Funder pays for the coral reef restoration programme run by Real Lab under grant zqxrealquote91.';
  const s0 = cp(docText.slice(0, docText.indexOf(Q)));
  const docRef = { kind: 'document', chunk_id: 'real-doc_chunk_0', start: s0, end: s0 + cp(Q), quote_sha256: sha(Q) };
  const obsRef = (token) => { const o = m.db.prepare(`SELECT observation_id, revision_no, content FROM entity_observations WHERE status = 'active' AND content LIKE ?`).get(`%${token}%`);
    return { kind: 'observation', observation_id: o.observation_id, revision_no: o.revision_no, content_sha256: sha(o.content) }; };
  const gen = (token) => m.generateRelationEvidenceChunks([{ relationship_id: R, evidence: [docRef, obsRef(token)] }], { formatVersion: 'evidence-v1' });
  const search = (q) => m.hybridSearch(q, 10, false);
  const NL = 'who pays for the coral reef restoration programme';

  await gen('zqxrealgrant90');
  const e1 = await timed('kg_embed_dedicated', () => m.embedKnowledgeGraphChunks());
  step('dedicated KG embed wrote every KG row with the real model', e1.embeddedChunks === e1.totalChunks && !e1.discardedChunks, e1);
  for (const [label, q] of [['natural-language query', NL], ['quote-only token', 'zqxrealquote91']]) {
    const r = await timed(`search_${label}`, () => search(q));
    step(`hybridSearch mode is hybrid (${label})`, r.search_mode === 'hybrid', r.search_mode);
    const hit = r.results.find(x => x.chunk_id === CH);
    step(`evidence chunk retrieved (${label})`, !!hit && hit.vector_similarity > 0, hit ? { rank: r.results.indexOf(hit) + 1, vector_similarity: hit.vector_similarity, fts_boost: hit.fts_boost ?? null } : null);
    // recorded, not judged: where the evidence chunk sits relative to the unrelated documents
    receipt.observations[`ranks_${label}`] = r.results.map(x => [x.chunk_id, x.relevance_score, x.vector_similarity]);
  }
  const d1 = await m.getDetailedContext(CH);
  step('detail = refs_available with both references available', d1.evidence_status === 'refs_available' && d1.evidence_refs.every(x => x.status === 'available'), d1.evidence_status);
  const rowid = m.db.prepare(`SELECT rowid FROM chunk_metadata WHERE chunk_id = ?`).get(CH).rowid;
  m.db.exec(`DELETE FROM chunks WHERE rowid = ${Number(rowid)}`);
  const ok = await timed('kg_embed_backfill', () => m.reembedChunkByRowid(rowid));
  const meta = m.db.prepare(`SELECT profile_id, provenance_state FROM chunk_metadata WHERE rowid = ?`).get(rowid);
  // The dedicated step above already embedded this text under this profile, so the backfill call is served from the
  // profile-scoped cache: what this proves is the KG CAS write-back on the backfill path, not a fresh inference.
  step('backfill callback restored a cached real-model vector through the KG CAS',ok === true && meta.profile_id === m.currentProfileId && meta.provenance_state === 'verified', meta);
  const labObs = obsRef('zqxrealgrant90').observation_id;
  await m.correctObservation(labObs, `${D}Real Lab studies coral reef restoration with zqxrealgrant90 funding and zqxrealnew92 volunteers.`);
  for (const q of [NL, 'zqxrealquote91']) step(`after the cited observation changed: evidence chunk absent (${q})`, !(await search(q)).results.some(x => x.chunk_id === CH));
  let detailGone = false; try { await m.getDetailedContext(CH); } catch (e) { detailGone = /not found/.test(e.message); }
  step('after the change: detail fails like an unknown chunk', detailGone);
  await gen('zqxrealnew92');
  await timed('kg_embed_regenerated', () => m.embedKnowledgeGraphChunks());
  const r2 = await search('zqxrealnew92');
  step('after explicit regeneration: the new fact is retrieved', r2.search_mode === 'hybrid' && r2.results.some(x => x.chunk_id === CH));
  step('after explicit regeneration: refs_available', (await m.getDetailedContext(CH)).evidence_status === 'refs_available');
  code = finish('PASS', null, 0);
} catch (e) {
  if (e instanceof StepFailed) code = finish('FAIL', e.message, 1);
  else if (e !== null) code = finish('ERROR', `${e?.name}: ${e?.message}`, 1);
} finally {
  // exitCode BEFORE shutdownAll: shutdownAll keeps an existing exitCode and may call process.exit itself
  // (bounded exit while a model load is pending, index.ts:709-720), which must not turn a FAIL into 0.
  process.exitCode = code;
  try { if (m) await m.shutdownAll(); } catch { /* the verdict is already written */ }
  if (dir) rmSync(dir, { recursive: true, force: true });
}
