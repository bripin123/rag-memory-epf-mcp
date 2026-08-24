#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { get_encoding } from 'tiktoken';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pipeline, env } from '@huggingface/transformers';

// Import graphology for graph analytics
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import degree from 'graphology-metrics/centrality/degree.js';
import betweennessCentrality from 'graphology-metrics/centrality/betweenness.js';
import closenessCentrality from 'graphology-metrics/centrality/closeness.js';
import pagerank from 'graphology-metrics/centrality/pagerank.js';
import modularity from 'graphology-metrics/graph/modularity.js';

// Import our new structured tool system
import { getAllMCPTools, validateToolArgs, getSystemInfo } from './src/tools/tool-registry.js';

// Import migration system
import { MigrationManager } from './src/migrations/migration-manager.js';
import { backupBeforeMigration } from './src/backup/preflight.js';
import { rebuildProjection, deleteStaleKgChunks, deleteKgRelationshipChunks } from './src/observations/projection.js';
import { addRevision, correctRevision, transitionStatus, linkSources,
         nextProjectionOrder, type SourceInput } from './src/observations/lifecycle.js';
import { getObservationHistory } from './src/observations/history.js';

// Import chunk text algorithm (extracted for publish-time invariant testing)
import { chunkStructured as chunkStructuredText, effectiveSignature, isCurrentFormatSignature, LEGACY_SIGNATURE, DEFAULT_MAX_TOKENS } from './src/chunkerC.js';
import { migrations } from './src/migrations/migrations.js';

// v3.6 lite install: model lifecycle + version-independent cache (A′ boundary)
import { EmbeddingGate, GateNotReadyError, GateDisabledError, TerminalConfigError } from './src/embeddingGate.js';
import type { EmbedFn, EmbedPriority } from './src/embeddingGate.js';
import { resolveModelCacheDir, preflightCacheDir, artifactKey, ModelDownloadLock, handleLoaderFailure } from './src/modelCache.js';
import { BackfillCoordinator } from './src/backfillCoordinator.js';
import { calendarDate, resolveCalendarTimeZone, stampDatePrefix, stripDatePrefix } from './src/observations/date-prefix.js';
import os from 'node:os';
import { createHash } from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const PKG_VERSION: string = require('../package.json').version;

// v3.6: runtime Node floor (engines is advisory only under default npm config).
// Limitation: static native imports above may fail before this runs on very old
// Node — documented in docs/UPDATING.md.
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
function assertNodeVersion(): void {
  if (NODE_MAJOR < 24) {
    console.error(`❌ rag-memory-epf-mcp v${PKG_VERSION} requires Node >= 24 (current: ${process.versions.node}).`);
    console.error('   See docs/UPDATING.md for the supported runtime matrix.');
    process.exitCode = 1;
    throw new Error('unsupported Node version');
  }
}

// v3.6: strip tokens / auth material / long URLs from operator-facing error text.
function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/(hf_|api[_-]?key=|authorization:\s*)\S+/gi, '$1[redacted]')
    .replace(/https?:\/\/\S{60,}/g, '[url]')
    .slice(0, 500);
}

// v3.6: startup self-report banner (version reliability — spec §8).
function printBanner(opts: { model: string; revision: string; dtype: string; cachePath: string; dbPath: string }): void {
  console.error(`🚀 rag-memory-epf-mcp v${PKG_VERSION} | node v${process.versions.node} | model ${opts.model}@${opts.revision} (${opts.dtype}) | cache ${opts.cachePath} | db ${opts.dbPath}`);
}

// v3.6 (spec §5): ONE FTS5 literal-query compiler shared by chunk and entity
// search — raw user input can never produce MATCH syntax errors or trigger
// operators (every term is double-quoted; special characters stripped exactly
// as the pre-3.6 hybridSearch sanitizer did). Returns null when nothing
// searchable remains (contract: caller returns empty results + warning).
export function compileFtsLiteralQuery(q: string): string | null {
  const sanitized = q.replace(/["\*\(\)\-]/g, ' ').trim();
  if (!sanitized) return null;
  const terms = sanitized.split(/\s+/).filter(t => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map(t => `"${t}"`).join(' OR ');
}

// Configure Hugging Face transformers for better compatibility
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = './node_modules/@huggingface/transformers/dist/';
}

// Define database file path using environment variable with fallback
const defaultDbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rag-memory.db');
const DB_FILE_PATH = process.env.DB_FILE_PATH
  ? path.isAbsolute(process.env.DB_FILE_PATH)
    ? process.env.DB_FILE_PATH
    : path.join(path.dirname(fileURLToPath(import.meta.url)), process.env.DB_FILE_PATH)
  : defaultDbPath;

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'Xenova/bge-m3';
// v3.5 default model config — grandfathering legacy vectors is only automatic
// when the current config matches this (spec §6b custom-model guard). An
// EXPLICIT `EMBEDDING_MODEL=Xenova/bge-m3` counts as default: same weights,
// same pin, same grandfather policy (beta 1R consistency fix).
const IS_DEFAULT_MODEL_CONFIG = !process.env.EMBEDDING_MODEL || process.env.EMBEDDING_MODEL === 'Xenova/bge-m3';
// Default model pinned to an upstream commit (spec §6c): a shared version-
// independent cache must never silently swap weights under 'main'. Verified
// 2026-07-18 via `git ls-remote https://huggingface.co/Xenova/bge-m3` — the
// same revision the local v3.5 cache was downloaded from. Custom models stay
// on 'main' (their vectors are never auto-grandfathered anyway).
const MODEL_REVISION = IS_DEFAULT_MODEL_CONFIG ? '4de13258303883538bd53b696b452bf8099f0858' : 'main';
const MODEL_DTYPE = 'fp16';
// Entity embedding text builder version — mixed into entity input hashes so a
// builder change re-backfills entities without touching chunk vectors (spec §6c).
const TEXT_BUILDER_VERSION = 'tb1';

// Original MCP interfaces
interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}

interface Relation {
  from: string;
  to: string;
  relationType: string;
}

interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

// Enhanced RAG interfaces
interface Document {
  id: string;
  content: string;
  metadata: Record<string, any>;
  created_at: string;
}

interface Chunk {
  id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  // Char offsets into the source document.content (NULL for entity/relationship chunks
  // that are synthesized rather than sliced from a document).
  start_pos: number;
  end_pos: number;
  // Token-space offsets from the BPE tokenizer used by chunkText.
  // NULL for entity/relationship chunks (no token-space concept).
  start_token: number | null;
  end_token: number | null;
  embedding?: Float32Array;
}

// NEW: Enhanced chunk types to support knowledge graph chunks
interface KnowledgeGraphChunk {
  id: string;
  type: 'entity' | 'relationship';
  entity_id?: string;
  relationship_id?: string;
  text: string;
  metadata: Record<string, any>;
}

interface SearchResult {
  chunk: Chunk;
  document: Document;
  entities: string[];
  vector_similarity: number;
  graph_boost: number;
  hybrid_score: number;
  distance: number;
}

// NEW: Enhanced search result with semantic summaries
interface EnhancedSearchResult {
  relevance_score: number;
  key_highlight: string;
  content_summary: string;
  chunk_id: string;
  document_title: string;
  entities: string[];
  vector_similarity: number;
  graph_boost?: number;
  fts_boost?: number;
  full_context_available: boolean;
  chunk_type: 'document' | 'entity' | 'relationship'; // NEW: Indicates the source type
  source_id?: string; // NEW: ID of the source entity/relationship if applicable
  search_mode?: 'hybrid' | 'fts-only'; // NEW: 'fts-only' when vector/embedding degraded
}

// NEW: Interface for detailed context retrieval
interface DetailedContext {
  chunk_id: string;
  document_id: string;
  full_text: string;
  document_title: string;
  surrounding_chunks?: Array<{
    chunk_id: string;
    text: string;
    position: 'before' | 'after';
  }>;
  entities: string[];
  metadata: Record<string, any>;
}

// Safe rowid for vec0 virtual tables (require literal integer, not parameterized)
// Trim incomplete UTF-8 multi-byte sequences at chunk boundaries.
// Continuation bytes match 10xxxxxx (0x80-0xBF); lead bytes indicate how many
// bytes the sequence needs (0xxxxxxx=1, 110xxxxx=2, 1110xxxx=3, 11110xxx=4).
// When a chunk is not at the document head/tail, any partial sequence at that
// edge belongs to an adjacent chunk and must be removed so TextDecoder does
// not emit U+FFFD. Pass trimHead/trimTail=false to preserve head/tail bytes.
// (Implementation moved to src/chunkText.ts for testability.)

export class SyncCasConflictError extends Error {
  constructor(documentId: string) { super(`sync CAS conflict on ${documentId}`); this.name = 'SyncCasConflictError'; }
}

// Test-only fault hook (v13 setMigrationFaultPoint 선례 — 환경변수 금지: 상시 스위치는
// 오설정 한 줄로 sync 를 깬다).
let __syncFaultHook: ((point: string) => void) | null = null;
export function setSyncFaultPoint(point: string | null, fn: (() => void) | null): void {
  __syncFaultHook = point && fn ? (p) => { if (p === point) fn(); } : null;
}

export interface ReuseCandidate {
  rowid: number; text: string; input_hash: string | null;
  profile_id: number | null; provenance_state: string | null; embedding: Buffer | null;
}

// Pure vector-reuse decision (spec §5.2 조건 1~5). Returns an OWNED Buffer copy:
// a Buffer read back from SQLite has no byteOffset-0 guarantee, and inserting
// `.buffer` of a subarray would write the wrong 4,096 bytes (advisor r5-9).
export function selectReusableVector(
  candidates: ReuseCandidate[], text: string, currentProfileId: number, sha256hex: (s: string) => string
): { vec: Buffer; provenance: 'verified' | 'legacy_assumed' } | null {
  const h = sha256hex(text);
  for (const r of candidates) {
    if (!r.embedding) continue;                                             // 조건 1: 벡터 실존
    if (r.input_hash !== h) continue;                                       // 조건 2: input_hash 일치
    if (r.text !== text) continue;                                          // 조건 3: exact text 최종판정
    if (r.profile_id !== currentProfileId) continue;                        // 조건 4: 현행 프로필
    if (r.provenance_state !== 'verified' && r.provenance_state !== 'legacy_assumed') continue; // 조건 5 (NULL 제외)
    return { vec: Buffer.from(r.embedding), provenance: r.provenance_state };  // owned copy
  }
  return null;
}

function safeRowid(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid rowid: ${value}`);
  }
  return n;
}

// Remove regions the caller does not want indexed. Compiled with `s` because the intended use is
// spanning a marked block (`<!-- SECRET -->…<!-- /SECRET -->`) and JS has no inline (?s) flag —
// without it every such pattern would silently match nothing.
// A malformed pattern throws rather than degrading to "no exclusion": indexing is a disclosure
// path, so believing you excluded something you did not is worse than a failed sync.
function applyExcludePatterns(text: string, pattern?: string | string[]): string {
  if (pattern === undefined) return text;
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  let out = text;
  for (const p of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(p, 'gs');
    } catch (e) {
      throw new Error(`excludePattern is not a valid regular expression: ${JSON.stringify(p)} (${(e as Error).message})`);
    }
    out = out.replace(re, '');
  }
  return out;
}

// Enhanced RAG-enabled Knowledge Graph Manager
export class RAGKnowledgeGraphManager {
  private db: Database.Database | null = null;
  private encoding: any = null;
  gate!: EmbeddingGate;
  embeddingsMode: 'lazy' | 'eager' | 'off' = 'lazy';
  currentProfileId = 0;
  // Automatic grandfathering of legacy vectors is only allowed under the v3.5
  // default model config, or with the explicit trust opt-in (spec §6b guard).
  grandfatherAllowed = IS_DEFAULT_MODEL_CONFIG || process.env.RAG_MEMORY_TRUST_LEGACY_VECTORS === '1';
  coordinator: BackfillCoordinator | null = null;
  // The calendar that date-only human labels are written in. Resolved once, here, so an invalid
  // zone fails at construction instead of quietly writing wrong days for weeks.
  readonly calendarTimeZone: string = resolveCalendarTimeZone(process.env.RAG_MEMORY_CALENDAR_TZ);
  private embeddingCache: Map<string, Float32Array> = new Map();
  private readonly EMBEDDING_CACHE_MAX = 500;
  private dictionaryCache: { nativeToEn: Record<string, string>; enToNative: Record<string, string> } | null = null;

  // v3.6 (spec §3): initialize = DB + migrations + profile only. The embedding
  // model is NEVER awaited here — main() connects the MCP server first and the
  // gate loads in the background (lazy) or is awaited explicitly (eager).
  // __testForceFkOff: 음성 대조군 전용. FK 게이트가 실제로 부팅을 막는지 시험한다.
  // 이름에 __test 를 박아 둔 이유는 이것이 프로덕션 설정 표면이 아니라는 것을
  // 호출부에서 읽히게 하기 위해서다.
  async initialize(opts: { skipModel?: boolean; gate?: EmbeddingGate; __testForceFkOff?: boolean } = {}) {
    console.error('🚀 Initializing RAG Knowledge Graph MCP Server...');

    this.db = new Database(DB_FILE_PATH);
    sqliteVec.load(this.db);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('cache_size = -32000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('mmap_size = 268435456');
    this.db.pragma('foreign_keys = ON');
    // spec §5.2: 관찰 lifecycle 의 무결성은 전부 FK CASCADE 를 전제한다 — root 를 지우면
    // revision 이, revision 을 지우면 source 가 따라가야 history 가 고아로 남지 않는다.
    // FK 가 꺼진 채 돌면 그 계약이 조용히 무효가 되고, 그게 최악이다. 스키마를 건드리기
    // 전에(= runMigrations 앞에서) 멈춘다.
    // 트랜잭션 내부에서는 이 pragma 가 no-op 이므로(실측 before=1·during=1·after=1)
    // 부팅 시점 확인이 유일한 방어 지점이다.
    //
    // 음성 대조군 주입은 **인자로만** 받는다. 환경변수로 두면 프로덕션 경로에
    // "부팅을 막는 스위치"가 상시 존재하게 되고, 오설정 한 줄로 서버가 안 뜬다
    // (advisor beta 자기의심 2 = "더 나쁘다"). 테스트는 manager 를 직접 만들므로
    // 인자 주입으로 충분하다.
    if (opts.__testForceFkOff) this.db.pragma('foreign_keys = OFF');
    {
      const fk = this.db.pragma('foreign_keys', { simple: true });
      if (Number(fk) !== 1) {
        throw new Error(
          `foreign_keys is ${fk}, expected 1. The observation lifecycle relies on FK CASCADE ` +
          `for history integrity; refusing to run migrations without it.`);
      }
    }
    this.encoding = get_encoding("cl100k_base");

    await this.runMigrations();
    this.currentProfileId = this.ensureCurrentProfile();
    // v14 (spec §7.2): 런타임이 기본 chunker 의 SSOT — 마이그레이션의 리터럴은 동결된
    // 역사이고, 기본값이 진화하면(c2 등) 이 upsert 가 부팅마다 현재값을 기록한다.
    this.db.prepare(`INSERT INTO server_meta (key, value) VALUES ('current_default_chunker', ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(effectiveSignature(DEFAULT_MAX_TOKENS));

    this.embeddingsMode = opts.skipModel
      ? 'off'
      : ((process.env.RAG_MEMORY_EMBEDDINGS as 'lazy' | 'eager' | 'off') || 'lazy');
    if (!['lazy', 'eager', 'off'].includes(this.embeddingsMode)) this.embeddingsMode = 'lazy';

    this.gate = opts.gate ?? new EmbeddingGate({
      mode: this.embeddingsMode,
      loadModel: () => this.buildRealLoader(),
      onReady: () => this.coordinator?.kick(),
    });

    // Late-bound deps (closures): tests swap manager.gate / flip the guard.
    this.coordinator = new BackfillCoordinator({
      db: () => this.db,
      gateIsReady: () => this.gate.isReady,
      gateIsDisabled: () => this.gate.isDisabled,
      mode: () => this.embeddingsMode,
      grandfatherAllowed: () => this.grandfatherAllowed,
      currentProfileId: () => this.currentProfileId,
      buildEntityInputHash: (entityId) => this.entityInputHash(entityId),
      hashEntityText: (text) => this.hashWithBuilderVersion(text),
      chunkInputHash: (text) => createHash('sha256').update(text).digest('hex'),
      reembedEntity: async (entityId) => this.embedEntity(entityId, 'backfill'),
      reembedChunk: async (rowid) => this.reembedChunkByRowid(rowid),
    });

    console.error('✅ RAG-enabled knowledge graph initialized (embedding model deferred)');
    const systemInfo = getSystemInfo();
    console.error(`📊 System Info: ${systemInfo.toolCounts.total} tools available (${systemInfo.toolCounts.knowledgeGraph} knowledge graph, ${systemInfo.toolCounts.rag} RAG, ${systemInfo.toolCounts.graphQuery} query)`);
  }

  // Upsert the stored-vector compatibility profile (spec §6c layer 2) and record
  // retrieval config in server_meta (layer 3 — never a backfill trigger).
  private ensureCurrentProfile(): number {
    if (!this.db) throw new Error('Database not initialized');
    const dims = 1024;
    if (dims !== 1024) throw new Error('unsupported embedding dims (vec0 tables are fixed at 1024)'); // fail-fast contract
    this.db.prepare(`INSERT OR IGNORE INTO embedding_profiles
      (model_id, revision, dtype, dims, pooling, normalize) VALUES (?,?,?,?,?,?)`)
      .run(EMBEDDING_MODEL, MODEL_REVISION, MODEL_DTYPE, dims, 'cls', 1);
    const row = this.db.prepare(`SELECT id FROM embedding_profiles
      WHERE model_id=? AND revision=? AND dtype=? AND dims=? AND pooling=? AND normalize=?`)
      .get(EMBEDDING_MODEL, MODEL_REVISION, MODEL_DTYPE, dims, 'cls', 1) as { id: number };
    this.db.prepare(`INSERT INTO server_meta(key,value) VALUES('current_profile_id',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(row.id));
    this.db.prepare(`INSERT INTO server_meta(key,value) VALUES('query_prefix_version','1')
      ON CONFLICT(key) DO NOTHING`).run();
    return row.id;
  }

  // Real model loader used by the gate: version-independent cache dir with a
  // cross-process download lock. Preflight failure throws (gate -> failed);
  // silently falling back to the package-internal cache is forbidden (spec §7).
  private async buildRealLoader(): Promise<EmbedFn> {
    const cacheDir = resolveModelCacheDir(process.env, process.platform, os.homedir());
    const pf = preflightCacheDir(cacheDir);
    if (!pf.ok) throw new Error(`model cache dir not writable (${cacheDir}): ${pf.error}`);
    const key = artifactKey(EMBEDDING_MODEL, MODEL_REVISION, MODEL_DTYPE);
    const lock = new ModelDownloadLock(cacheDir, key);
    // Shutdown aborts the lock wait via the gate's AbortController (spec §3).
    console.error('⏳ acquiring model download lock...'); // deterministic lock-wait marker (5R test residual)
    const role = await lock.acquireOrWait({ timeoutMs: 10 * 60_000, signal: this.gate.abort.signal });
    try {
      this.gate.markDownloading();
      env.allowRemoteModels = true;
      env.allowLocalModels = true;
      console.error(`🤖 Loading embedding model: ${EMBEDDING_MODEL} (1024-dim, cache=${cacheDir})...`);
      const model = await pipeline('feature-extraction', EMBEDDING_MODEL,
        { revision: MODEL_REVISION, dtype: MODEL_DTYPE, cache_dir: cacheDir } as any);
      // dims fail-fast (spec §2 / beta B8): probe the ACTUAL output length — a
      // 384/768-dim custom model must fail here with a clear message, not at
      // every subsequent vector write.
      const probe = await model('dimension probe', { pooling: 'cls', normalize: true });
      const actualDims = (probe.data as Float32Array).length;
      if (actualDims !== 1024) {
        // Config incompatibility, NOT cache corruption (beta 2R B3): the
        // download and load both succeeded — quarantining or retrying cannot
        // change the model's dimensions.
        if (role === 'owner') lock.markComplete();  // cache itself is valid
        throw new TerminalConfigError(`embedding model ${EMBEDDING_MODEL} outputs ${actualDims} dims — this engine's vec0 tables are fixed at 1024. Use a 1024-dim model.`);
      }
      if (role === 'owner') lock.markComplete();
      console.error(`✅ ${EMBEDDING_MODEL} model loaded (${MODEL_DTYPE})`);
      return async (text: string, dims: number, isQuery: boolean) => {
        const input = isQuery ? `Represent this sentence for searching relevant passages: ${text}` : text;
        const r = await model(input, { pooling: 'cls', normalize: true });
        return new Float32Array((r.data as Float32Array).slice(0, dims));
      };
    } catch (e) {
      // Cache policy by CAUSE and ROLE (beta 2R B3 -> 4R M1 -> 5R M1), unit-
      // tested in modelCache: config errors touch nothing; integrity errors
      // invalidate the marker, and only a lock-holding OWNER may quarantine
      // (a ready-role process racing other readers never deletes shared
      // files); OOM/network/unknown preserve everything.
      const action = handleLoaderFailure({
        role, error: e, lock, cacheDir, modelId: EMBEDDING_MODEL,
        terminal: e instanceof TerminalConfigError,
      });
      if (action === 'quarantined') console.error('🧹 cache-integrity failure (owner) — model cache quarantined');
      else if (action === 'marker-invalidated') console.error('… cache-integrity failure (reader) — marker dropped, next retry re-proves as locked owner');
      else if (!(e instanceof TerminalConfigError)) console.error('… non-integrity load failure — model cache preserved');
      throw e;
    } finally {
      lock.release();
    }
  }

  // Background provenance reconciliation (spec §6b). Runs in parallel with the
  // model load; vector search and automatic backfill stay closed until it
  // settles (eligibility barrier in the coordinator).
  async startReconciliation(): Promise<void> {
    if (!this.coordinator) return;
    await this.coordinator.runReconciliation();
    this.coordinator.sweepStart();
  }

  // sha256 with the entity text-builder version mixed in: a builder change
  // re-backfills entities only, never chunks (spec §6c N2).
  hashWithBuilderVersion(text: string): string {
    return createHash('sha256').update(`${TEXT_BUILDER_VERSION}\n${text}`).digest('hex');
  }

  // Rebuild the CURRENT embedding input hash for an entity. null = entity gone
  // or malformed observations — reconciliation fail-closes to missing.
  entityInputHash(entityId: string): string | null {
    try {
      const entity = this.db!.prepare(`SELECT name, entityType, observations FROM entities WHERE id = ?`)
        .get(entityId) as { name: string; entityType: string; observations: string } | undefined;
      if (!entity) return null;
      const built = this.buildEntityEmbeddingText({
        name: entity.name,
        entityType: entity.entityType,
        observations: JSON.parse(entity.observations),
      });
      return this.hashWithBuilderVersion(built.text);
    } catch {
      return null;
    }
  }

  // Mutation-path embedding wrapper (spec §5): CRUD success never depends on
  // model availability. On not-ready/disabled the stale vector is deleted in
  // the same breath (dirty = missing, §6a-1) and the coordinator is kicked so
  // the row is recovered without a restart (§5 kick column).
  async tryEmbedEntity(entityId: string, priority: EmbedPriority = 'bulk'): Promise<'embedded' | 'queued' | 'disabled'> {
    try {
      const ok = await this.embedEntity(entityId, priority);
      if (ok) {
        // Success clears any stale backfill-failure record for this target.
        this.db!.prepare(`DELETE FROM embedding_backfill_failures WHERE kind = 'entity' AND target_id = ?`).run(entityId);
        this.coordinator?.invalidateCoverage();
        return 'embedded';
      }
      this.invalidateEntityVector(entityId);
      this.coordinator?.kick();
      return 'queued';
    } catch (e) {
      // Any embedding-layer failure (not-ready, disabled, OR a ready-state
      // inference error) must not fail the CRUD that already committed. The
      // vector is invalidated (§6a-1) and recovery is owned by the backfill
      // scanner with its attempts cap — never by rethrowing here (spec §5).
      if (!(e instanceof GateNotReadyError) && !(e instanceof GateDisabledError)) {
        console.error(`⚠️ embedding failed for ${entityId} (queued for backfill): ${e instanceof Error ? e.message : e}`);
      }
      this.invalidateEntityVector(entityId);
      this.coordinator?.kick();
      return e instanceof GateDisabledError ? 'disabled' : 'queued';
    }
  }

  // §6a-1 (beta B2): the entity change and the stale-vector removal commit in
  // ONE synchronous transaction, BEFORE any inference await. No window exists
  // where another tool call can retrieve the pre-mutation vector, and a crash
  // between mutation and re-embed leaves a clean missing state (backfill
  // target), never a stale-searchable one.
  // spec §4.5 단계 1: 관찰 변경 · projection 재합성 · entity vector 무효화 ·
  // stale KG chunk 제거를 한 트랜잭션으로 묶는다. 하나만 되면 검색이 낡은
  // 사실을 계속 반환한다.
  // mutate 가 명시적으로 false 를 반환하면 "아무것도 바꾸지 않았다"는 뜻이고
  // projection 재합성·벡터 무효화·KG 정리를 건너뛴다. 이 경로가 없으면
  // 무변경 upsert 나 dedup-only add 가 **정상 벡터를 지우고 재임베딩도 안 해서**
  // 검색 품질만 깎는다(advisor 구현리뷰 r1 발견 1, 실행 재현).
  // 반환값 = 실제로 변경이 있었는가.
  private mutateEntityAndInvalidate(entityId: string, mutate: () => boolean | void): boolean {
    let changed = false;
    const tx = this.db!.transaction(() => {
      changed = mutate() !== false;
      if (!changed) return;
      rebuildProjection(this.db!, entityId);
      this.invalidateDerivedForEntity(entityId);
    });
    tx();
    if (changed) this.coordinator?.invalidateCoverage();
    return changed;
  }

  // 관찰이 바뀐 entity 의 파생 상태를 무효화한다: entity vector + stale KG chunk.
  // **트랜잭션을 열지 않는다** — 호출자가 이미 하나의 단위 안에 있다고 가정한다.
  //
  // importGraph 가 이 단계를 건너뛰고 있었다: projection 만 재합성하고 파생 상태를
  // 그대로 둬서, 이미 존재하는 entity 를 import 로 덮으면 옛 벡터·옛 KG chunk 가
  // 계속 검색에 나왔다(advisor beta 발견 2, hybridSearch 로 실측 재현).
  // 그래서 "모든 관찰 변경은 mutateEntityAndInvalidate 를 통한다"는 규칙에
  // 예외가 하나 있었고, 그 예외가 정확히 그 규칙이 막으려던 결함을 만들었다.
  private invalidateDerivedForEntity(entityId: string): void {
    const meta = this.db!.prepare(`SELECT rowid FROM entity_embedding_metadata WHERE entity_id = ?`)
      .get(entityId) as { rowid: number } | undefined;
    if (meta) {
      this.db!.exec(`DELETE FROM entity_embeddings WHERE rowid = ${Number(meta.rowid)}`);
      this.db!.prepare(`DELETE FROM entity_embedding_metadata WHERE entity_id = ?`).run(entityId);
    }
    deleteStaleKgChunks(this.db!, entityId);
  }

  // §6a-1 invariant: when an entity's embedding input changed but re-embedding
  // is unavailable, its old vector must not stay searchable.
  invalidateEntityVector(entityId: string): void {
    if (!this.db) return;
    const meta = this.db.prepare(`SELECT rowid FROM entity_embedding_metadata WHERE entity_id = ?`)
      .get(entityId) as { rowid: number } | undefined;
    if (!meta) return;
    const tx = this.db.transaction(() => {
      this.db!.exec(`DELETE FROM entity_embeddings WHERE rowid = ${Number(meta.rowid)}`);
      this.db!.prepare(`DELETE FROM entity_embedding_metadata WHERE entity_id = ?`).run(entityId);
    });
    tx();
    this.coordinator?.invalidateCoverage();
  }

  // Backfill callback: re-embed one chunk and commit vector + provenance in a
  // single transaction (§6a-2).
  async reembedChunkByRowid(rowid: number): Promise<boolean> {
    if (!this.db) return false;
    const row = this.db.prepare(`SELECT text FROM chunk_metadata WHERE rowid = ?`)
      .get(rowid) as { text: string | null } | undefined;
    if (!row || row.text === null) return false;
    try {
      const embedding = await this.generateEmbedding(row.text, 1024, false, 'backfill');
      const hash = createHash('sha256').update(row.text).digest('hex');
      const safe = Number(rowid);
      // Write-back CAS (beta 2R B1): the rowid may have been deleted and reused
      // by a re-sync while inference ran — re-read the CURRENT text in the
      // transaction and only write when it still matches what was embedded.
      const tx = this.db.transaction((): boolean => {
        const cur = this.db!.prepare(`SELECT text FROM chunk_metadata WHERE rowid = ?`).get(rowid) as { text: string | null } | undefined;
        if (!cur || cur.text !== row.text) return false;       // superseded — discard
        this.db!.exec(`DELETE FROM chunks WHERE rowid = ${safe}`);
        this.db!.prepare(`INSERT INTO chunks (rowid, embedding) VALUES (${safe}, ?)`).run(Buffer.from(embedding.buffer));
        this.db!.prepare(`UPDATE chunk_metadata SET input_hash = ?, profile_id = ?, provenance_state = 'verified' WHERE rowid = ?`)
          .run(hash, this.currentProfileId, rowid);
        this.db!.prepare(`DELETE FROM embedding_backfill_failures WHERE kind = 'chunk' AND target_id = ?`).run(String(rowid));
        return true;
      });
      const written = tx();
      this.coordinator?.invalidateCoverage();
      return written;
    } catch (e) {
      if (e instanceof GateNotReadyError || e instanceof GateDisabledError) return false;
      throw e;
    }
  }

  // spec §3 shutdown order (beta B1): block new batches -> settle coordinator
  // (INCLUDING an in-flight reconciliation pass) -> settle gate (INCLUDING an
  // in-flight model load, bounded) -> close DB -> natural exit.
  //
  // Bounded-exit rationale, re-derived after beta 1R: the exit decision is made
  // AFTER the settle wait, not before — if the load completed during settling
  // (ONNX session now exists) we take the natural-exit path. Only when the load
  // is STILL pending after the deadline (dominant case: the 1.2GB download,
  // which is un-abortable through transformers.js and would hold the event
  // loop indefinitely) do we exit(). At that point the DB is already closed
  // cleanly, so even the residual worst case — the load being inside ONNX
  // session construction at exit — risks an ugly abort message, never data
  // loss. Hanging forever is the alternative and is worse.
  async shutdownAll(): Promise<void> {
    console.error('\n🧹 Cleaning up...');
    try { await this.coordinator?.shutdown(5000); } catch { /* settle best-effort */ }
    try { await this.gate?.shutdown(5000); } catch { /* settle best-effort */ }
    const loadStillPending = this.gate?.loadInFlight ?? false;
    try { this.cleanup(); } catch { /* DB close */ }
    process.exitCode = process.exitCode ?? 0;
    if (loadStillPending) {
      console.error('… model load/download still in flight after settle deadline — bounded exit (DB already closed)');
      process.exit(process.exitCode);
    }
  }

  async runMigrations(): Promise<{ applied: number; currentVersion: number; appliedMigrations: Array<{ version: number; description: string }> }> {
    if (!this.db) throw new Error('Database not initialized');

    console.error('🔄 Running database migrations...');
    
    // Initialize migration manager
    const migrationManager = new MigrationManager(this.db);
    
    // Add all migrations
    migrations.forEach(migration => {
      migrationManager.addMigration(migration);
    });
    
    // Get pending migrations before running them
    const pendingBefore = migrationManager.getPendingMigrations();

    // spec §5.1: 대기 중 마이그레이션이 있으면 먼저 일관 스냅샷을 남긴다.
    // 실패는 throw = fail-closed (백업 없이 스키마를 바꾸지 않는다).
    // await: 백업은 Online Backup API 를 쓰므로 비동기다. 여기서 await 를 빠뜨리면
    // 백업이 끝나기 전에 마이그레이션이 시작한다 = 백업 없이 스키마를 바꾸는 것이다.
    await backupBeforeMigration(this.db, DB_FILE_PATH, pendingBefore.map(m => m.version),
                                migrationManager.getCurrentVersion());

    // Run pending migrations
    const result = await migrationManager.runMigrations();
    
    console.error(`🔧 Database schema ready (version ${result.currentVersion}, ${result.applied} migrations applied)`);
    
    return {
      applied: result.applied,
      currentVersion: result.currentVersion,
      appliedMigrations: pendingBefore.slice(0, result.applied).map(m => ({
        version: m.version,
        description: m.description
      }))
    };
  }

  cleanup() {
    if (this.encoding) {
      this.encoding.free();
      this.encoding = null;
    }
    this.embeddingCache.clear();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // === ORIGINAL MCP FUNCTIONALITY ===

  private _timestampObservation(obs: string): string {
    // Stamp and dedup share one parser (src/observations/date-prefix.ts). They used to carry
    // separate regexes and disagreed about "[2026-08-11 session16] ...": stamping treated it as
    // undated and prepended a second date, while dedup could not strip it — so the same sentence
    // written in two sessions became two observations. Measured on a live database: 82 rows with
    // two dates, 29 with a day earlier than the day they were written.
    return stampDatePrefix(obs, this.calendarTimeZone);
  }

  async createEntities(entities: Array<Entity & {
    status?: 'active' | 'provisional'; sources?: SourceInput[];
  }>): Promise<Array<Entity & { created?: boolean; observation_ids?: (string | null)[] }>> {
    if (!this.db) throw new Error('Database not initialized');

    const result: Array<Entity & { created?: boolean; observation_ids?: (string | null)[] }> = [];
    // v13: 관찰은 lifecycle 테이블이 정본이고 entities.observations 는 projection 이다.
    // entity 행은 빈 배열로 만들고 rebuildProjection 이 채운다.
    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO entities (id, name, entityType, observations, metadata)
      VALUES (?, ?, ?, '[]', ?)
    `);
    const stripDate = stripDatePrefix;   // shared with the stamp path — see date-prefix.ts

    for (const entity of entities) {
      const entityId = `entity_${entity.name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;
      const ts = new Date().toISOString();
      const ids: (string | null)[] = [];
      let created = false;
      let addedCount = 0;
      let typeUpdated = false;

      // entity INSERT 도 같은 트랜잭션 안이다. 밖에 두면 lifecycle INSERT 가
      // 실패할 때 entity 행만 남는 split state 가 생긴다
      // (advisor 구현리뷰 r1 발견 2, 실행 재현).
      const changed = this.mutateEntityAndInvalidate(entityId, () => {
        created = insertStmt.run(entityId, entity.name, entity.entityType, '{}').changes > 0;

        if (!created && entity.entityType && entity.entityType !== 'CONCEPT') {
          const cur = this.db!.prepare(`SELECT entityType FROM entities WHERE id = ?`)
            .get(entityId) as { entityType: string } | undefined;
          if (cur && cur.entityType !== entity.entityType) {
            this.db!.prepare(`UPDATE entities SET entityType = ? WHERE id = ?`)
              .run(entity.entityType, entityId);
            typeUpdated = true;
          }
        }

        const activeRows = this.db!.prepare(
          `SELECT observation_id, content FROM entity_observations
           WHERE entity_id = ? AND status = 'active'`).all(entityId) as
          Array<{ observation_id: string; content: string }>;
        const activeByBare = new Map(activeRows.map(r => [stripDate(r.content), r.observation_id]));

        let sourcesAdded = 0;
        for (const raw of (entity.observations || [])) {
          const content = this._timestampObservation(raw);
          const bare = stripDate(content);
          const dupId = activeByBare.get(bare);
          if (dupId) {
            // 같은 사실이 다른 출처에서 다시 왔다 = evidence 추가, 새 revision 아님.
            if (entity.sources?.length) sourcesAdded += linkSources(this.db!, dupId, entity.sources, ts);
            ids.push(null);
            continue;
          }
          const id = addRevision(this.db!, {
            entityId, content, status: entity.status ?? 'active', sources: entity.sources, ts
          });
          activeByBare.set(bare, id);
          ids.push(id);
          addedCount++;
        }

        // 아무것도 안 바뀌었으면 projection·벡터·KG 를 건드리지 않는다.
        return created || typeUpdated || addedCount > 0 || sourcesAdded > 0;
      });

      const projected = JSON.parse(
        (this.db.prepare(`SELECT observations FROM entities WHERE id = ?`)
          .get(entityId) as { observations: string }).observations) as string[];

      // 재임베딩은 무효화가 실제로 일어났을 때만. 조건이 갈리면
      // "벡터를 지우고 다시 만들지 않는" 창이 생긴다.
      if (changed) {
        console.error(created
          ? `🔮 Generating embedding for new entity: ${entity.name}`
          : `♻️ Upserted entity: ${entity.name} (+${addedCount} obs${typeUpdated ? ', type→' + entity.entityType : ''})`);
        const embedding_status = await this.tryEmbedEntity(entityId, 'bulk');
        result.push({ ...entity, observations: projected, created,
                      observation_ids: ids, embedding_status } as any);
      } else {
        result.push({ ...entity, observations: projected, created, observation_ids: ids } as any);
      }
    }

    return result;
  }

  async createRelations(relations: Relation[]): Promise<Relation[]> {
    if (!this.db) throw new Error('Database not initialized');
    
    const newRelations = [];

    for (const relation of relations) {
      // Ensure entities exist. v3.6 (spec §5c): auto-created endpoints may be
      // embedded/queued/disabled independently — report per endpoint; 'n/a'
      // means the endpoint already existed (no embedding work happened here).
      const ensured = await this.createEntities([
        { name: relation.from, entityType: 'CONCEPT', observations: [] },
        { name: relation.to, entityType: 'CONCEPT', observations: [] }
      ]);
      const statusOf = (name: string): 'embedded' | 'queued' | 'disabled' | 'n/a' => {
        const hit = ensured.find(e => e.name === name) as (Entity & { embedding_status?: 'embedded' | 'queued' | 'disabled' }) | undefined;
        return hit?.embedding_status ?? 'n/a';
      };
      const endpoint_embedding_status = { from: statusOf(relation.from), to: statusOf(relation.to) };

      const sourceId = `entity_${relation.from.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;
      const targetId = `entity_${relation.to.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;
      const relationId = `rel_${sourceId}_${relation.relationType}_${targetId}`.toLowerCase();

      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO relationships
        (id, source_entity, target_entity, relationType, confidence, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(relationId, sourceId, targetId, relation.relationType, 1.0, '{}');
      if (result.changes > 0) {
        newRelations.push({ ...relation, endpoint_embedding_status } as Relation);
      }
    }

    this.coordinator?.kick();
    return newRelations;
  }

  async addObservations(observations: {
    entityName: string; contents: string[];
    status?: 'active' | 'provisional';
    sources?: SourceInput[];
  }[]): Promise<Array<{ entityName: string; observation_ids: (string | null)[];
                        addedObservations: string[]; embedding_status?: string }>> {
    if (!this.db) throw new Error('Database not initialized');

    const results: Array<{ entityName: string; observation_ids: (string | null)[];
                           addedObservations: string[]; embedding_status?: string }> = [];

    for (const obs of observations) {
      const entityId = `entity_${obs.entityName.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;
      const entity = this.db.prepare(`SELECT id FROM entities WHERE id = ?`).get(entityId);
      if (!entity) throw new Error(`Entity with name ${obs.entityName} not found`);

      // dedup 기준은 v3.6 과 같다: 날짜 prefix 를 뗀 본문이 active 에 이미 있으면
      // 새 revision 을 만들지 않는다. 다만 v13 에서는 같은 사실이 다른 출처에서 다시
      // 온 것이므로 그 revision 에 source link 를 더한다(spec §8.3 T13).
      const stripDate = stripDatePrefix;   // shared with the stamp path — see date-prefix.ts
      const activeRows = this.db.prepare(
        `SELECT observation_id, content FROM entity_observations
         WHERE entity_id = ? AND status = 'active'`).all(entityId) as
        Array<{ observation_id: string; content: string }>;
      const activeByBare = new Map(activeRows.map(r => [stripDate(r.content), r.observation_id]));

      const ts = new Date().toISOString();
      const ids: (string | null)[] = [];
      const added: string[] = [];

      let sourcesAdded = 0;
      const changed = this.mutateEntityAndInvalidate(entityId, () => {
        for (const raw of obs.contents) {
          const content = this._timestampObservation(raw);
          const bare = stripDate(content);
          const dupId = activeByBare.get(bare);
          if (dupId) {
            if (obs.sources?.length) sourcesAdded += linkSources(this.db!, dupId, obs.sources, ts);
            ids.push(null);
            continue;
          }
          const id = addRevision(this.db!, {
            entityId, content, status: obs.status ?? 'active', sources: obs.sources, ts
          });
          activeByBare.set(bare, id);
          ids.push(id);
          added.push(content);
        }
        // 아무것도 안 바뀌었으면 projection·벡터·KG 를 건드리지 않는다.
        // 이 반환이 없으면 빈 contents 나 dedup-only add 가 정상 벡터를
        // 지우고 재임베딩도 안 한다(advisor 구현리뷰 r1 발견 1).
        return added.length > 0 || sourcesAdded > 0;
      });

      let embedding_status: string | undefined;
      if (changed) {
        console.error(`🔮 Regenerating embedding for updated entity: ${obs.entityName}`);
        embedding_status = await this.tryEmbedEntity(entityId, 'bulk');
      }
      results.push({ entityName: obs.entityName, observation_ids: ids,
                     addedObservations: added, embedding_status });
    }
    return results;
  }

  async correctObservation(
    observationId: string, content: string,
    changeKind: 'correction' | 'world_change' = 'correction',
    reason?: string
  ): Promise<string> {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(`SELECT entity_id FROM entity_observations WHERE observation_id = ?`)
      .get(observationId) as { entity_id: string } | undefined;
    if (!row) throw new Error(`observation ${observationId} not found`);

    let newId = '';
    const ts = new Date().toISOString();
    this.mutateEntityAndInvalidate(row.entity_id, () => {
      newId = correctRevision(this.db!, {
        observationId, content: this._timestampObservation(content),
        changeKind, reason: reason ?? null, ts
      });
    });
    await this.tryEmbedEntity(row.entity_id, 'bulk');
    return newId;
  }

  private async _transition(
    observationId: string,
    event: 'retract' | 'restore' | 'approve' | 'decline',
    reason?: string
  ): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(`SELECT entity_id FROM entity_observations WHERE observation_id = ?`)
      .get(observationId) as { entity_id: string } | undefined;
    if (!row) throw new Error(`observation ${observationId} not found`);
    const ts = new Date().toISOString();
    this.mutateEntityAndInvalidate(row.entity_id, () => {
      transitionStatus(this.db!, { observationId, event, reason: reason ?? null, ts });
    });
    await this.tryEmbedEntity(row.entity_id, 'bulk');
  }

  async retractObservation(observationId: string, reason?: string): Promise<void> {
    return this._transition(observationId, 'retract', reason);
  }
  async restoreObservation(observationId: string, reason?: string): Promise<void> {
    return this._transition(observationId, 'restore', reason);
  }
  async approveObservation(observationId: string, reason?: string): Promise<void> {
    return this._transition(observationId, 'approve', reason);
  }
  async declineObservation(observationId: string, reason: string): Promise<void> {
    return this._transition(observationId, 'decline', reason);
  }

  // DESTRUCTIVE. Physically removes revisions (and their sources via CASCADE).
  //
  // Chain contract (advisor 구현리뷰 r1 발견 4): a revision chain is
  // rev1 <- rev2 <- ... and purging a middle revision would either fail on the
  // supersedes_id FK or leave a chain pointing at a deleted row, plus events
  // whose from_id/to_id dangle. So purge is defined as **suffix purge from the
  // target to the newest revision of that root**, newest-first:
  //   - purging the newest revision removes exactly it
  //   - purging rev2 of a 3-revision chain removes rev3 then rev2
  //   - purging rev1 removes the whole chain
  // Events for purged revisions are removed too, so no event dangles.
  // The root row is always kept: its projection_order stays reserved, because
  // reusing an order would make a later restore/approve fail on the
  // active-order index.
  async purgeObservation(observationId: string, confirm: string): Promise<{ purged: number }> {
    if (!this.db) throw new Error('Database not initialized');
    if (confirm !== 'PURGE') {
      throw new Error(
        `purgeObservation refused: pass confirm='PURGE' to physically delete a revision. ` +
        `This destroys history — retractObservation() is almost always what you want.`);
    }
    const row = this.db.prepare(
      `SELECT entity_id, root_id, revision_no FROM entity_observations WHERE observation_id = ?`)
      .get(observationId) as { entity_id: string; root_id: string; revision_no: number } | undefined;
    if (!row) return { purged: 0 };

    let purged = 0;
    this.mutateEntityAndInvalidate(row.entity_id, () => {
      // newest-first so each DELETE has no successor referencing it
      const victims = this.db!.prepare(
        `SELECT observation_id FROM entity_observations
         WHERE root_id = ? AND revision_no >= ?
         ORDER BY revision_no DESC`
      ).all(row.root_id, row.revision_no) as Array<{ observation_id: string }>;
      for (const v of victims) {
        this.db!.prepare(
          `DELETE FROM observation_events WHERE from_id = ? OR to_id = ?`)
          .run(v.observation_id, v.observation_id);
        purged += this.db!.prepare(`DELETE FROM entity_observations WHERE observation_id = ?`)
          .run(v.observation_id).changes;
      }
      return purged > 0;
    });
    await this.tryEmbedEntity(row.entity_id, 'bulk');
    return { purged };
  }

  // spec §6.2: 과거 판본은 여기서만 나온다. 일반 검색은 active 만 반환한다.
  async getObservationHistory(sel: { entity_name?: string; observation_id?: string; root_id?: string }) {
    if (!this.db) throw new Error('Database not initialized');
    return getObservationHistory(this.db, sel);
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    console.error(`🗑️ Deleting entities: ${entityNames.join(', ')}`);

    for (const name of entityNames) {
      const entityId = `entity_${name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;

      // One entity = one transaction. The four deletion steps are a single unit:
      // a mid-sequence failure must roll back, not leave embeddings/links purged while
      // the entity itself survives (2026-08-24 audit finding; regression =
      // test/delete-entities-kg-hygiene.test.mjs ⓒ). Batch semantics are preserved —
      // other entities still proceed when one fails.
      try {
        const deleted = this.db.transaction((eid: string): boolean => {
          // Check if entity exists first
          const entityExists = this.db!.prepare(`
            SELECT id FROM entities WHERE id = ?
          `).get(eid);

          if (!entityExists) return false;

          // Step 0: Delete entity embeddings
          const embeddingMetadata = this.db!.prepare(`
            SELECT rowid FROM entity_embedding_metadata WHERE entity_id = ?
          `).get(eid) as { rowid: number } | undefined;

          if (embeddingMetadata) {
            const embeddings = this.db!.prepare(`
              DELETE FROM entity_embeddings WHERE rowid = ?
            `).run(embeddingMetadata.rowid);

            const metadata = this.db!.prepare(`
              DELETE FROM entity_embedding_metadata WHERE entity_id = ?
            `).run(eid);

            if (embeddings.changes > 0 || metadata.changes > 0) {
              console.error(`  ├─ Removed entity embeddings for '${name}'`);
            }
          }

          // Step 1: Delete chunk-entity associations
          const chunkAssociations = this.db!.prepare(`
            DELETE FROM chunk_entities WHERE entity_id = ?
          `).run(eid);
          if (chunkAssociations.changes > 0) {
            console.error(`  ├─ Removed ${chunkAssociations.changes} chunk associations for '${name}'`);
          }

          // Step 2: Capture relationship ids BEFORE deleting the rows — KG relationship
          // chunks are keyed by relationship_id, so after the DELETE they could no
          // longer be found and would dangle forever.
          const relIds = this.db!.prepare(`
            SELECT id FROM relationships
            WHERE source_entity = ? OR target_entity = ?
          `).all(eid, eid) as Array<{ id: string }>;

          const relationships = this.db!.prepare(`
            DELETE FROM relationships
            WHERE source_entity = ? OR target_entity = ?
          `).run(eid, eid);
          if (relationships.changes > 0) {
            console.error(`  ├─ Removed ${relationships.changes} relationships for '${name}'`);
          }

          // Step 2b: KG hygiene — sweep stale entity chunks and chunks of the captured
          // relationships. The generation path is dormant today (generateKnowledgeGraphChunks
          // is not tool-exposed), but once seeded these chunks stay vector-searchable after
          // deletion unless swept here (same fail-closed rationale as deleteStaleKgChunks).
          deleteStaleKgChunks(this.db!, eid);
          deleteKgRelationshipChunks(this.db!, relIds.map(r => r.id));

          // Step 3: Finally delete the entity itself (FK CASCADE takes observation lifecycle rows)
          const entity = this.db!.prepare(`
            DELETE FROM entities WHERE id = ?
          `).run(eid);

          return entity.changes > 0;
        })(entityId);

        if (deleted) {
          console.error(`  └─ Deleted entity '${name}' successfully`);
        } else {
          console.warn(`⚠️ Entity '${name}' not found, skipping`);
        }

      } catch (error) {
        console.error(`❌ Failed to delete entity '${name}' (transaction rolled back, continuing):`, error);
        // Continue with other entities instead of failing completely
      }
    }

    console.error(`✅ Entity deletion process completed`);
  }

  // v3.6 (spec §5c, breaking): structured per-entity results + re-embedding.
  // Pre-3.6 this method silently left STALE entity vectors behind (the input
  // text changed but the vector was never regenerated) — fixed via
  // tryEmbedEntity, which also covers the not-ready dirty contract.
  // DEPRECATED shim (v13, one version only). Content-addressed deletion cannot
  // express "which revision" — use retractObservation(observation_id) instead.
  // Semantics: exact-string match against ACTIVE revisions -> soft retract.
  //
  // The whole call is one transaction and ambiguity is judged before any
  // mutation: if any item matches 2+ active revisions the call aborts with 0
  // mutations (spec §6.3). That is a deliberate change from v3.6, which deleted
  // every duplicate and carried on — a machine cannot pick which revision was meant.
  //
  // Duplicate ids across items are collapsed. Without that, listing the same
  // (entity, content) twice retracted it once and then failed on an illegal
  // transition, returning an error *after* committing part of the batch
  // (advisor 구현리뷰 r1 발견 3, 실행 재현). Embedding runs after the commit.
  async deleteObservations(deletions: { entityName: string; observations: string[] }[]): Promise<{
    results: Array<{ entityName: string; deleted: number; embedding_status: string }>;
    total_deleted: number;
  }> {
    if (!this.db) throw new Error('Database not initialized');

    // pass 1 — resolve the whole batch, mutate nothing
    type Hit = { entityName: string; entityId: string; ids: string[] };
    const plan: Hit[] = [];
    const ambiguous: Array<{ entityName: string; content: string; matches: number }> = [];
    const claimed = new Set<string>();   // 항목 간 중복 id 흡수

    for (const d of deletions) {
      const entityId = `entity_${d.entityName.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;
      const ids: string[] = [];
      for (const content of d.observations) {
        const rows = this.db.prepare(
          `SELECT observation_id FROM entity_observations
           WHERE entity_id = ? AND status = 'active' AND content = ?`
        ).all(entityId, content) as Array<{ observation_id: string }>;
        if (rows.length > 1) {
          ambiguous.push({ entityName: d.entityName, content, matches: rows.length });
          continue;
        }
        if (rows.length === 1 && !claimed.has(rows[0].observation_id)) {
          claimed.add(rows[0].observation_id);
          ids.push(rows[0].observation_id);
        }
        // rows.length === 0 -> no-op (v3.6 behaviour, spec §6.3-3)
      }
      plan.push({ entityName: d.entityName, entityId, ids });
    }

    if (ambiguous.length > 0) {
      throw new Error(
        `AMBIGUOUS_OBSERVATION_MATCH: ${ambiguous.length} item(s) matched multiple active ` +
        `revisions; 0 mutations were applied. Use retractObservation(observation_id) instead. ` +
        `Conflicts: ${JSON.stringify(ambiguous)}`);
    }

    // pass 2 — mutate everything in ONE transaction so a failure anywhere
    // leaves zero mutations. Per-plan transactions plus an awaited embedding
    // in between made a partial commit observable.
    const touched = plan.filter(p => p.ids.length > 0);
    const ts = new Date().toISOString();
    if (touched.length > 0) {
      const tx = this.db.transaction(() => {
        for (const p of touched) {
          for (const id of p.ids) {
            transitionStatus(this.db!, { observationId: id, event: 'retract',
                                         reason: 'deleteObservations (deprecated shim)', ts });
          }
          rebuildProjection(this.db!, p.entityId);
          const meta = this.db!.prepare(
            `SELECT rowid FROM entity_embedding_metadata WHERE entity_id = ?`)
            .get(p.entityId) as { rowid: number } | undefined;
          if (meta) {
            this.db!.exec(`DELETE FROM entity_embeddings WHERE rowid = ${Number(meta.rowid)}`);
            this.db!.prepare(`DELETE FROM entity_embedding_metadata WHERE entity_id = ?`)
              .run(p.entityId);
          }
          deleteStaleKgChunks(this.db!, p.entityId);
        }
      });
      tx();
      this.coordinator?.invalidateCoverage();
    }

    // pass 3 — embedding after the commit
    const results: Array<{ entityName: string; deleted: number; embedding_status: string }> = [];
    let total = 0;
    for (const p of plan) {
      if (p.ids.length === 0) {
        results.push({ entityName: p.entityName, deleted: 0, embedding_status: 'n/a' });
        continue;
      }
      const embedding_status = await this.tryEmbedEntity(p.entityId, 'bulk');
      results.push({ entityName: p.entityName, deleted: p.ids.length, embedding_status });
      total += p.ids.length;
    }
    return { results, total_deleted: total };
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    for (const relation of relations) {
      const sourceId = `entity_${relation.from.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;
      const targetId = `entity_${relation.to.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;

      this.db.prepare(`
        DELETE FROM relationships
        WHERE source_entity = ? AND target_entity = ? AND relationType = ?
      `).run(sourceId, targetId, relation.relationType);
    }
  }

  async updateRelations(updates: { from: string; to: string; relationType: string; confidence?: number; metadata?: Record<string, any> }[]): Promise<{ updated: number; notFound: number }> {
    if (!this.db) throw new Error('Database not initialized');

    let updated = 0;
    let notFound = 0;

    for (const update of updates) {
      const sourceId = `entity_${update.from.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;
      const targetId = `entity_${update.to.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;
      const relationId = `rel_${sourceId}_${update.relationType}_${targetId}`.toLowerCase();

      // Check if relation exists
      const existing = this.db.prepare(`
        SELECT id FROM relationships WHERE id = ?
      `).get(relationId) as { id: string } | undefined;

      if (!existing) {
        notFound++;
        continue;
      }

      // Build dynamic update
      const setClauses: string[] = [];
      const values: any[] = [];

      if (update.confidence !== undefined) {
        setClauses.push('confidence = ?');
        values.push(update.confidence);
      }
      if (update.metadata !== undefined) {
        setClauses.push('metadata = ?');
        values.push(JSON.stringify(update.metadata));
      }

      if (setClauses.length === 0) {
        continue;
      }

      values.push(relationId);
      this.db.prepare(`
        UPDATE relationships SET ${setClauses.join(', ')} WHERE id = ?
      `).run(...values);
      updated++;
    }

    return { updated, notFound };
  }

  async readGraph(): Promise<KnowledgeGraph> {
    if (!this.db) throw new Error('Database not initialized');
    
    const entities = this.db.prepare(`
      SELECT name, entityType, observations FROM entities
    `).all().map((row: any) => ({
      name: row.name,
      entityType: row.entityType,
      observations: JSON.parse(row.observations)
    }));
    
    const relations = this.db.prepare(`
      SELECT 
        e1.name as from_name,
        e2.name as to_name,
        r.relationType
      FROM relationships r
      JOIN entities e1 ON r.source_entity = e1.id
      JOIN entities e2 ON r.target_entity = e2.id
    `).all().map((row: any) => ({
      from: row.from_name,
      to: row.to_name,
      relationType: row.relationType
    }));

    return { entities, relations };
  }

  async getNeighbors(entityNames: string[], depth: number = 1, relationType?: string): Promise<{
    entities: Array<{ name: string; entityType: string; observations: string[]; depth: number }>;
    relations: Array<{ from: string; to: string; relationType: string; depth: number }>;
    paths: Array<{ from: string; to: string; path: string[] }>;
  }> {
    if (!this.db) throw new Error('Database not initialized');

    // Cap depth at 5 to prevent runaway queries
    const effectiveDepth = Math.min(Math.max(depth, 1), 5);

    // Convert entity names to IDs
    const seedIds = entityNames.map(name => `entity_${name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`);

    // Build dynamic placeholders for the seed IDs
    const seedPlaceholders = seedIds.map(() => '?').join(',');

    // Build the recursive CTE query
    const relationFilter = relationType
      ? `AND r.relationType = ?`
      : '';

    const cteQuery = `
      WITH RECURSIVE traversal(entity_id, depth, path) AS (
        -- Base case: seed entities
        SELECT id, 0, id FROM entities WHERE id IN (${seedPlaceholders})
        UNION ALL
        -- Recursive: follow relationships up to max depth
        SELECT
          CASE WHEN r.source_entity = t.entity_id THEN r.target_entity ELSE r.source_entity END,
          t.depth + 1,
          t.path || ',' || CASE WHEN r.source_entity = t.entity_id THEN r.target_entity ELSE r.source_entity END
        FROM traversal t
        JOIN relationships r ON (r.source_entity = t.entity_id OR r.target_entity = t.entity_id)
        WHERE t.depth < ?
          ${relationFilter}
          -- Cycle detection: don't revisit entities already in path
          AND instr(t.path, CASE WHEN r.source_entity = t.entity_id THEN r.target_entity ELSE r.source_entity END) = 0
      )
      SELECT DISTINCT entity_id, MIN(depth) as min_depth, path
      FROM traversal
      GROUP BY entity_id
    `;

    // Build parameters
    const params: any[] = [...seedIds, effectiveDepth];
    if (relationType) {
      params.push(relationType);
    }

    const traversalResults = this.db.prepare(cteQuery).all(...params) as Array<{
      entity_id: string;
      min_depth: number;
      path: string;
    }>;

    if (traversalResults.length === 0) {
      return { entities: [], relations: [], paths: [] };
    }

    // Collect all discovered entity IDs
    const discoveredIds = traversalResults.map(r => r.entity_id);
    const idPlaceholders = discoveredIds.map(() => '?').join(',');

    // Fetch entity details
    const entityRows = this.db.prepare(`
      SELECT id, name, entityType, observations FROM entities WHERE id IN (${idPlaceholders})
    `).all(...discoveredIds) as Array<{
      id: string;
      name: string;
      entityType: string;
      observations: string;
    }>;

    // Build id-to-depth and id-to-name maps
    const idToDepth = new Map<string, number>();
    for (const r of traversalResults) {
      idToDepth.set(r.entity_id, r.min_depth);
    }
    const idToName = new Map<string, string>();
    for (const row of entityRows) {
      idToName.set(row.id, row.name);
    }

    const entities = entityRows.map(row => ({
      name: row.name,
      entityType: row.entityType,
      observations: JSON.parse(row.observations),
      depth: idToDepth.get(row.id) ?? 0,
    }));

    // Fetch relations between all discovered entities
    let relQuery = `
      SELECT
        r.source_entity,
        r.target_entity,
        e1.name as from_name,
        e2.name as to_name,
        r.relationType
      FROM relationships r
      JOIN entities e1 ON r.source_entity = e1.id
      JOIN entities e2 ON r.target_entity = e2.id
      WHERE r.source_entity IN (${idPlaceholders})
        AND r.target_entity IN (${idPlaceholders})
    `;
    const relParams: any[] = [...discoveredIds, ...discoveredIds];
    if (relationType) {
      relQuery += ` AND r.relationType = ?`;
      relParams.push(relationType);
    }

    const relationRows = this.db.prepare(relQuery).all(...relParams) as Array<{
      source_entity: string;
      target_entity: string;
      from_name: string;
      to_name: string;
      relationType: string;
    }>;

    const relations = relationRows.map(row => ({
      from: row.from_name,
      to: row.to_name,
      relationType: row.relationType,
      depth: Math.max(idToDepth.get(row.source_entity) ?? 0, idToDepth.get(row.target_entity) ?? 0),
    }));

    // Build shortest paths from seed entities to all discovered entities
    const paths: Array<{ from: string; to: string; path: string[] }> = [];
    for (const result of traversalResults) {
      if (result.min_depth === 0) continue; // Skip seed entities themselves
      const pathIds = result.path.split(',');
      const pathNames = pathIds.map(id => idToName.get(id) || id).filter(Boolean);
      if (pathNames.length >= 2) {
        paths.push({
          from: pathNames[0],
          to: pathNames[pathNames.length - 1],
          path: pathNames,
        });
      }
    }

    console.error(`✅ getNeighbors: Found ${entities.length} entities, ${relations.length} relations, ${paths.length} paths (depth=${effectiveDepth})`);

    return { entities, relations, paths };
  }

  // v3.6 (spec §5·§5c, additive): FTS lexical fallback when vector search is
  // not eligible, hybrid-partial merge while backfill is catching up, and
  // top-level state fields on every response.
  async searchNodes(query: string, limit = 10, since?: string, until?: string): Promise<KnowledgeGraph & {
    search_mode?: string; model_state?: string; coverage?: { entity_pct: number };
    degradation_reason?: string; warning?: string;
  }> {
    if (!this.db) throw new Error('Database not initialized');

    console.error(`🔍 Semantic entity search: "${query}"`);

    const covS = this.coordinator?.coverage();
    const entityPct = covS && covS.entity.total > 0 ? Math.round((covS.entity.embedded / covS.entity.total) * 100) : 100;
    const stateFields = () => ({
      model_state: this.gate.status.state,
      coverage: { entity_pct: entityPct },
    });

    if (!(this.coordinator?.eligible ?? false)) {
      // No waiting on the model (spec §5) — lexical entities_fts fallback.
      return { ...this.searchNodesFts(query, limit, since, until), search_mode: 'fts-only',
        ...stateFields(), degradation_reason: this.degradationReason() };
    }

    const queryVariants = this.buildCrossLingualVariants(query);
    if (queryVariants.length > 1) {
      console.error(`🌐 searchNodes variants: ${queryVariants.slice(1).join(' | ')}`);
    }

    const searchEntities = (embedding: Float32Array, k: number) => {
      return this.db!.prepare(`
        SELECT
          ee.rowid,
          eem.entity_id,
          eem.embedding_text,
          ee.distance,
          e.name,
          e.entityType,
          e.observations
        FROM entity_embeddings ee
        JOIN entity_embedding_metadata eem ON ee.rowid = eem.rowid
        JOIN entities e ON eem.entity_id = e.id
        WHERE ee.embedding MATCH ?
          AND k = ?
        ORDER BY ee.distance
      `).all(Buffer.from(embedding.buffer), k) as Array<{
        rowid: number;
        entity_id: string;
        embedding_text: string;
        distance: number;
        name: string;
        entityType: string;
        observations: string;
      }>;
    };

    const resultMap = new Map<string, {
      rowid: number;
      entity_id: string;
      embedding_text: string;
      distance: number;
      name: string;
      entityType: string;
      observations: string;
    }>();

    try {
      for (const variant of queryVariants) {
        const embedding = await this.generateEmbedding(variant, 1024, true);
        const variantResults = searchEntities(embedding, limit * 2);
        for (const result of variantResults) {
          const existing = resultMap.get(result.entity_id);
          if (!existing || result.distance < existing.distance) {
            resultMap.set(result.entity_id, result);
          }
        }
      }
    } catch (embErr) {
      // Ready-state inference failure degrades to FTS instead of failing the
      // tool (beta B6) — same contract as hybridSearch. The gate's own
      // consecutive-failure counter handles the systemic transition.
      console.error(`⚠️ searchNodes vector path failed — FTS fallback:`, embErr instanceof Error ? embErr.message : embErr);
      return { ...this.searchNodesFts(query, limit, since, until), search_mode: 'fts-only',
        ...stateFields(), degradation_reason: this.degradationReason() ?? 'inference_error' };
    }

    const entityResults = Array.from(resultMap.values()).sort((a, b) => a.distance - b.distance).slice(0, limit);

    // Filter by temporal range if specified
    let filteredResults = entityResults;
    if (since || until) {
      filteredResults = entityResults.filter(r => {
        const entity = this.db!.prepare('SELECT created_at FROM entities WHERE id = ?').get(r.entity_id) as { created_at: string } | undefined;
        if (!entity) return false;
        if (since && entity.created_at < since) return false;
        if (until && entity.created_at > until) return false;
        return true;
      });
    }

    const entities = filteredResults.map(result => ({
      name: result.name,
      entityType: result.entityType,
      observations: JSON.parse(result.observations),
      similarity: Math.max(0, 1 - result.distance / 2) // Convert cosine distance (0-2) to similarity (1-0)
    }));

    // hybrid-partial (spec §4): entities without vectors must not vanish from
    // search while backfill catches up — merge lexical FTS hits for the gap.
    let search_mode: string = 'hybrid';
    if (entityPct < 100) {
      search_mode = 'hybrid-partial';
      const seen = new Set(entities.map(e => e.name));
      const ftsExtra = this.searchNodesFts(query, limit, since, until);
      for (const e of ftsExtra.entities) {
        if (entities.length >= limit) break;
        if (!seen.has(e.name)) { seen.add(e.name); entities.push(e as any); }
      }
    }

    if (entities.length === 0) {
      console.error(`ℹ️ No semantic matches found for "${query}"`);
      return { entities: [], relations: [], search_mode, ...stateFields() };
    }

    const relations = this.relationsAmong(entities.map(e => e.name));
    console.error(`✅ Found ${entities.length} semantically similar entities with ${relations.length} relationships`);

    return { entities, relations, search_mode, ...stateFields() };
  }

  // Lexical entity search over entities_fts (spec §5 contract: name /
  // observations / entityType lexical match — no semantic-equivalence claim).
  // Temporal filters apply in SQL so LIMIT is not distorted.
  private searchNodesFts(query: string, limit: number, since?: string, until?: string): KnowledgeGraph & { warning?: string } {
    const expr = compileFtsLiteralQuery(query);
    if (expr === null) {
      return { entities: [], relations: [], warning: 'query has no searchable terms' };
    }
    const rows = this.db!.prepare(`
      SELECT e.name, e.entityType, e.observations
      FROM entities_fts f
      JOIN entities e ON f.rowid = e.rowid
      WHERE entities_fts MATCH @expr
        ${since ? 'AND e.created_at >= @since' : ''}
        ${until ? 'AND e.created_at <= @until' : ''}
      ORDER BY bm25(entities_fts)
      LIMIT @limit
    `).all({ expr, since, until, limit }) as Array<{ name: string; entityType: string; observations: string }>;
    const entities = rows.map(r => ({
      name: r.name,
      entityType: r.entityType,
      observations: JSON.parse(r.observations),
    }));
    return { entities, relations: this.relationsAmong(entities.map(e => e.name)) };
  }

  private relationsAmong(entityNames: string[]): Relation[] {
    if (entityNames.length === 0) return [];
    return this.db!.prepare(`
      SELECT
        e1.name as from_name,
        e2.name as to_name,
        r.relationType
      FROM relationships r
      JOIN entities e1 ON r.source_entity = e1.id
      JOIN entities e2 ON r.target_entity = e2.id
      WHERE e1.name IN (${entityNames.map(() => '?').join(',')})
        AND e2.name IN (${entityNames.map(() => '?').join(',')})
    `).all(...entityNames, ...entityNames).map((row: any) => ({
      from: row.from_name,
      to: row.to_name,
      relationType: row.relationType
    }));
  }

  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    if (!this.db) throw new Error('Database not initialized');
    
    if (names.length === 0) {
      return { entities: [], relations: [] };
    }
    
    const entities = this.db.prepare(`
      SELECT name, entityType, observations FROM entities
      WHERE name IN (${names.map(() => '?').join(',')})
    `).all(...names).map((row: any) => ({
      name: row.name,
      entityType: row.entityType,
      observations: JSON.parse(row.observations)
    }));
    
    const relations = this.db.prepare(`
      SELECT 
        e1.name as from_name,
        e2.name as to_name,
        r.relationType
      FROM relationships r
      JOIN entities e1 ON r.source_entity = e1.id
      JOIN entities e2 ON r.target_entity = e2.id
      WHERE e1.name IN (${names.map(() => '?').join(',')}) 
        AND e2.name IN (${names.map(() => '?').join(',')})
    `).all(...names, ...names).map((row: any) => ({
      from: row.from_name,
      to: row.to_name,
      relationType: row.relationType
    }));

    return { entities, relations };
  }

  // === NEW RAG FUNCTIONALITY ===

  // Generate embedding text for an entity (identity + newest observations within a char budget).
  private generateEntityEmbeddingText(entity: { name: string; entityType: string; observations: string[] }): string {
    return this.buildEntityEmbeddingText(entity).text;
  }

  // Build entity embedding text plus stats for instrumentation.
  // The char budget keeps the entity vector representative of CURRENT state and stays under the
  // bge-m3 8192-token ceiling; older history lives in RAG document chunks / dated entities.
  // Returns selected/total observation counts and filtered (pre-cap) vs capped observation char
  // sizes so callers can log truncation accurately (identity prefix is excluded from these sizes).
  private buildEntityEmbeddingText(entity: { name: string; entityType: string; observations: string[] }): {
    text: string;
    filteredObsChars: number;
    cappedObsChars: number;
    selectedObsCount: number;
    totalObsCount: number;
  } {
    const maxObservationChars = Math.max(
      1000,
      Number.parseInt(process.env.ENTITY_EMBED_OBS_CHAR_BUDGET || '12000', 10) || 12000
    );

    const observations = entity.observations.filter(o =>
      !o.startsWith('Source:') && !o.startsWith('Created:') && !o.startsWith('Type:') &&
      !o.startsWith('Tags:') && !o.startsWith('Content length:')
    );
    const filteredObsChars = observations.join('. ').length;

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
    const text = `${entity.entityType}: ${entity.name}. ${observationsText}`.trim();
    return {
      text,
      filteredObsChars,
      cappedObsChars: observationsText.length,
      selectedObsCount: selected.length,
      totalObsCount: observations.length,
    };
  }

  // NEW: Generic semantic summary generation methods
  private splitIntoSentences(text: string): string[] {
    // Split on sentence boundaries while preserving structure
    return text
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 10) // Filter out very short fragments
      .map(s => s.replace(/^\s*[-•]\s*/, '')); // Clean up list markers
  }

  private async calculateSentenceSimilarities(sentences: string[], queryEmbedding: Float32Array): Promise<number[]> {
    const similarities: number[] = [];
    
    for (const sentence of sentences) {
      const sentenceEmbedding = await this.generateEmbedding(sentence);
      const similarity = this.cosineSimilarity(queryEmbedding, sentenceEmbedding);
      similarities.push(similarity);
    }
    
    return similarities;
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private enhanceSimilarityWithContext(similarities: number[], sentences: string[], entities: string[]): number[] {
    const enhanced = [...similarities];
    
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i].toLowerCase();
      let contextBoost = 0;
      
      // Generic boost for entity mentions (works across all domains)
      for (const entity of entities) {
        if (sentence.includes(entity.toLowerCase())) {
          contextBoost += 0.1; // Moderate boost for entity relevance
        }
      }
      
      // Generic boost for sentences with numbers (often contain key facts)
      if (/\b\d+/.test(sentence)) {
        contextBoost += 0.05;
      }
      
      // Generic boost for sentences with specific keywords that often indicate importance
      const importanceWords = ['important', 'key', 'main', 'primary', 'essential', 'critical', 'significant'];
      for (const word of importanceWords) {
        if (sentence.includes(word)) {
          contextBoost += 0.03;
          break; // Only boost once per sentence
        }
      }
      
      enhanced[i] += contextBoost;
    }
    
    return enhanced;
  }

  private async generateContentSummary(
    chunkText: string, 
    queryEmbedding: Float32Array, 
    entities: string[], 
    maxSentences = 2
  ): Promise<{ summary: string; keyHighlight: string; relevanceScore: number }> {
    
    const sentences = this.splitIntoSentences(chunkText);
    
    if (sentences.length === 0) {
      return {
        summary: chunkText.substring(0, 150) + (chunkText.length > 150 ? '...' : ''),
        keyHighlight: chunkText.substring(0, 100) + (chunkText.length > 100 ? '...' : ''),
        relevanceScore: 0.1
      };
    }
    
    // Calculate semantic similarities
    const similarities = await this.calculateSentenceSimilarities(sentences, queryEmbedding);
    
    // Apply generic context enhancement
    const enhancedSimilarities = this.enhanceSimilarityWithContext(similarities, sentences, entities);
    
    // Rank sentences by relevance
    const rankedIndices = Array.from({ length: sentences.length }, (_, i) => i)
      .sort((a, b) => enhancedSimilarities[b] - enhancedSimilarities[a]);
    
    // Select top sentences with diversity (avoid adjacent sentences)
    const selectedSentences: Array<{ text: string; score: number; index: number }> = [];
    const usedIndices = new Set<number>();
    
    for (const idx of rankedIndices) {
      if (selectedSentences.length >= maxSentences) break;
      
      // Prefer non-adjacent sentences for better coverage
      const hasAdjacent = Array.from(usedIndices).some(usedIdx => Math.abs(idx - usedIdx) <= 1);
      
      if (!hasAdjacent || selectedSentences.length === 0) {
        selectedSentences.push({
          text: sentences[idx],
          score: enhancedSimilarities[idx],
          index: idx
        });
        usedIndices.add(idx);
      }
    }
    
    // Fallback: if still empty, take the top sentence regardless of adjacency
    if (selectedSentences.length === 0) {
      selectedSentences.push({
        text: sentences[rankedIndices[0]],
        score: enhancedSimilarities[rankedIndices[0]],
        index: rankedIndices[0]
      });
    }
    
    // Create summary
    const keyHighlight = selectedSentences[0].text;
    
    let summary: string;
    if (selectedSentences.length === 1) {
      summary = selectedSentences[0].text;
    } else {
      // Sort by original order for coherent reading
      const orderedSentences = selectedSentences
        .sort((a, b) => a.index - b.index)
        .map(s => s.text);
      summary = orderedSentences.join(' [...] ');
    }
    
    const maxRelevanceScore = Math.max(...enhancedSimilarities);
    
    return {
      summary: summary,
      keyHighlight: keyHighlight,
      relevanceScore: maxRelevanceScore
    };
  }

  // Generate and store embedding for a single entity
  private async embedEntity(entityId: string, priority: EmbedPriority = 'bulk'): Promise<boolean> {
    if (!this.db) throw new Error('Database not initialized');
    
    // Get entity data
    const entity = this.db.prepare(`
      SELECT name, entityType, observations FROM entities WHERE id = ?
    `).get(entityId) as { name: string; entityType: string; observations: string } | undefined;
    
    if (!entity) {
      console.warn(`Entity ${entityId} not found for embedding`);
      return false;
    }
    
    const parsedObservations = JSON.parse(entity.observations);
    const built = this.buildEntityEmbeddingText({
      name: entity.name,
      entityType: entity.entityType,
      observations: parsedObservations
    });
    const embeddingText = built.text;

    // Instrumentation (stderr only): observations kept vs total, filtered pre-cap vs capped obs
    // char size (identity excluded), and embed duration. `capped` = some observation chars dropped.
    const capped = built.cappedObsChars < built.filteredObsChars;
    const embedStart = Date.now();
    const embedding = await this.generateEmbedding(embeddingText, 1024, false, priority);
    const embedMs = Date.now() - embedStart;
    console.error(
      `[embed] ${entity.name}: ${built.selectedObsCount}/${built.totalObsCount} obs, ${built.filteredObsChars}ch -> ${built.cappedObsChars}ch${capped ? ' (capped)' : ''}, ${embedMs}ms`
    );
    
    try {
      // v3.6 (§6a-2): vector replace + provenance stamp commit atomically.
      // Write-back CAS (beta 2R B1): the entity may have been mutated again
      // while THIS inference was in flight — a late writer must never
      // re-insert a vector for superseded content as 'verified'. Inside the
      // write transaction the CURRENT entity text is rebuilt and hashed; on
      // mismatch the result is discarded and the row stays missing/queued for
      // the backfill pass that the newer mutation already kicked.
      const inputHash = this.hashWithBuilderVersion(embeddingText);
      const writeTx = this.db.transaction((): boolean => {
        const currentHash = this.entityInputHash(entityId);
        if (currentHash !== inputHash) return false;           // superseded — discard
        const existingMetadata = this.db!.prepare(`
          SELECT rowid FROM entity_embedding_metadata WHERE entity_id = ?
        `).get(entityId) as { rowid: number } | undefined;
        if (existingMetadata) {
          this.db!.exec(`DELETE FROM entity_embeddings WHERE rowid = ${Number(existingMetadata.rowid)}`);
          this.db!.prepare(`DELETE FROM entity_embedding_metadata WHERE entity_id = ?`).run(entityId);
        }
        const result = this.db!.prepare(`
          INSERT INTO entity_embeddings (embedding) VALUES (?)
        `).run(Buffer.from(embedding.buffer));
        this.db!.prepare(`
          INSERT INTO entity_embedding_metadata (rowid, entity_id, embedding_text, input_hash, profile_id, provenance_state)
          VALUES (?, ?, ?, ?, ?, 'verified')
        `).run(result.lastInsertRowid, entityId, embeddingText, inputHash, this.currentProfileId);
        return true;
      });
      const written = writeTx();
      if (!written) {
        console.error(`⏭️ discarded superseded embedding for ${entityId} (entity changed during inference)`);
      }
      return written;
    } catch (error) {
      console.error(`Failed to embed entity ${entityId}:`, error);
      return false;
    }
  }

  // Embed all entities in the knowledge graph
  async embedAllEntities(): Promise<{ totalEntities: number; embeddedEntities: number }> {
    if (!this.db) throw new Error('Database not initialized');
    
    console.error('🔮 Generating embeddings for all entities...');
    
    const entities = this.db.prepare(`
      SELECT id FROM entities
    `).all() as Array<{ id: string }>;
    
    let embeddedCount = 0;

    const batchSize = 32;
    for (let i = 0; i < entities.length; i += batchSize) {
      const batch = entities.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(e => this.embedEntity(e.id)));
      embeddedCount += results.filter(Boolean).length;
    }
    
    console.error(`✅ Entity embeddings completed: ${embeddedCount}/${entities.length} entities embedded`);
    this.coordinator?.invalidateCoverage();

    return {
      totalEntities: entities.length,
      embeddedEntities: embeddedCount
    };
  }

  // NEW: Generate knowledge graph chunks for entities and relationships
  async generateKnowledgeGraphChunks(): Promise<{ entityChunks: number; relationshipChunks: number }> {
    if (!this.db) throw new Error('Database not initialized');
    
    console.error('🧠 Generating knowledge graph chunks...');
    
    // Clean up existing knowledge graph chunks
    await this.cleanupKnowledgeGraphChunks();
    
    let entityChunks = 0;
    let relationshipChunks = 0;
    
    // Generate entity chunks
    const entities = this.db.prepare(`
      SELECT id, name, entityType, observations FROM entities
    `).all() as Array<{ id: string; name: string; entityType: string; observations: string }>;
    
    for (const entity of entities) {
      const observations = JSON.parse(entity.observations);
      const chunkText = this.generateEntityChunkText(entity.name, entity.entityType, observations);
      const chunkId = `kg_entity_${entity.id}`;
      
      // Store chunk metadata
      this.db.prepare(`
        INSERT INTO chunk_metadata (
          chunk_id, chunk_type, entity_id, chunk_index, text, start_pos, end_pos, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(chunkId, 'entity', entity.id, 0, chunkText, 0, chunkText.length, JSON.stringify({
        entity_name: entity.name,
        entity_type: entity.entityType
      }));
      
      entityChunks++;
    }
    
    // Generate relationship chunks
    const relationships = this.db.prepare(`
      SELECT 
        r.id,
        r.relationType,
        e1.name as source_name,
        e2.name as target_name,
        r.confidence
      FROM relationships r
      JOIN entities e1 ON r.source_entity = e1.id
      JOIN entities e2 ON r.target_entity = e2.id
    `).all() as Array<{ 
      id: string; 
      relationType: string; 
      source_name: string; 
      target_name: string; 
      confidence: number;
    }>;
    
    for (const rel of relationships) {
      const chunkText = this.generateRelationshipChunkText(rel.source_name, rel.target_name, rel.relationType);
      const chunkId = `kg_relationship_${rel.id}`;
      
      // Store chunk metadata
      this.db.prepare(`
        INSERT INTO chunk_metadata (
          chunk_id, chunk_type, relationship_id, chunk_index, text, start_pos, end_pos, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(chunkId, 'relationship', rel.id, 0, chunkText, 0, chunkText.length, JSON.stringify({
        source_entity: rel.source_name,
        target_entity: rel.target_name,
        relation_type: rel.relationType,
        confidence: rel.confidence
      }));
      
      relationshipChunks++;
    }
    
    console.error(`✅ Knowledge graph chunks generated: ${entityChunks} entities, ${relationshipChunks} relationships`);
    
    return { entityChunks, relationshipChunks };
  }

  // NEW: Embed knowledge graph chunks
  async embedKnowledgeGraphChunks(): Promise<{ embeddedChunks: number; totalChunks: number; errors?: string[] }> {
    if (!this.db) throw new Error('Database not initialized');
    
    console.error('🔮 Embedding knowledge graph chunks...');
    
    // Get all knowledge graph chunks
    const chunks = this.db.prepare(`
      SELECT rowid, chunk_id, text 
      FROM chunk_metadata 
      WHERE chunk_type IN ('entity', 'relationship')
    `).all() as Array<{ rowid: number; chunk_id: string; text: string }>;
    
    let embeddedCount = 0;
    
    const errors: string[] = [];

    for (const chunk of chunks) {
      // Generate embedding
      const embedding = await this.generateEmbedding(chunk.text, 1024, false, 'bulk');
      const rowid = safeRowid(chunk.rowid);

      try {
        // vector + verified provenance in one transaction (§6a-2) — KG chunks
        // must never become vector-bearing provenance-NULL rows post-recon.
        const tx = this.db.transaction(() => {
          this.db!.exec(`DELETE FROM chunks WHERE rowid = ${rowid}`);
          this.db!.prepare(`
            INSERT INTO chunks (rowid, embedding) VALUES (${rowid}, ?)
          `).run(Buffer.from(embedding.buffer));
          this.db!.prepare(`UPDATE chunk_metadata SET input_hash = ?, profile_id = ?, provenance_state = 'verified' WHERE rowid = ?`)
            .run(createHash('sha256').update(chunk.text).digest('hex'), this.currentProfileId, chunk.rowid);
        });
        tx();
        embeddedCount++;
      } catch (error) {
        const errMsg = `chunk ${chunk.chunk_id} (rowid=${rowid}, type=${typeof chunk.rowid}): ${error instanceof Error ? error.message : String(error)}`;
        console.error(`Failed to embed ${errMsg}`);
        errors.push(errMsg);
      }
    }
    this.coordinator?.invalidateCoverage();

    console.error(`✅ Knowledge graph chunks embedded: ${embeddedCount}/${chunks.length}`);

    return { embeddedChunks: embeddedCount, totalChunks: chunks.length, ...(errors.length > 0 && { errors: errors.slice(0, 5) }) };
  }

  // NEW: Generate textual representation for entity chunks
  private generateEntityChunkText(name: string, entityType: string, observations: string[]): string {
    const observationsText = observations.length > 0 ? observations.join('. ') : 'No additional information available.';
    return `${name} is a ${entityType}. ${observationsText}`;
  }

  // NEW: Generate textual representation for relationship chunks  
  private generateRelationshipChunkText(sourceName: string, targetName: string, relationType: string): string {
    // Convert relation type to more natural language
    const relationText = relationType.toLowerCase().replace(/_/g, ' ');
    return `${sourceName} ${relationText} ${targetName}`;
  }

  // NEW: Clean up existing knowledge graph chunks
  private async cleanupKnowledgeGraphChunks(): Promise<void> {
    if (!this.db) return;
    
    console.error('🧹 Cleaning up existing knowledge graph chunks...');
    
    // Get existing knowledge graph chunks
    const existingChunks = this.db.prepare(`
      SELECT rowid FROM chunk_metadata WHERE chunk_type IN ('entity', 'relationship')
    `).all() as { rowid: number }[];
    
    let deletedVectors = 0;
    let deletedAssociations = 0;
    
    // Delete vectors and associations
    for (const chunk of existingChunks) {
      // Delete vector embeddings (vec0 needs literal integer, not parameterized)
      this.db.exec(`DELETE FROM chunks WHERE rowid = ${safeRowid(chunk.rowid)}`);
      deletedVectors++;

      // Delete chunk-entity associations
      const associations = this.db.prepare(`
        DELETE FROM chunk_entities WHERE chunk_rowid = ?
      `).run(chunk.rowid);
      deletedAssociations += associations.changes;
    }

    // Delete chunk metadata
    const metadata = this.db.prepare(`
      DELETE FROM chunk_metadata WHERE chunk_type IN ('entity', 'relationship')
    `).run();
    
    if (existingChunks.length > 0) {
      console.error(`  ├─ Deleted ${deletedVectors} vector embeddings`);
      console.error(`  ├─ Deleted ${deletedAssociations} entity associations`);
      console.error(`  └─ Deleted ${metadata.changes} chunk metadata records`);
    }
  }

  private loadDictionary(): { nativeToEn: Record<string, string>; enToNative: Record<string, string> } {
    if (this.dictionaryCache) return this.dictionaryCache;

    const empty = { nativeToEn: {}, enToNative: {} };

    try {
      const dictPath = path.join(path.dirname(DB_FILE_PATH), 'dictionary.json');
      const raw = fsSync.readFileSync(dictPath, 'utf-8');
      const parsed = JSON.parse(raw);

      this.dictionaryCache = {
        nativeToEn: parsed['native-en'] && typeof parsed['native-en'] === 'object' ? parsed['native-en'] : {},
        enToNative: parsed['en-native'] && typeof parsed['en-native'] === 'object' ? parsed['en-native'] : {},
      };

      console.error(`📖 Dictionary loaded: ${Object.keys(this.dictionaryCache.nativeToEn).length} native→en, ${Object.keys(this.dictionaryCache.enToNative).length} en→native`);
      return this.dictionaryCache;
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error(`⚠️ Dictionary load warning: ${err.message}`);
      }
      this.dictionaryCache = empty;
      return empty;
    }
  }

  private hasKorean(text: string): boolean {
    return /[\uac00-\ud7af]/.test(text);
  }

  private isLikelyEnglish(text: string): boolean {
    return /[A-Za-z]/.test(text) && !/[^\x00-\x7F]/.test(text);
  }

  private normalizeQueryText(text: string, keepAsciiOnly = false): string {
    const normalized = keepAsciiOnly
      ? text.replace(/[^\x00-\x7F]+/g, ' ')
      : text;
    return normalized.replace(/\s+/g, ' ').trim();
  }

  private buildCrossLingualDictionary(): { nativeToEn: Record<string, string>; enToNative: Record<string, string> } {
    const { nativeToEn, enToNative } = this.loadDictionary();
    const forward: Record<string, string> = { ...nativeToEn };
    const reverse: Record<string, string> = { ...enToNative };

    if (!this.db) {
      return { nativeToEn: forward, enToNative: reverse };
    }

    try {
      const entities = this.db.prepare(`
        SELECT name, observations FROM entities
      `).all() as Array<{ name: string; observations: string }>;

      for (const entity of entities) {
        try {
          const obs = JSON.parse(entity.observations) as string[];
          for (const o of obs) {
            const match = o.match(/한국어명:\s*(.+)/);
            if (!match) continue;
            const koreanName = match[1].trim();
            if (!koreanName) continue;
            forward[koreanName] = entity.name;
            if (!reverse[entity.name]) {
              reverse[entity.name] = koreanName;
            }
          }
        } catch {}
      }
    } catch {}

    return { nativeToEn: forward, enToNative: reverse };
  }

  private translateQueryWithMap(
    query: string,
    dictionary: Record<string, string>,
    options: { keepAsciiOnly?: boolean } = {}
  ): string | null {
    let translated = query;
    let changed = false;

    const sortedTerms = Object.entries(dictionary).sort((a, b) => b[0].length - a[0].length);
    for (const [source, target] of sortedTerms) {
      const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const next = translated.replace(new RegExp(escaped, 'g'), target);
      if (next !== translated) {
        changed = true;
        translated = next;
      }
    }

    translated = this.normalizeQueryText(translated, options.keepAsciiOnly ?? false);
    if (!changed || translated.length <= 2 || translated === query) {
      return null;
    }

    return translated;
  }

  // Cross-lingual query expansion using entity DB + domain dictionary
  private buildCrossLingualVariants(query: string): string[] {
    const variants = [this.normalizeQueryText(query)];
    const { nativeToEn, enToNative } = this.buildCrossLingualDictionary();

    if (this.hasKorean(query)) {
      const koToEn = this.translateQueryWithMap(query, nativeToEn, { keepAsciiOnly: true });
      if (koToEn) variants.push(koToEn);
      return Array.from(new Set(variants));
    }

    if (this.isLikelyEnglish(query)) {
      const enToKo = this.translateQueryWithMap(query, enToNative);
      if (enToKo) variants.push(enToKo);
      return Array.from(new Set(variants));
    }

    // Conservative fallback for other non-English queries: try native->English only.
    const nativeToEnglish = this.translateQueryWithMap(query, nativeToEn, { keepAsciiOnly: true });
    if (nativeToEnglish) variants.push(nativeToEnglish);

    return Array.from(new Set(variants));
  }

  private extractTermsFromText(text: string, options: {
    minLength?: number;
    includeCapitalized?: boolean;
    customPatterns?: string[];
  } = {}): string[] {
    const { minLength = 3, includeCapitalized = true, customPatterns = [] } = options;
    const terms = new Set<string>();
    
    // Include capitalized words and acronyms if requested
    if (includeCapitalized) {
      // Capitalized words (e.g., "Singapore", "Visit Proposal")
      const capitalizedWords = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
      capitalizedWords.forEach(term => {
        if (term.length >= minLength) terms.add(term.trim());
      });
      // All-caps acronyms (e.g., "MUIS", "KMF", "EIAC")
      const acronyms = text.match(/\b[A-Z]{2,}\b/g) || [];
      acronyms.forEach(term => terms.add(term.trim()));
    }

    // Extract Korean terms (consecutive Korean characters, 2+ chars)
    const koreanTerms = text.match(/[\uAC00-\uD7A3]{2,}/g) || [];
    koreanTerms.forEach(term => {
      if (term.length >= 2) terms.add(term.trim());
    });
    
    // Apply custom patterns if provided
    customPatterns.forEach(patternStr => {
      try {
        const pattern = new RegExp(patternStr, 'gi');
        const matches = text.match(pattern) || [];
        matches.forEach(match => {
          if (match.length >= minLength) {
            terms.add(match.trim());
          }
        });
      } catch (error) {
        console.error('Invalid regex pattern:', patternStr, error);
      }
    });
    
    return Array.from(terms);
  }

  // Tokenize and chunk text
  // BPE tokenizers (cl100k_base) split multi-byte UTF-8 sequences across tokens.
  // Slicing token arrays at arbitrary boundaries can leave incomplete UTF-8
  // prefix/suffix bytes, which TextDecoder replaces with U+FFFD (�). Trim the
  // incomplete sequences at chunk boundaries; overlap covers the removed bytes.
  //
  // Each chunk records both token-space offsets (start_token/end_token from the
  // BPE encoder loop) and char-space offsets (start_pos/end_pos into the original
  // text). Char offsets are Unicode codepoint counts — language-neutral, so SQL
  // substr, Python str slicing, and JS [...str] iteration all line up. JS's
  // native UTF-16 indexing differs for supplementary characters (emoji, rare
  // CJK), so the function maintains parallel UTF-16 and codepoint cursors and
  // reports codepoint offsets. On a coincidental indexOf miss the char offsets
  // are NULL.
  private chunkStructured(text: string, maxTokens = DEFAULT_MAX_TOKENS): Chunk[] {
    if (!this.encoding) throw new Error('Tokenizer not initialized');
    return chunkStructuredText(text, this.encoding, maxTokens).map((seg, idx) => ({
      id: '',
      document_id: '',
      chunk_index: idx,
      text: seg.text,
      start_pos: seg.start_pos,
      end_pos: seg.end_pos,
      // c1 has no token-space offsets (spec §4.3, r4 D4). Legacy rows keep theirs.
      start_token: null,
      end_token: null
    }));
  }

  // spec §7.1 (r4·r5-8): overlap is rejected on BOTH public paths, BEFORE any
  // content/dedup judgment — silently accepting it on unchanged content would
  // void the contract. maxTokens must be a positive integer.
  private validateChunkParams(params?: { maxTokens?: number; overlap?: number }): { maxTokens: number } {
    const { maxTokens = DEFAULT_MAX_TOKENS, overlap = 0 } = params || {};
    if (!Number.isInteger(maxTokens) || maxTokens <= 0)
      throw new Error(`chunkParams.maxTokens must be a positive integer (got ${maxTokens})`);
    if (overlap !== 0)
      throw new Error(`chunkParams.overlap is no longer supported (chunker c1 has no overlap); omit it or pass 0 (got ${overlap})`);
    return { maxTokens };
  }

  // Generate embeddings using sentence transformers
  // isQuery: true for search queries (adds instruction prefix), false for documents/entities
  private async generateEmbedding(text: string, dimensions = 1024, isQuery = false,
      priority: EmbedPriority = 'interactive'): Promise<Float32Array> {
    // Check cache first (hash-based key to avoid collisions on long texts)
    const cacheKey = createHash('md5').update(`${text}_${dimensions}_${isQuery}`).digest('hex');
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) return cached;

    // v3.6: all inference goes through the gate — state check + execution in one
    // atomic boundary (TOCTOU-safe). GateNotReadyError / GateDisabledError
    // propagate so each consumer honors its own not-ready contract (spec §5).
    const modelResult = await this.gate.embed(text, { dims: dimensions, isQuery, priority });
    if (this.embeddingCache.size >= this.EMBEDDING_CACHE_MAX) {
      const firstKey = this.embeddingCache.keys().next().value;
      if (firstKey) this.embeddingCache.delete(firstKey);
    }
    this.embeddingCache.set(cacheKey, modelResult);
    return modelResult;
  }

  // === NEW SEPARATE TOOLS ===

  async syncDocumentFromFile(
    filePath: string,
    documentId: string,
    options: {
      metadata?: Record<string, any>;
      content?: string;
      excludePattern?: string | string[];
      entityNames?: string[];
      chunkParams?: { maxTokens?: number; overlap?: number };
    } = {}
  ): Promise<{
    documentId: string; bytes: number; chunks: number; embeddedChunks: number; linkedEntities: number;
    explicitlyLinked?: number; warning?: string; skipped?: boolean; reason?: string; embedding_status?: string;
    reusedChunks: number; newlyEmbeddedChunks: number; queuedChunks: number; deletedChunks: number; chunkerTransitioned: boolean;
  }> {
    if (!this.db) throw new Error('Database not initialized');
    // spec §7.1 + r5-8: 검증은 content 해석·dedup 판정보다 앞 (첫 실행문).
    const { maxTokens } = this.validateChunkParams(options.chunkParams);
    const signature = effectiveSignature(maxTokens);
    const shaHex = (t: string) => createHash('sha256').update(t).digest('hex');
    const zero = { reusedChunks: 0, newlyEmbeddedChunks: 0, queuedChunks: 0, deletedChunks: 0, chunkerTransitioned: false };

    for (let attempt = 1; attempt <= 3; attempt++) {
      // r6-3: CAS 재시작 = 처음부터 — 파일 읽기·hash·metadata 도 attempt 안에서 재계산한다.
      // Strip excluded regions before anything else looks at the text. Everything downstream —
      // content_hash, bytes, chunking — then describes what was actually indexed, so changing the
      // pattern alone still invalidates the dedup gate below. Hashing the raw file instead would
      // report `unchanged` for a different exclusion, which is the silent-wrong case.
      const content = applyExcludePatterns(
        options.content !== undefined ? options.content : fsSync.readFileSync(filePath, 'utf-8'),
        options.excludePattern,
      );
      const bytes = Buffer.byteLength(content, 'utf-8');
      // Same calendar as the observation prefix. Deciding this explicitly rather than leaving it
      // on UTC: both are date-only labels a person reads, and "observations in Seoul days but
      // documents in UTC days" is not a distinction anyone could explain later.
      const today = calendarDate(new Date(), this.calendarTimeZone);
      const contentHash = shaHex(content);
      // spec §5.1: content_hash 는 system-owned — user metadata 뒤에 쓴다 (r1: spread 가 덮어쓸 수 있었다).
      const metadata = { source: filePath, updated: today, ...(options.metadata || {}), content_hash: contentHash };

      const snap = this.db.prepare(`SELECT content, metadata, chunking_signature FROM documents WHERE id = ?`)
        .get(documentId) as { content: string; metadata: string; chunking_signature: string } | undefined;
      let existingHash: string | undefined;
      if (snap) { try { existingHash = JSON.parse(snap.metadata)?.content_hash; } catch { /* hash 없으면 full 경로 */ } }

      // dedup gate — spec §5.1 그대로: "content_hash 동일" 만 (r6-8: content=== 확장 금지.
      // hash 가 없거나 낡은 문서는 full 경로로 가서 hash 가 복구된다). signature 무관.
      if (snap && existingHash === contentHash) {
        const cmCount = (this.db.prepare(`SELECT count(*) AS n FROM chunk_metadata WHERE document_id = ?`).get(documentId) as { n: number }).n;
        const embCount = (this.db.prepare(`
          SELECT count(*) AS n FROM chunks c JOIN chunk_metadata m ON c.rowid = m.rowid
          WHERE m.document_id = ? AND (m.provenance_state IS NULL OR m.profile_id = ?)
        `).get(documentId, this.currentProfileId) as { n: number }).n;
        const linked = (this.db.prepare(`
          SELECT count(DISTINCT ce.entity_id) AS n FROM chunk_entities ce
          JOIN chunk_metadata m ON ce.chunk_rowid = m.rowid WHERE m.document_id = ?
        `).get(documentId) as { n: number }).n;
        if (cmCount > 0 && cmCount === embCount) {
          console.error(`⏭️  syncDocumentFromFile: ${documentId} unchanged (hash match, ${cmCount} chunks embedded) — skipped`);
          return { documentId, bytes, chunks: cmCount, embeddedChunks: embCount, linkedEntities: linked,
                   skipped: true, reason: 'unchanged', ...zero };
        }
        if (cmCount > 0 && embCount < cmCount) {
          // v3.6 (spec §5b M12): identical content with incomplete/stale vectors keeps the
          // document, chunks, rowids and entity links — only missing vectors are re-queued.
          console.error(`♻️ syncDocumentFromFile: ${documentId} unchanged but ${cmCount - embCount} vectors missing — re-queued (chunks preserved)`);
          this.coordinator?.kick();
          return { documentId, bytes, chunks: cmCount, embeddedChunks: embCount, linkedEntities: linked,
                   skipped: true, reason: 'unchanged-revectorizing',
                   embedding_status: this.gate.isDisabled ? 'disabled' : 'queued',
                   ...zero, queuedChunks: cmCount - embCount };
        }
        // cmCount === 0 이면 아래 full 경로로 계속 (최초 생성).
      }

      console.error(`🔄 syncDocumentFromFile: ${documentId} <- ${filePath} (${bytes} bytes)`);
      const segments = this.chunkStructured(content, maxTokens);

      // spec §5.2-2: 옛 행을 트랜잭션 밖에서 읽는다 (벡터 재사용 후보).
      const oldRows = this.db.prepare(`
        SELECT m.rowid, m.text, m.input_hash, m.profile_id, m.provenance_state, c.embedding
        FROM chunk_metadata m LEFT JOIN chunks c ON c.rowid = m.rowid
        WHERE m.document_id = ?`).all(documentId) as ReuseCandidate[];
      const oldRowids = oldRows.map(r => r.rowid);
      const byHash = new Map<string, ReuseCandidate[]>();
      for (const r of oldRows) {
        if (!r.input_hash) continue;
        const arr = byHash.get(r.input_hash);
        if (arr) arr.push(r); else byHash.set(r.input_hash, [r]);
      }

      // 임베딩/재사용 — 트랜잭션 밖, ready 경로 한정 (N2: not-ready 계약 불변).
      const lazySync = !this.gate.isReady;
      type Slot = { seg: Chunk; vec: Buffer | null; provenance: 'verified' | 'legacy_assumed' | null };
      const slots: Slot[] = [];
      let reusedChunks = 0, newlyEmbeddedChunks = 0;
      if (lazySync) {
        for (const seg of segments) slots.push({ seg, vec: null, provenance: null });
      } else {
        for (const seg of segments) {
          const hit = selectReusableVector(byHash.get(shaHex(seg.text)) ?? [], seg.text, this.currentProfileId, shaHex);
          if (hit) { slots.push({ seg, vec: hit.vec, provenance: hit.provenance }); reusedChunks++; }
          else {
            const embedding = await this.generateEmbedding(seg.text, 1024, false, 'bulk');
            slots.push({ seg, vec: Buffer.from(embedding.buffer), provenance: 'verified' });
            newlyEmbeddedChunks++;
          }
        }
      }

      __syncFaultHook?.('pre-transaction');

      // 한 트랜잭션: CAS 첫 문장 -> full delete/insert -> failure 정리 (spec §5.2-4·5).
      const applyTx = this.db.transaction(() => {
        const db = this.db!;
        const now = db.prepare(`SELECT content, metadata, chunking_signature FROM documents WHERE id = ?`)
          .get(documentId) as { content: string; metadata: string; chunking_signature: string } | undefined;
        const same = (snap === undefined && now === undefined) ||
          (snap !== undefined && now !== undefined && now.content === snap.content &&
           now.metadata === snap.metadata && now.chunking_signature === snap.chunking_signature);
        if (!same) throw new SyncCasConflictError(documentId);

        const existing = db.prepare(`SELECT rowid FROM chunk_metadata WHERE document_id = ?`).all(documentId) as { rowid: number }[];
        for (const ch of existing) {
          db.prepare(`DELETE FROM chunk_entities WHERE chunk_rowid = ?`).run(ch.rowid);
          db.exec(`DELETE FROM chunks WHERE rowid = ${safeRowid(ch.rowid)}`);
        }
        db.prepare(`DELETE FROM chunk_metadata WHERE document_id = ?`).run(documentId);
        db.prepare(`DELETE FROM documents WHERE id = ?`).run(documentId);
        db.prepare(`INSERT INTO documents (id, content, metadata, chunking_signature) VALUES (?, ?, ?, ?)`)
          .run(documentId, content, JSON.stringify(metadata), signature);
        for (const { seg, vec, provenance } of slots) {
          const chunkId = `${documentId}_chunk_${seg.chunk_index}`;
          const info = db.prepare(`
            INSERT INTO chunk_metadata (chunk_id, document_id, chunk_index, text, start_pos, end_pos, start_token, end_token)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(chunkId, documentId, seg.chunk_index, seg.text, seg.start_pos, seg.end_pos, seg.start_token, seg.end_token);
          const rowid = Number(info.lastInsertRowid);
          if (vec) {
            db.prepare(`INSERT INTO chunks (rowid, embedding) VALUES (${rowid}, ?)`).run(vec);
            db.prepare(`UPDATE chunk_metadata SET input_hash = ?, profile_id = ?, provenance_state = ? WHERE rowid = ?`)
              .run(shaHex(seg.text), this.currentProfileId, provenance, rowid);
          }
        }
        if (oldRowids.length > 0) {
          // r5-9: 키는 (kind, target_id) — kind 조건 없이 지우면 같은 숫자 ID 의 entity failure 까지 지운다.
          const ph = oldRowids.map(() => '?').join(',');
          db.prepare(`DELETE FROM embedding_backfill_failures WHERE kind = 'chunk' AND target_id IN (${ph})`)
            .run(...oldRowids.map(String));
        }
      });

      try { applyTx(); } catch (e) {
        if (e instanceof SyncCasConflictError) {
          console.error(`↻ sync CAS conflict on ${documentId} (attempt ${attempt}/3) — restarting from file read`);
          if (attempt === 3) throw e;
          continue;
        }
        throw e;
      }
      this.coordinator?.invalidateCoverage();
      if (lazySync) this.coordinator?.kick();

      // Entity linking AFTER commit. Non-destructive + idempotent (INSERT OR IGNORE).
      const linkedEntities = await this.autoLinkEntities(documentId);
      let explicitlyLinked: number | undefined;
      if (options.entityNames && options.entityNames.length > 0) {
        const linkResult = await this.linkEntitiesToDocument(documentId, options.entityNames);
        explicitlyLinked = linkResult.linkedEntities;
      }
      const result: any = {
        documentId, bytes, chunks: segments.length,
        embeddedChunks: reusedChunks + newlyEmbeddedChunks,               // spec §5.3
        linkedEntities,
        embedding_status: lazySync ? (this.gate.isDisabled ? 'disabled' : 'queued') : 'embedded',
        reusedChunks, newlyEmbeddedChunks,
        queuedChunks: lazySync ? segments.length : 0,
        deletedChunks: oldRowids.length,
        chunkerTransitioned: snap !== undefined && snap.chunking_signature !== signature,
        ...(explicitlyLinked !== undefined ? { explicitlyLinked } : {}),
      };
      if (linkedEntities === 0 && explicitlyLinked === undefined) {
        result.warning = 'linkedEntities=0: ensure the file content contains entity-name literals (e.g. a wiki anchor line "RAG entity: ...") so term-matching can link entities.';
      }
      console.error(`✅ syncDocumentFromFile done: ${documentId} (${result.chunks} chunks, reused ${reusedChunks}, embedded ${newlyEmbeddedChunks})`);
      return result;
    }
    throw new Error('unreachable');
  }

  async storeDocument(id: string, content: string, metadata: Record<string, any> = {}): Promise<{ id: string; stored: boolean; replaced: boolean; deletedChunks: number }> {
    if (!this.db) throw new Error('Database not initialized');

    console.error(`📄 Storing document: ${id}`);

    // Decide `replaced` from the document row, not from the chunk count: a document stored but
    // never chunked still gets overwritten here, and reporting that as a fresh write would be a lie.
    const existed = this.db.prepare(`SELECT 1 FROM documents WHERE id = ?`).get(id) !== undefined;

    // Clean up existing document
    const cleaned = await this.cleanupDocument(id);

    // Store document
    this.db.prepare(`
      INSERT OR REPLACE INTO documents (id, content, metadata)
      VALUES (?, ?, ?)
    `).run(id, content, JSON.stringify(metadata));
    
    console.error(`✅ Document stored: ${id}`);
    return { id, stored: true, replaced: existed, deletedChunks: cleaned.deletedChunks };
  }

  async chunkDocument(documentId: string, options: { maxTokens?: number; overlap?: number } = {}): Promise<{ documentId: string; chunks: Array<{ id: string; text: string; startPos: number | null; endPos: number | null; startToken: number | null; endToken: number | null }> }> {
    if (!this.db) throw new Error('Database not initialized');
    
    // Get document
    const document = this.db.prepare(`
      SELECT content FROM documents WHERE id = ?
    `).get(documentId) as { content: string } | undefined;
    
    if (!document) {
      throw new Error(`Document with ID ${documentId} not found`);
    }
    
    const { maxTokens } = this.validateChunkParams(options);

    console.error(`🔪 Chunking document: ${documentId} (maxTokens: ${maxTokens}, chunker: c1)`);
    
    // Clean up existing chunks
    await this.cleanupDocument(documentId);
    
    // Create chunks
    const chunks = this.chunkStructured(document.content, maxTokens);
    const resultChunks = [];
    
    for (const chunk of chunks) {
      const chunkId = `${documentId}_chunk_${chunk.chunk_index}`;

      // Store chunk metadata (no embedding yet)
      this.db.prepare(`
        INSERT INTO chunk_metadata (
          chunk_id, document_id, chunk_index, text, start_pos, end_pos, start_token, end_token
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        chunkId,
        documentId,
        chunk.chunk_index,
        chunk.text,
        chunk.start_pos,
        chunk.end_pos,
        chunk.start_token,
        chunk.end_token
      );

      resultChunks.push({
        id: chunkId,
        text: chunk.text,
        startPos: chunk.start_pos,
        endPos: chunk.end_pos,
        startToken: chunk.start_token,
        endToken: chunk.end_token
      });
    }
    
    console.error(`✅ Document chunked: ${chunks.length} chunks created`);
    // spec §7.1: 두 번째 chunk 생성 경로 — 스탬프를 안 박으면 §5.1 관측이 조용히 샌다.
    this.db.prepare(`UPDATE documents SET chunking_signature = ? WHERE id = ?`)
      .run(effectiveSignature(maxTokens), documentId);
    // Indirect missing-row producer (spec §5): freshly chunked rows have no
    // vectors yet — let the coordinator recover them without a restart.
    this.coordinator?.invalidateCoverage();
    this.coordinator?.kick();
    return { documentId, chunks: resultChunks };
  }

  async embedChunks(documentId: string): Promise<{ documentId: string; embeddedChunks: number; totalChunks: number; linkedEntities?: number; errors?: string[] }> {
    if (!this.db) throw new Error('Database not initialized');
    
    console.error(`🔮 Embedding chunks for document: ${documentId}`);
    
    // Get all chunks for the document
    const chunks = this.db.prepare(`
      SELECT rowid, chunk_id, text FROM chunk_metadata WHERE document_id = ?
    `).all(documentId) as Array<{ rowid: number; chunk_id: string; text: string }>;
    
    if (chunks.length === 0) {
      throw new Error(`No chunks found for document ${documentId}. Run chunkDocument first.`);
    }
    
    let embeddedCount = 0;
    
    const errors: string[] = [];

    for (const chunk of chunks) {
      // Generate embedding (foreground-bulk priority)
      const embedding = await this.generateEmbedding(chunk.text, 1024, false, 'bulk');
      const rowid = Number(chunk.rowid);

      // Store in vector table (+ verified provenance, §6a-2 atomic)
      try {
        const tx = this.db.transaction(() => {
          this.db!.exec(`DELETE FROM chunks WHERE rowid = ${safeRowid(rowid)}`);
          this.db!.prepare(`
            INSERT INTO chunks (rowid, embedding) VALUES (${rowid}, ?)
          `).run(Buffer.from(embedding.buffer));
          this.db!.prepare(`UPDATE chunk_metadata SET input_hash = ?, profile_id = ?, provenance_state = 'verified' WHERE rowid = ?`)
            .run(createHash('sha256').update(chunk.text).digest('hex'), this.currentProfileId, rowid);
        });
        tx();
        embeddedCount++;
      } catch (error) {
        const errMsg = `chunk ${chunk.chunk_id} (rowid=${rowid}, type=${typeof chunk.rowid}): ${error instanceof Error ? error.message : String(error)}`;
        console.error(`Failed to embed ${errMsg}`);
        errors.push(errMsg);
      }
    }

    console.error(`✅ Chunks embedded: ${embeddedCount}/${chunks.length}`);
    this.coordinator?.invalidateCoverage();

    // Auto-link entities to document after embedding
    const linkedCount = await this.autoLinkEntities(documentId);

    return { documentId, embeddedChunks: embeddedCount, totalChunks: chunks.length, linkedEntities: linkedCount, ...(errors.length > 0 && { errors: errors.slice(0, 5) }) };
  }

  // Check if a string contains CJK (Chinese/Japanese/Korean) characters
  private hasCJK(text: string): boolean {
    return /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(text);
  }

  // `\b` asserts a transition between a word char and a non-word char. When the name itself
  // *ends* (or starts) with a non-word char — and ours routinely do, e.g. "… Review (2026-05-27)"
  // — there is no transition to assert, so `\bname\b` can never match however the text reads.
  // Measured 2026-08-23 on a live 2,913-chunk corpus: 23 standalone occurrences across 13 names
  // were invisible to the regex. This is not a widening: we still require both neighbours to be
  // non-word, so "Data" continues not to match inside "Database". It is what `\b` was reaching
  // for, stated in a way that survives a name whose own edges are punctuation.
  private static readonly WORD_CH = /[A-Za-z0-9_]/;

  /**
   * Index of an occurrence of `name` in `text` with non-word neighbours, or -1.
   *
   * Runs on the ORIGINAL text, not a lowercased copy. Lowercasing can change length —
   * 'İ' folds to two units — so an index taken from the folded string does not address the
   * same character in the original, and buildEntityRangeFinder hands these indices straight
   * to the codepoint table. (r9-1 made the same call for the regex path; a first cut of this
   * helper folded first and the İ coordinate test caught it.)
   */
  private standaloneIndex(text: string, name: string, from = 0): number {
    let re: RegExp;
    try {
      re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    } catch { return -1; }
    re.lastIndex = from;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const before = m.index === 0 ? '' : text[m.index - 1];
      const after = text[m.index + m[0].length] ?? '';
      if (!RAGKnowledgeGraphManager.WORD_CH.test(before)
          && !RAGKnowledgeGraphManager.WORD_CH.test(after)) return m.index;
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    return -1;
  }

  // The alias regex in autoLinkEntities matches anything shaped like "stem.ext", which
  // includes version strings ("v3.3", "gpt-5.6"), measurements ("1.7mb", "0.465") and
  // domains/module paths ("github.com", "os.path"). Those are not filenames and linking
  // on them is pure noise. Whitelist the extensions we actually ship and store.
  private static readonly ALIAS_FILE_EXT = new Set([
    'md', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json',
    'sh', 'bash', 'zsh', 'toml', 'yaml', 'yml', 'ini', 'cfg', 'conf',
    'txt', 'log', 'csv', 'tsv', 'sql', 'db', 'zip', 'gz', 'tar',
    'css', 'scss', 'html', 'htm', 'svg', 'png', 'jpg', 'jpeg', 'gif',
    'pdf', 'docx', 'pptx', 'xlsx', 'hwp', 'hwpx', 'lock', 'bak',
  ]);
  // Deliberately absent: any 5+ character extension (jsonl, ipynb, scss is 4 so it stays).
  // The extractor regex is `\w{1,4}`, so a longer extension never reaches this set — listing
  // one would be a dead entry that reads as support. Extend the regex first if that changes.

  private looksLikeFilename(token: string): boolean {
    const i = token.lastIndexOf('.');
    if (i < 1) return false;
    const stem = token.slice(0, i);
    const ext = token.slice(i + 1);
    if (stem.length < 3) return false;          // "d.ts" is a fragment, not a file
    if (/^\d+$/.test(stem)) return false;       // "2026.md" style numeric stems
    return RAGKnowledgeGraphManager.ALIAS_FILE_EXT.has(ext);
  }

  // spec §5.4 (r7-2·r8-1·r9): primary name 의 본문 occurrence range [sCp, eCp).
  // 의미 = buildEntityMatcher 와 동일 (CJK substring / Latin word-boundary) — 여기서
  // 어긋나면 'Data' 가 'Database' 에 새로 링크되는 식으로 의미가 확장된다.
  private buildEntityRangeFinder(content: string): (name: string, isCjk: boolean) => Array<{ s: number; e: number }> {
    // 원문 UTF-16 -> codepoint 표. Latin 경로는 folded 가 아니라 **원문**에 regex 를 건다
    // (r9-1: folded 에 걸면 fooİ -> fooi̇ 로 접힌 뒤 매치돼 현행 matcher 의미가 확장된다).
    const origU16ToCp: number[] = [];
    let origTotalCp = 0;
    for (let u = 0; u < content.length; ) {
      const c = content.codePointAt(u)!;
      origU16ToCp.push(origTotalCp);
      if (c > 0xffff) { origU16ToCp.push(origTotalCp); u += 2; } else u += 1;
      origTotalCp++;
    }
    const origCpAt = (u16: number) => (u16 < origU16ToCp.length ? origU16ToCp[u16] : origTotalCp);

    // folded 표 (CJK substring / fallback 경로 전용). unit -> 유래한 원문 cp.
    let folded = '';
    const u16ToCp: number[] = [];
    let cp = 0;
    for (const ch of content) {                       // for..of = codepoint 순회
      const f = ch.toLowerCase();                     // 다단위 fold 가능 (İ -> 'i̇')
      for (let i = 0; i < f.length; i++) u16ToCp.push(cp);
      folded += f;
      cp++;
    }
    // r9-1: exclusive end = "마지막으로 소비한 unit 의 원문 cp + 1".
    // 경계 unit 을 읽으면 매치가 fold 전개 중간에서 끝날 때 1 모자란다 (漢İ/漢i 실측 [0,1)).
    const endCp = (u16: number) => (u16 === 0 ? 0 : u16ToCp[Math.min(u16, u16ToCp.length) - 1] + 1);

    return (name: string, isCjk: boolean) => {
      const out: Array<{ s: number; e: number }> = [];
      const lower = name.toLowerCase();
      const pushAllSubstr = () => {
        let from = 0;
        while (true) {
          const u = folded.indexOf(lower, from);
          if (u < 0) break;
          out.push({ s: u16ToCp[u], e: endCp(u + lower.length) });
          from = u + 1;                               // r9-2: 중첩 occurrence 보존
        }
      };
      if (isCjk) { pushAllSubstr(); return out; }
      try {
        const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\b${escaped}\\b`, 'gi');    // buildEntityMatcher 와 동일 규칙,
        let m: RegExpExecArray | null;                          // 단 원문에 실행 (의미 확장 방지)
        while ((m = re.exec(content)) !== null) {
          out.push({ s: origCpAt(m.index), e: origCpAt(m.index + m[0].length) });
          if (re.lastIndex === m.index) re.lastIndex++;
        }
        // Same correction as buildEntityMatcher — the two must agree or a name links at chunk
        // level but not at range level. Union, deduped: a hit found by both must not be pushed
        // twice or a chunk gets counted once per path.
        const seen = new Set(out.map(r => `${r.s}:${r.e}`));
        for (let at = this.standaloneIndex(content, name); at >= 0;
             at = this.standaloneIndex(content, name, at + 1)) {
          const s2 = origCpAt(at), e2 = origCpAt(at + name.length);   // 대소문자 차이는 길이를 바꾸지 않는다
          const key = `${s2}:${e2}`;
          if (!seen.has(key)) { seen.add(key); out.push({ s: s2, e: e2 }); }
        }
      } catch { pushAllSubstr(); }                              // matcher 의 fallback 과 동일
      return out;
    };
  }

  // Build a match pattern for an entity name — word-boundary for Latin, substring for CJK
  private buildEntityMatcher(name: string): (text: string) => boolean {
    const lower = name.toLowerCase();
    if (this.hasCJK(name)) {
      // CJK: direct substring match (word boundaries don't apply)
      return (text: string) => text.toLowerCase().includes(lower);
    }
    // Latin / mixed: word-boundary regex to avoid partial-word matches
    try {
      const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      // See standaloneIndex: `\b` cannot fire when the name's own edge is punctuation.
      return (text: string) => re.test(text) || this.standaloneIndex(text, name) >= 0;
    } catch {
      return (text: string) => text.toLowerCase().includes(lower);
    }
  }

  // Automatically link entities to the specific chunks where they appear
  private async autoLinkEntities(documentId: string): Promise<number> {
    if (!this.db) return 0;

    try {
      // Get all chunk text for this document
      const chunks = this.db.prepare(
        `SELECT rowid, text, start_pos, end_pos FROM chunk_metadata WHERE document_id = ?`
      ).all(documentId) as Array<{ rowid: number; text: string; start_pos: number | null; end_pos: number | null }>;

      if (chunks.length === 0) return 0;

      // spec §5.4: range 링킹용 — 문서 본문과 finder 를 1회 준비
      const docRow = this.db.prepare(`SELECT content FROM documents WHERE id = ?`).get(documentId) as { content: string } | undefined;
      const findRanges = docRow ? this.buildEntityRangeFinder(docRow.content) : null;

      // Get all entities with observations for richer matching
      const entities = this.db.prepare(
        `SELECT id, name, entityType, observations FROM entities`
      ).all() as Array<{ id: string; name: string; entityType: string; observations: string | null }>;

      // Minimum name length: 2 for CJK (e.g. "할랄"), 4 for Latin (avoid "API", "Bug")
      const MIN_LEN_CJK = 2;
      const MIN_LEN_LATIN = 4;

      // Observation-derived aliases are only useful when the token identifies few entities.
      // Measured on a 2,891-chunk / 604-entity corpus (2026-08-22). Denominators matter here,
      // so both are stated: 66,841 rows in chunk_entities, of which 65,388 (97.8%) exist only
      // because of an alias hit; counting distinct (chunk, entity) pairs reachable by any alias
      // gives 80,096. Against that 80,096, "agents.md" alone accounts for 39,248 (49.0%), and
      // 35,099 (43.8%) have no other alias reason at all. It is held by 88 entities. A filename
      // that dozens of entities mention is a stopword, not an identifier.
      //
      // The owner cap is what does the work: the extension whitelist alone still leaves 92.3%
      // of alias links. But the cap value is a judgement call, not a discovered boundary — the
      // sweep is smooth, with no natural knee (share of the 80,096 that survives):
      //   owners<=1 1.6% · <=2 3.7% · <=3 5.2% · <=4 7.0% · <=5 8.3% · <=8 14.7% · <=10 19.9%
      // 3 was chosen to keep the intended behaviour (a file named by one or two records, plus
      // some slack) while cutting the stopword tail. Raising it is cheap and reversible.
      //
      // A chunk-frequency cap was measured (a further 1.4pp) and rejected on COST: it needs a
      // full-corpus scan on every ingest. Note the honest caveat — it was first rejected for
      // depending on ingest order, but this owner cap has that same property, and so does the
      // engine as a whole: autoLinkEntities only ever sees the entities that exist at ingest
      // time, and nothing re-links older documents when entities are added (see
      // createEntities / addObservations — neither calls this). Links are a function of when a
      // document was last processed. That predates this gate; it is not introduced by it.
      const MAX_ALIAS_OWNERS = 3;
      const aliasOwners = new Map<string, number>();
      // Owners is only half the mapping. It asks "does this token point at one entity?" and says
      // nothing about "does this entity point at one token?" — so an entity that mentions a common
      // filename ONCE in its observations attaches to every chunk containing that filename, and
      // because it is the only owner, the cap waves it through. The cap stopped the explosion
      // (tens of thousands of rows) but not the magnet (one entity on dozens of chunks).
      // Measured 2026-08-23 after the 6.0.0 cleanup: 2,014 alias-only links remained and 34
      // entities held 68.1% of them; the biggest had the entity name appearing in ZERO of its
      // chunks — pulled in entirely by a filename someone mentioned in passing.
      // So require the mapping in both directions: the token must identify the entity (owners)
      // AND the entity must identify the token (the token, or its stem, appears in the name).
      // This is a structural condition, not a threshold — there is no knee to tune and it keeps
      // meaning the same as the corpus grows. Chunk-frequency caps were measured instead
      // (585ms full scan, so cost was NOT the objection) and rejected because the sweep is smooth
      // and every cut also removed legitimate links.
      const aliasNamesTheEntity = (entityName: string, token: string): boolean => {
        const lower = entityName.toLowerCase();
        if (lower.includes(token)) return true;
        const dot = token.lastIndexOf('.');
        const stem = dot > 0 ? token.slice(0, dot) : token;
        return stem.length >= 4 && lower.includes(stem);
      };
      for (const e of entities) {
        if (!e.observations) continue;
        let obs: string[];
        try { obs = JSON.parse(e.observations); } catch { continue; }
        const seen = new Set<string>();
        for (const ob of obs) {
          const pm = String(ob).match(/[\w\-]+\.\w{1,4}\b/g);
          if (pm) for (const p of pm) if (p.length >= 4) seen.add(p.toLowerCase());
        }
        for (const t of seen) aliasOwners.set(t, (aliasOwners.get(t) ?? 0) + 1);
      }

      const insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO chunk_entities (chunk_rowid, entity_id) VALUES (?, ?)
      `);

      let linkedCount = 0;

      for (const entity of entities) {
        const minLen = this.hasCJK(entity.name) ? MIN_LEN_CJK : MIN_LEN_LATIN;
        if (entity.name.length < minLen) continue;

        const nameMatcher = this.buildEntityMatcher(entity.name);

        // Also collect observation-derived aliases (short keywords from observations).
        // Gated: the token must look like a filename AND identify at most MAX_ALIAS_OWNERS
        // entities. Ungated, "agents.md" linked 88 entities to every chunk that mentioned it.
        const aliases: ((text: string) => boolean)[] = [];
        if (entity.observations) {
          let obs: string[];
          try { obs = JSON.parse(entity.observations); } catch { obs = []; }
          for (const ob of obs) {
            // Extract file paths or identifiers mentioned in observations (e.g. "gemini_converter.py")
            const pathMatch = ob.match(/[\w\-]+\.\w{1,4}\b/g);
            if (pathMatch) {
              for (const p of pathMatch) {
                if (p.length < 4) continue;
                const tok = p.toLowerCase();
                if (!this.looksLikeFilename(tok)) continue;                  // "v3.3", "gpt-5.6", "0.465"
                if ((aliasOwners.get(tok) ?? 0) > MAX_ALIAS_OWNERS) continue; // shared = identifies nothing
                if (!aliasNamesTheEntity(entity.name, tok)) continue;         // mentioned in passing = magnet
                // Bare substring matching links "foo.py" to a chunk saying "notfoo.pyc".
                // Require the token to stand alone: no filename character on either side.
                const boundary = /[\w\-.]/;
                aliases.push((text: string) => {
                  const hay = text.toLowerCase();
                  let from = 0;
                  for (;;) {
                    const i = hay.indexOf(tok, from);
                    if (i < 0) return false;
                    const before = i === 0 ? '' : hay[i - 1];
                    const after = hay[i + tok.length] ?? '';
                    if (!boundary.test(before) && !boundary.test(after)) return true;
                    from = i + 1;
                  }
                });
              }
            }
          }
        }

        // Chunk-level matching: only link to chunks where entity actually appears
        let entityLinked = false;
        for (const chunk of chunks) {
          const matched = nameMatcher(chunk.text) || aliases.some(fn => fn(chunk.text));
          if (matched) {
            insertStmt.run(chunk.rowid, entity.id);
            entityLinked = true;
          }
        }
        // spec §5.4 (r7-2): chunk 단위 매칭은 경계에 잘린 이름을 영원히 놓친다 — c1 은
        // overlap 이 없어 흡수도 안 된다. primary name 의 본문 occurrence range 와
        // 교차하는 chunk 에 링크한다 (aliases 는 predicate 라 chunk 단위 유지).
        if (findRanges) {
          for (const { s, e } of findRanges(entity.name, this.hasCJK(entity.name))) {
            for (const chunk of chunks) {
              if (chunk.start_pos !== null && chunk.end_pos !== null && chunk.start_pos < e && chunk.end_pos > s) {
                insertStmt.run(chunk.rowid, entity.id);         // INSERT OR IGNORE — 중복 무해
                entityLinked = true;
              }
            }
          }
        }

        if (entityLinked) linkedCount++;
      }

      if (linkedCount > 0) {
        console.error(`🔗 Auto-linked ${linkedCount} entities to document ${documentId} (chunk-level)`);
      }

      return linkedCount;
    } catch (error) {
      console.error(`⚠️ Auto-link entities failed for ${documentId}:`, error instanceof Error ? error.message : error);
      return 0;
    }
  }

  async extractTerms(documentId: string, options: {
    minLength?: number;
    includeCapitalized?: boolean;
    customPatterns?: string[];
  } = {}): Promise<{ documentId: string; terms: string[] }> {
    if (!this.db) throw new Error('Database not initialized');
    
    // Get document
    const document = this.db.prepare(`
      SELECT content FROM documents WHERE id = ?
    `).get(documentId) as { content: string } | undefined;
    
    if (!document) {
      throw new Error(`Document with ID ${documentId} not found`);
    }
    
    console.error(`🔍 Extracting terms from document: ${documentId}`);
    
    const terms = this.extractTermsFromText(document.content, options);
    
    console.error(`✅ Terms extracted: ${terms.length} terms found`);
    return { documentId, terms };
  }

  async linkEntitiesToDocument(documentId: string, entityNames: string[]): Promise<{ documentId: string; linkedEntities: number }> {
    if (!this.db) throw new Error('Database not initialized');
    
    console.error(`🔗 Linking entities to document: ${documentId}`);
    
    // Verify document exists
    const document = this.db.prepare(`
      SELECT id FROM documents WHERE id = ?
    `).get(documentId);
    
    if (!document) {
      throw new Error(`Document with ID ${documentId} not found`);
    }
    
    // Get chunks for this document (with text for chunk-level matching)
    const chunks = this.db.prepare(`
      SELECT rowid, text FROM chunk_metadata WHERE document_id = ?
    `).all(documentId) as Array<{ rowid: number; text: string }>;

    let linkedCount = 0;

    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO chunk_entities (chunk_rowid, entity_id) VALUES (?, ?)
    `);

    for (const entityName of entityNames) {
      const entityId = `entity_${entityName.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;

      // Verify entity exists
      const entity = this.db.prepare(`
        SELECT id FROM entities WHERE id = ?
      `).get(entityId);

      if (!entity) {
        console.warn(`Entity ${entityName} not found, skipping`);
        continue;
      }

      // Chunk-level filtering: only link to chunks where entity actually appears
      const nameMatcher = this.buildEntityMatcher(entityName);
      let entityLinked = false;
      for (const chunk of chunks) {
        if (nameMatcher(chunk.text)) {
          insertStmt.run(chunk.rowid, entityId);
          entityLinked = true;
        }
      }

      if (entityLinked) linkedCount++;
    }
    
    console.error(`✅ Entities linked: ${linkedCount} entities linked to document`);
    return { documentId, linkedEntities: linkedCount };
  }

  // Report what was destroyed. The counts were already computed here and thrown away, so a caller
  // that replaces a document could not tell from the return value that anything was deleted
  // (2026-08-05 field report from a deployed project: "{stored:true} came back and I did not know
  // what I had just wiped"). Silent destruction is the defect; the numbers are free.
  private async cleanupDocument(documentId: string): Promise<{ deletedChunks: number; deletedAssociations: number; deletedVectors: number }> {
    if (!this.db) return { deletedChunks: 0, deletedAssociations: 0, deletedVectors: 0 };
    
    console.error(`🧹 Cleaning up document: ${documentId}`);
    
    // Get existing chunks
    const existingChunks = this.db.prepare(`
      SELECT rowid FROM chunk_metadata WHERE document_id = ?
    `).all(documentId) as { rowid: number }[];
    
    let deletedAssociations = 0;
    let deletedVectors = 0;
    
    // Delete associations and vectors
    for (const chunk of existingChunks) {
      // Delete chunk-entity associations
      const associations = this.db.prepare(`
        DELETE FROM chunk_entities WHERE chunk_rowid = ?
      `).run(chunk.rowid);
      deletedAssociations += associations.changes;

      // Delete vector embeddings (vec0 needs literal integer, not parameterized)
      this.db.exec(`DELETE FROM chunks WHERE rowid = ${safeRowid(chunk.rowid)}`);
      deletedVectors++;
    }

    // Delete chunk metadata
    const metadata = this.db.prepare(`
      DELETE FROM chunk_metadata WHERE document_id = ?
    `).run(documentId);
    
    if (existingChunks.length > 0) {
      console.error(`  ├─ Deleted ${deletedAssociations} entity associations`);
      console.error(`  ├─ Deleted ${deletedVectors} vector embeddings`);
      console.error(`  └─ Deleted ${metadata.changes} chunk metadata records`);
    }

    return { deletedChunks: existingChunks.length, deletedAssociations, deletedVectors };
  }

  async deleteDocument(documentId: string): Promise<{ documentId: string; deleted: boolean }> {
    if (!this.db) throw new Error('Database not initialized');
    
    console.error(`🗑️ Deleting document: ${documentId}`);
    
    try {
      // Check if document exists
      const document = this.db.prepare(`
        SELECT id FROM documents WHERE id = ?
      `).get(documentId);
      
      if (!document) {
        console.warn(`⚠️ Document '${documentId}' not found`);
        return { documentId, deleted: false };
      }
      
      // Clean up all associated data
      await this.cleanupDocument(documentId);
      
      // Delete the document itself
      const result = this.db.prepare(`
        DELETE FROM documents WHERE id = ?
      `).run(documentId);
      
      if (result.changes > 0) {
        console.error(`✅ Document '${documentId}' deleted successfully`);
        return { documentId, deleted: true };
      } else {
        console.warn(`⚠️ Document '${documentId}' was not deleted`);
        return { documentId, deleted: false };
      }
      
    } catch (error) {
      console.error(`❌ Failed to delete document '${documentId}':`, error);
      throw error;
    }
  }

  async deleteMultipleDocuments(documentIds: string[]): Promise<{ results: Array<{ documentId: string; deleted: boolean }>; summary: { deleted: number; failed: number; total: number } }> {
    if (!this.db) throw new Error('Database not initialized');
    
    console.error(`🗑️ Bulk deleting ${documentIds.length} documents`);
    
    const results: Array<{ documentId: string; deleted: boolean }> = [];
    let deletedCount = 0;
    let failedCount = 0;
    
    for (const documentId of documentIds) {
      try {
        const result = await this.deleteDocument(documentId);
        results.push(result);
        if (result.deleted) {
          deletedCount++;
        } else {
          failedCount++;
        }
      } catch (error) {
        console.error(`❌ Failed to delete document '${documentId}':`, error);
        results.push({ documentId, deleted: false });
        failedCount++;
      }
    }
    
    const summary = {
      deleted: deletedCount,
      failed: failedCount,
      total: documentIds.length
    };
    
    console.error(`✅ Bulk deletion completed: ${deletedCount} deleted, ${failedCount} failed, ${documentIds.length} total`);
    
    return { results, summary };
  }

  async deleteDocuments(documentIds: string | string[]): Promise<{ results: Array<{ documentId: string; deleted: boolean }>; summary: { deleted: number; failed: number; total: number } }> {
    if (!this.db) throw new Error('Database not initialized');
    
    // Normalize input to always be an array
    const idsArray = Array.isArray(documentIds) ? documentIds : [documentIds];
    const isMultiple = Array.isArray(documentIds);
    
    console.error(`🗑️ Deleting ${idsArray.length} document${idsArray.length > 1 ? 's' : ''}`);
    
    const results: Array<{ documentId: string; deleted: boolean }> = [];
    let deletedCount = 0;
    let failedCount = 0;
    
    for (const documentId of idsArray) {
      try {
        const result = await this.deleteDocument(documentId);
        results.push(result);
        if (result.deleted) {
          deletedCount++;
        } else {
          failedCount++;
        }
      } catch (error) {
        console.error(`❌ Failed to delete document '${documentId}':`, error);
        results.push({ documentId, deleted: false });
        failedCount++;
      }
    }
    
    const summary = {
      deleted: deletedCount,
      failed: failedCount,
      total: idsArray.length
    };
    
    const operation = isMultiple ? 'Bulk deletion' : 'Document deletion';
    console.error(`✅ ${operation} completed: ${deletedCount} deleted, ${failedCount} failed, ${idsArray.length} total`);
    
    return { results, summary };
  }

  async listDocuments(includeMetadata = true): Promise<{ documents: Array<{ id: string; metadata?: any; created_at: string }> }> {
    if (!this.db) throw new Error('Database not initialized');
    
    console.error(`📋 Listing all documents (metadata: ${includeMetadata})`);
    
    const query = includeMetadata 
      ? `SELECT id, metadata, created_at FROM documents ORDER BY created_at DESC`
      : `SELECT id, created_at FROM documents ORDER BY created_at DESC`;
    
    const rows = this.db.prepare(query).all() as Array<{ id: string; metadata?: string; created_at: string }>;
    
    const documents = rows.map(row => ({
      id: row.id,
      ...(includeMetadata && row.metadata ? { metadata: JSON.parse(row.metadata) } : {}),
      created_at: row.created_at
    }));
    
    console.error(`✅ Found ${documents.length} documents`);
    
    return { documents };
  }

  async exportGraph(): Promise<{ entities: any[]; relations: any[]; documents: any[]; observation_roots: any[]; entity_observations: any[]; observation_sources: any[]; observation_events: any[]; metadata: { exportedAt: string; version: string; entityCount: number; relationCount: number; documentCount: number } }> {
    if (!this.db) throw new Error('Database not initialized');

    console.error('📦 Exporting knowledge graph...');

    const entities = this.db.prepare(`
      SELECT id, name, entityType, observations, metadata, created_at FROM entities
    `).all().map((row: any) => ({
      id: row.id,
      name: row.name,
      entityType: row.entityType,
      observations: JSON.parse(row.observations),
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at
    }));

    const relations = this.db.prepare(`
      SELECT id, source_entity, target_entity, relationType, confidence, metadata, created_at FROM relationships
    `).all().map((row: any) => ({
      id: row.id,
      source_entity: row.source_entity,
      target_entity: row.target_entity,
      relationType: row.relationType,
      confidence: row.confidence,
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at
    }));

    const documents = this.db.prepare(`
      SELECT id, content, metadata, created_at FROM documents
    `).all().map((row: any) => ({
      id: row.id,
      content: row.content,
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at
    }));

    console.error(`✅ Export completed: ${entities.length} entities, ${relations.length} relations, ${documents.length} documents`);

    // spec §6.4: lifecycle 정본을 함께 내보낸다. 이게 없으면 export->import 뒤
    // 관찰의 신원·출처·이력이 사라지고 projection 만 남는다.
    const observation_roots = this.db.prepare(
      `SELECT * FROM observation_roots ORDER BY entity_id, projection_order`).all();
    const entity_observations = this.db.prepare(
      `SELECT * FROM entity_observations ORDER BY root_id, revision_no`).all();
    const observation_sources = this.db.prepare(
      `SELECT * FROM observation_sources ORDER BY observation_id, source_kind, source_ref`).all();
    const observation_events = this.db.prepare(
      `SELECT * FROM observation_events ORDER BY root_id, recorded_at, event_id`).all();

    return {
      entities,
      relations,
      documents,
      observation_roots,
      entity_observations,
      observation_sources,
      observation_events,
      metadata: {
        exportedAt: new Date().toISOString(),
        version: PKG_VERSION,
        entityCount: entities.length,
        relationCount: relations.length,
        documentCount: documents.length
      }
    };
  }

  async importGraph(data: { entities?: any[]; relations?: any[]; documents?: any[]; observation_roots?: any[]; entity_observations?: any[]; observation_sources?: any[]; observation_events?: any[] }, options: { merge?: boolean } = { merge: true }): Promise<{ imported: { entities: number; relations: number; documents: number }; skipped: { entities: number; relations: number; documents: number }; observation_order_remap: Array<{ root_id: string; entity_id: string; from: number; to: number }> }> {
    if (!this.db) throw new Error('Database not initialized');

    console.error(`📥 Importing knowledge graph (merge: ${options.merge !== false})...`);

    const imported = { entities: 0, relations: 0, documents: 0 };
    const skipped = { entities: 0, relations: 0, documents: 0 };
    // merge 로 배열 위치가 재배정된 관찰. 조용히 순서를 바꾸면 호출자가 알 수 없으므로
    // 응답으로 내보낸다(advisor beta r3 발견 3).
    const remapReport: Array<{ root_id: string; entity_id: string; from: number; to: number }> = [];

    // spec §6.4: abort 는 0 mutation 이다. lifecycle 만 트랜잭션으로 감싸면
    // 충돌로 throw 할 때 그 앞에서 넣은 entity·relation·document 가 살아남는다
    // (T17b 가 ghost entity 로 실증). import 전체가 한 단위여야 한다.
    // 내부 transaction() 호출은 better-sqlite3 에서 savepoint 로 중첩된다.
    const importAll = this.db!.transaction(() => {
    // If merge=false, clear existing data first
    if (options.merge === false) {
      this.db!.exec(`DELETE FROM relationships`);
      // entities 삭제가 FK CASCADE 로 lifecycle 4테이블을 지우지만, 순서를 계약으로
      // 두어 FK 가 꺼진 환경에서도 잔존 행이 남지 않게 한다.
      this.db!.exec(`DELETE FROM observation_events`);
      this.db!.exec(`DELETE FROM observation_sources`);
      this.db!.exec(`DELETE FROM entity_observations`);
      this.db!.exec(`DELETE FROM observation_roots`);
      this.db!.exec(`DELETE FROM entities`);
      this.db!.exec(`DELETE FROM documents`);
      // entities 를 지워도 파생 데이터는 따라오지 않는다: chunk_metadata 에는
      // entities 로 가는 FK 가 없고 entity_embedding_metadata.entity_id 는 UNIQUE 일
      // 뿐이다. 그래서 replace-import 뒤에 **사라진 entity 의 벡터와 KG chunk 가
      // 검색에 남았다**(advisor beta 발견 2). document chunk 는 documents 의
      // CASCADE 로 이미 정리되므로 여기서는 entity·relationship chunk 만 지운다.
      const orphanChunks = this.db!.prepare(
        `SELECT rowid FROM chunk_metadata WHERE chunk_type IN ('entity','relationship')`)
        .all() as Array<{ rowid: number }>;
      for (const c of orphanChunks) {
        this.db!.exec(`DELETE FROM chunks WHERE rowid = ${Number(c.rowid)}`);
        this.db!.prepare(`DELETE FROM chunk_metadata WHERE rowid = ?`).run(c.rowid);
      }
      this.db!.exec(
        `DELETE FROM entity_embeddings WHERE rowid IN (SELECT rowid FROM entity_embedding_metadata)`);
      this.db!.exec(`DELETE FROM entity_embedding_metadata`);
      console.error('🗑️ Cleared existing data for full import');
    }

    // Import entities using INSERT OR IGNORE
    if (data.entities && Array.isArray(data.entities)) {
      const stmt = this.db!.prepare(`
        INSERT OR IGNORE INTO entities (id, name, entityType, observations, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const entity of data.entities) {
        const result = stmt.run(
          entity.id,
          entity.name,
          entity.entityType || 'CONCEPT',
          // v13: observations 는 projection 이다. lifecycle 행을 넣은 뒤
          // rebuildProjection 이 채운다 — 여기서 배열을 심으면 정본과 갈라진다.
          '[]',
          JSON.stringify(entity.metadata || {}),
          entity.created_at || new Date().toISOString()
        );
        if (result.changes > 0) {
          imported.entities++;
        } else {
          skipped.entities++;
        }
      }
    }

    // Import relations using INSERT OR IGNORE
    if (data.relations && Array.isArray(data.relations)) {
      const stmt = this.db!.prepare(`
        INSERT OR IGNORE INTO relationships (id, source_entity, target_entity, relationType, confidence, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const relation of data.relations) {
        const result = stmt.run(
          relation.id,
          relation.source_entity,
          relation.target_entity,
          relation.relationType,
          relation.confidence ?? 1.0,
          JSON.stringify(relation.metadata || {}),
          relation.created_at || new Date().toISOString()
        );
        if (result.changes > 0) {
          imported.relations++;
        } else {
          skipped.relations++;
        }
      }
    }

    // Import documents using INSERT OR REPLACE
    if (data.documents && Array.isArray(data.documents)) {
      const stmt = this.db!.prepare(`
        INSERT OR REPLACE INTO documents (id, content, metadata, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const doc of data.documents) {
        const result = stmt.run(
          doc.id,
          doc.content,
          JSON.stringify(doc.metadata || {}),
          doc.created_at || new Date().toISOString()
        );
        if (result.changes > 0) {
          imported.documents++;
        } else {
          skipped.documents++;
        }
      }
    }

    // ---- spec §6.4: lifecycle import ----
    // 순서가 계약이다: entities -> roots -> revisions(root별 revision_no ↑)
    // -> sources/events. §4.1 트리거가 root 선행과 체인 연속성을 요구하므로
    // importer 는 입력 순서와 무관하게 재정렬한다 (역순 export 를 그대로
    // 스트리밍하면 'immediately preceding revision' 으로 죽는다).
    const sameRow = (a: any, b: any, cols: string[]) =>
      cols.every(c => (a[c] ?? null) === (b[c] ?? null));

    const hasLifecycle = Array.isArray(data.observation_roots);
    if (hasLifecycle) {
      const tx = this.db!.transaction(() => {
        // 새 root 가 이미 점유된 (entity_id, projection_order) 슬롯을 요구할 수 있다:
        // 두 DB 가 같은 entity 이름을 갖고 서로 다른 관찰을 배열 0번에 두면 그렇다.
        // 이건 §6.4 의 "같은 키 다른 값" 충돌이 아니라 **슬롯 충돌**이고, 규칙이 없어서
        // raw UNIQUE 오류로 터졌다(내 MCP 왕복 테스트가 잡았다). merge 의 뜻은
        // "더한다"이므로 들어오는 root 에 다음 빈 순번을 준다 — 남의 관찰을 덮지 않고,
        // 배열 끝에 붙는다. remap 은 그 root 의 revision 들에도 그대로 적용해야 한다
        // (trg_obs_matches_root 가 둘의 일치를 요구한다).
        // 입력 순서에 결과가 의존하면 같은 dump 를 두 번 넣었을 때 배열 순서가 달라진다.
        // (entity_id, projection_order, root_id) 로 정렬해 결정론을 만든다.
        const incomingRoots = [...(data.observation_roots ?? [])].sort((a, b) =>
          String(a.entity_id).localeCompare(String(b.entity_id)) ||
          (a.projection_order - b.projection_order) ||
          String(a.root_id).localeCompare(String(b.root_id)));

        const remappedOrder = new Map<string, number>();
        for (const r of incomingRoots) {
          const cur = this.db!.prepare(`SELECT * FROM observation_roots WHERE root_id = ?`)
            .get(r.root_id) as any;
          if (cur) {
            // projection_order 는 **target-local** 속성이다: merge 는 배열 위치를
            // 이 DB 기준으로 재배정하므로, 이미 remap 된 root 를 같은 dump 로 다시
            // 넣으면 dump 의 옛 순번과 다를 수밖에 없다. 그걸 충돌로 보면 동일
            // 재수입이 실패한다(advisor beta r3 발견 3, 실행 재현).
            if (!sameRow(cur, r, ['entity_id', 'created_at']))
              throw new Error(`import conflict: observation_roots ${r.root_id} differs from the existing row`);
            remappedOrder.set(r.root_id, cur.projection_order);
            continue;
          }
          let order = r.projection_order;
          const taken = this.db!.prepare(
            `SELECT root_id FROM observation_roots WHERE entity_id = ? AND projection_order = ?`)
            .get(r.entity_id, order) as { root_id: string } | undefined;
          if (taken) {
            order = nextProjectionOrder(this.db!, r.entity_id);
            remappedOrder.set(r.root_id, order);
            remapReport.push({ root_id: r.root_id, entity_id: r.entity_id,
                               from: r.projection_order, to: order });
            console.error(
              `  ├─ ↪️ import: ${r.entity_id} position ${r.projection_order} is held by ` +
              `${taken.root_id}; appending imported observation at ${order}`);
          }
          this.db!.prepare(`INSERT INTO observation_roots
            (root_id, entity_id, projection_order, created_at) VALUES (?, ?, ?, ?)`)
            .run(r.root_id, r.entity_id, order, r.created_at);
        }

        // projection_order 는 root 와 같은 이유로 비교 대상이 아니다(target-local).
        const revCols = ['root_id','entity_id','revision_no','content',
                         'status','supersedes_id','recorded_at','superseded_at'];
        const revs = [...(data.entity_observations ?? [])]
          .sort((a, b) => a.root_id === b.root_id
            ? a.revision_no - b.revision_no
            : String(a.root_id).localeCompare(String(b.root_id)));
        for (const v of revs) {
          const cur = this.db!.prepare(`SELECT * FROM entity_observations WHERE observation_id = ?`)
            .get(v.observation_id) as any;
          if (cur) {
            if (!sameRow(cur, v, revCols))
              throw new Error(`import conflict: entity_observations ${v.observation_id} differs from the existing row`);
            continue;
          }
          const order = remappedOrder.has(v.root_id)
            ? remappedOrder.get(v.root_id)! : v.projection_order;
          this.db!.prepare(`INSERT INTO entity_observations
            (observation_id, root_id, entity_id, revision_no, projection_order,
             content, status, supersedes_id, recorded_at, superseded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(v.observation_id, v.root_id, v.entity_id, v.revision_no, order,
                 v.content, v.status, v.supersedes_id ?? null, v.recorded_at, v.superseded_at ?? null);
        }

        for (const so of (data.observation_sources ?? [])) {
          const cur = this.db!.prepare(`SELECT * FROM observation_sources
            WHERE observation_id=? AND source_kind=? AND source_ref=?`)
            .get(so.observation_id, so.source_kind, so.source_ref) as any;
          if (cur) {
            if (!sameRow(cur, so, ['source_hash', 'recorded_at']))
              throw new Error(`import conflict: observation_sources ` +
                `${so.observation_id}/${so.source_kind}/${so.source_ref} differs from the existing row`);
            continue;
          }
          this.db!.prepare(`INSERT INTO observation_sources
            (observation_id, source_kind, source_ref, source_hash, recorded_at) VALUES (?, ?, ?, ?, ?)`)
            .run(so.observation_id, so.source_kind, so.source_ref, so.source_hash ?? null, so.recorded_at);
        }

        const evCols = ['root_id','from_id','to_id','event','change_kind','reason','actor','batch_id','recorded_at'];
        for (const e of (data.observation_events ?? [])) {
          const cur = this.db!.prepare(`SELECT * FROM observation_events WHERE event_id = ?`)
            .get(e.event_id) as any;
          if (cur) {
            if (!sameRow(cur, e, evCols))
              throw new Error(`import conflict: observation_events ${e.event_id} differs from the existing row`);
            continue;
          }
          this.db!.prepare(`INSERT INTO observation_events
            (event_id, root_id, from_id, to_id, event, change_kind, reason, actor, batch_id, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(e.event_id, e.root_id, e.from_id ?? null, e.to_id ?? null, e.event,
                 e.change_kind ?? null, e.reason ?? null, e.actor ?? null, e.batch_id ?? null, e.recorded_at);
        }
      });
      tx();
    } else {
      // 구(舊) 형식 export: lifecycle 필드가 없으므로 entities.observations 를
      // 신규 root 로 승격한다. legacy import 필수 필드값 = spec §6.4.
      const ts = new Date().toISOString();
      const tx = this.db!.transaction(() => {
        for (const ent of (data.entities ?? [])) {
          const entityId = ent.id ??
            `entity_${String(ent.name).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;
          for (const content of (ent.observations ?? [])) {
            addRevision(this.db!, {
              entityId, content, status: 'active',
              sources: [{ source_kind: 'import', source_ref: 'legacy-export', source_hash: null }],
              actor: 'import', ts, event: 'import'
            });
          }
        }
      });
      tx();
    }

    // projection 재합성 + 파생 상태 무효화.
    // 무효화가 없으면 이미 있던 entity 를 덮어쓴 뒤에도 옛 벡터·옛 KG chunk 가
    // 검색에 남는다. import 는 관찰을 바꾸는 writer 이므로 다른 writer 와 같은
    // 계약을 져야 한다(advisor beta 발견 2).
    //
    // 대상은 `data.entities` 가 아니라 **영향받은 entity 전부**다. lifecycle import 는
    // observation_roots 만 있어도 활성화되므로, entities 없이 lifecycle 배열만 보내면
    // revision 은 들어가는데 projection 이 갱신되지 않아 새 사실이 reader 에 안 보이고
    // 옛 벡터가 남는다(advisor beta r3 발견 2, 실행 재현).
    const affected = new Set<string>();
    for (const ent of (data.entities ?? [])) {
      affected.add(ent.id ??
        `entity_${String(ent.name).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`);
    }
    for (const r of (data.observation_roots ?? [])) if (r.entity_id) affected.add(r.entity_id);
    for (const v of (data.entity_observations ?? [])) if (v.entity_id) affected.add(v.entity_id);
    for (const entityId of affected) {
      rebuildProjection(this.db!, entityId);
      this.invalidateDerivedForEntity(entityId);
    }
    });
    importAll();

    console.error(`✅ Import completed: ${imported.entities} entities, ${imported.relations} relations, ${imported.documents} documents imported`);

    // Indirect missing-row producer (spec §5): imported rows may lack vectors.
    this.coordinator?.invalidateCoverage();
    this.coordinator?.kick();
    return { imported, skipped, observation_order_remap: remapReport };
  }

  /**
   * Diagnostic seam for the graph re-ranker (evaluation change graph-role-evaluation, R2).
   * Returns the seed entities (query-vector matched, similarity > 0.4, top-10 per variant) and the
   * 1-hop connected entities exactly as hybridSearch(useGraph:true) computes them, plus edge detail
   * that hybridSearch itself does not use (edge id, type, direction, confidence). It never generates
   * candidates and never changes ranking; hybridSearch consumes only the name sets.
   * `opts.chunkVectorDegraded` lets a caller hand over a decision it has already made; omit it and
   * the seam derives eligibility itself.
   */
  async explainGraphContext(query: string, queryVariants?: string[],
                            opts?: { chunkVectorDegraded?: boolean }): Promise<{
    status: 'vector' | 'entity-text-fallback' | 'chunk-vector-disabled' | 'error';
    query_variants: string[];
    seeds: Array<{ entity_id: string; name: string; similarity: number }>;
    connected: Array<{ entity_id: string; name: string; via_seed_id: string; via_seed_name: string;
                       edge_id: string; relation_type: string; direction: 'out' | 'in'; confidence: number | null }>;
  }> {
    if (!this.db) throw new Error('Database not initialized');
    const variants = queryVariants ?? this.buildCrossLingualVariants(query);
    const empty = { query_variants: variants, seeds: [] as any[], connected: [] as any[] };
    // The caller's latched decision wins (review finding I2). hybridSearch decides chunk-vector
    // degradation once, before the chunk-embedding awaits, and passes that value down; re-deriving
    // it here would let an eligibility flip during those awaits give the seam a different answer
    // than the ranking path already acted on — the pre-extraction code read it once, so this keeps
    // behaviour identical. A standalone caller passes nothing and gets the live derivation.
    const chunkVectorDegraded = opts?.chunkVectorDegraded ?? !(this.coordinator?.eligible ?? false);
    if (chunkVectorDegraded) return { status: 'chunk-vector-disabled', ...empty };
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

  // v5.3.0: the graph re-ranker is OPT-IN (harm-reduced default, not a validated improvement).
  // Measured 2026-08-17 on three real corpora (self-retrieval, usable samples 120/117/120,
  // summaries off): with the additive graph boost on, the known-item chunk got WORSE in
  // 46/49/52 samples and BETTER in 3/2/0 (sign test p < 7e-11 per corpus); 106 targets left the
  // top-10 entirely. Reproduced on the summaries-on product path (HAL, 20 paired samples:
  // hit@1 10 -> 7, hit@5 18 -> 13, worse 8 / better 3). Mechanism: only query-matched or
  // connected entities score, but the per-entity boost (0.5^i decay, cap 0.4) saturates fast, so
  // heavily-linked chunks get more chances to match and reach the cap — they can outrank the
  // exact chunk even at vector_similarity 0. Note the graph does not generate candidates: it only
  // re-orders the vector/FTS candidate pool, so useGraph:true is a legacy/experimental re-ranker
  // (backward compatibility, controlled evaluation), not a relationship-exploration path — that
  // contract is openNodes -> getNeighbors. The boost path itself is unchanged.
  async hybridSearch(query: string, limit = 5, useGraph = false): Promise<{
    results: EnhancedSearchResult[];
    search_mode: 'hybrid' | 'hybrid-partial' | 'fts-only';
    model_state: string;
    coverage: { chunk_pct: number; graph_coverage_pct: number };
    degradation_reason?: string;
  }> {
    if (!this.db) throw new Error('Database not initialized');
    if (!this.encoding) throw new Error('Tokenizer not initialized');
    
    console.error(`🔍 Enhanced hybrid search: "${query}"`);
    // Parity with searchNodes (beta 1R supplement): an unsearchable query gets
    // an explicit warning instead of a silent empty envelope.
    const ftsUnsearchable = compileFtsLiteralQuery(query) === null;
    const queryVariants = this.buildCrossLingualVariants(query);
    if (queryVariants.length > 1) {
      console.error(`🌐 Cross-lingual variants: ${queryVariants.slice(1).join(' | ')}`);
    }
    let vectorDegraded = false;
    let primaryQueryEmbedding: Float32Array | null = null;

    // Vector search helper
    const searchChunks = (embedding: Float32Array, k: number) => {
      return this.db!.prepare(`
        SELECT
          c.rowid,
          m.chunk_id,
          m.chunk_type,
          m.document_id,
          m.entity_id,
          m.relationship_id,
          m.chunk_index,
          m.text,
          m.start_pos,
          m.end_pos,
          m.start_token,
          m.end_token,
          COALESCE(m.metadata, '{}') as chunk_metadata,
          c.distance,
          COALESCE(d.metadata, '{}') as doc_metadata
        FROM chunks c
        JOIN chunk_metadata m ON c.rowid = m.rowid
        LEFT JOIN documents d ON m.document_id = d.id
        WHERE c.embedding MATCH ?
          AND k = ?
        ORDER BY c.distance
      `).all(Buffer.from(embedding.buffer), k) as Array<{
        rowid: number;
        chunk_id: string;
        chunk_type: string;
        document_id: string | null;
        entity_id: string | null;
        relationship_id: string | null;
        chunk_index: number;
        text: string;
        start_pos: number | null;
        end_pos: number | null;
        start_token: number | null;
        end_token: number | null;
        chunk_metadata: string;
        distance: number;
        doc_metadata: string;
      }>;
    };

    type ChunkSearchResult = ReturnType<typeof searchChunks>[number];

    // Search original query plus cross-lingual expansions and keep best match per chunk.
    // v3.6 eligibility gate (spec §3): vector usage requires model_ready AND
    // reconciliation settled — otherwise FTS5-only, no waiting.
    const resultMap = new Map<string, ChunkSearchResult>();
    let degradationReason: string | undefined;
    if (!(this.coordinator?.eligible ?? false)) {
      vectorDegraded = true;
      degradationReason = this.degradationReason();
      console.error(`ℹ️ vector search not eligible (${degradationReason ?? 'unknown'}) — FTS5-only`);
    } else {
      try {
        primaryQueryEmbedding = await this.generateEmbedding(queryVariants[0], 1024, true);
        for (const variant of queryVariants) {
          const embedding = await this.generateEmbedding(variant, 1024, true);
          const variantResults = searchChunks(embedding, limit * 3);
          for (const r of variantResults) {
            const existing = resultMap.get(r.chunk_id);
            if (!existing || r.distance < existing.distance) {
              resultMap.set(r.chunk_id, r);
            }
          }
        }
      } catch (embErr) {
        vectorDegraded = true;
        // 'inference_error' (not 'model_not_ready'): model_state may still read
        // 'ready' here — a contradictory reason pair confused callers (beta B6).
        degradationReason = this.degradationReason() ?? 'inference_error';
        console.error(`⚠️ Vector search unavailable — degrading to FTS5-only:`, embErr instanceof Error ? embErr.message : embErr);
      }
    }
    const vectorResults = Array.from(resultMap.values()).sort((a, b) => a.distance - b.distance);

    // FTS5 full-text search as additional signal (Reciprocal Rank Fusion)
    const ftsBoostMap = new Map<string, number>();
    try {
      const ftsSearchQuery = (q: string) => {
        // Shared compiler (spec §5) — same sanitize rules as pre-3.6, extracted
        // so entity FTS fallback uses identical MATCH-safety guarantees.
        const ftsExpr = compileFtsLiteralQuery(q);
        if (ftsExpr === null) return [];
        return this.db!.prepare(`
          SELECT cm.rowid, cm.chunk_id, bm25(chunks_fts) as fts_score
          FROM chunks_fts
          JOIN chunk_metadata cm ON chunks_fts.rowid = cm.rowid
          WHERE chunks_fts MATCH ?
          ORDER BY bm25(chunks_fts)
          LIMIT ?
        `).all(ftsExpr, limit * 3) as Array<{
          rowid: number;
          chunk_id: string;
          fts_score: number;
        }>;
      };

      // Merge FTS5 results from all query variants, keeping first-seen rank.
      const ftsResultMap = new Map<string, { chunk_id: string; fts_score: number; rank: number }>();
      let rank = 1;
      for (const variant of queryVariants) {
        for (const r of ftsSearchQuery(variant)) {
          if (ftsResultMap.has(r.chunk_id)) continue;
          ftsResultMap.set(r.chunk_id, { chunk_id: r.chunk_id, fts_score: r.fts_score, rank });
          rank++;
        }
      }

      // Build vector rank map for RRF
      const vectorRankMap = new Map<string, number>();
      vectorResults.forEach((r, idx) => vectorRankMap.set(r.chunk_id, idx + 1));

      // Calculate RRF-based FTS5 boost (k=60)
      const k = 60;
      for (const [chunkId, ftsResult] of ftsResultMap) {
        const ftsComponent = 1 / (k + ftsResult.rank);
        ftsBoostMap.set(chunkId, ftsComponent);
      }

      // Add FTS5-only results to the vector result pool
      for (const [chunkId] of ftsResultMap) {
        if (!resultMap.has(chunkId)) {
          const chunkRow = this.db!.prepare(`
            SELECT
              cm.rowid,
              cm.chunk_id,
              cm.chunk_type,
              cm.document_id,
              cm.entity_id,
              cm.relationship_id,
              cm.chunk_index,
              cm.text,
              cm.start_pos,
              cm.end_pos,
              cm.start_token,
              cm.end_token,
              COALESCE(cm.metadata, '{}') as chunk_metadata,
              COALESCE(d.metadata, '{}') as doc_metadata
            FROM chunk_metadata cm
            LEFT JOIN documents d ON cm.document_id = d.id
            WHERE cm.chunk_id = ?
          `).get(chunkId) as any;
          if (chunkRow) {
            vectorResults.push({
              ...chunkRow,
              distance: 2.0
            });
          }
        }
      }

      const ftsCount = ftsResultMap.size;
      const ftsOnlyCount = [...ftsResultMap.keys()].filter(id => !vectorRankMap.has(id)).length;
      console.error(`📝 FTS5 search: ${ftsCount} matches (${ftsOnlyCount} FTS5-only), ${ftsBoostMap.size} boosted`);
    } catch (ftsError) {
      console.error(`⚠️ FTS5 search unavailable (graceful degradation):`, ftsError instanceof Error ? ftsError.message : ftsError);
    }

    if (vectorResults.length === 0) {
      console.error(`ℹ️ No vector or FTS5 matches found for "${query}"`);
      // Empty results still carry state (spec §5c: envelope exists so callers
      // can distinguish "nothing matched" from "vector search was degraded").
      const covE = this.coordinator?.coverage();
      const chunkPctE = covE && covE.chunk.total > 0 ? Math.round((covE.chunk.embedded / covE.chunk.total) * 100) : 100;
      const graphPctE = covE && covE.entity.total > 0 ? Math.round((covE.entity.embedded / covE.entity.total) * 100) : 100;
      return {
        results: [],
        search_mode: vectorDegraded ? 'fts-only' : (chunkPctE < 100 ? 'hybrid-partial' : 'hybrid'),
        model_state: this.gate.status.state,
        coverage: { chunk_pct: chunkPctE, graph_coverage_pct: graphPctE },
        ...(degradationReason ? { degradation_reason: degradationReason } : {}),
        ...(ftsUnsearchable ? { warning: 'query has no searchable terms for FTS' } : {}),
      };
    }

    // Get entity information for graph enhancement — via the diagnostic seam (evaluation change
    // graph-role-evaluation R2). Same SQL, same threshold, same fallback; hybridSearch consumes only names.
    let connectedEntities = new Set<string>();
    let queryMatchedEntities = new Set<string>();
    if (useGraph && !vectorDegraded) {
      const ctx = await this.explainGraphContext(query, queryVariants, { chunkVectorDegraded: vectorDegraded });
      for (const s of ctx.seeds) queryMatchedEntities.add(s.name);
      for (const c of ctx.connected) connectedEntities.add(c.name);
    }
    
    // Process results with semantic summaries
    const enhancedResults: EnhancedSearchResult[] = [];
    
    for (const result of vectorResults) {
      // Get entities associated with this chunk (for document chunks)
      let chunkEntities: string[] = [];
      if (result.chunk_type === 'document') {
        chunkEntities = this.db.prepare(`
          SELECT e.name 
          FROM chunk_entities ce
          JOIN entities e ON e.id = ce.entity_id
          WHERE ce.chunk_rowid = ?
        `).all(result.rowid).map((row: any) => row.name);
      } else if (result.chunk_type === 'entity' && result.entity_id) {
        // For entity chunks, get the entity name
        const entity = this.db.prepare(`
          SELECT name FROM entities WHERE id = ?
        `).get(result.entity_id) as { name: string } | undefined;
        if (entity) {
          chunkEntities = [entity.name];
        }
      } else if (result.chunk_type === 'relationship' && result.relationship_id) {
        // For relationship chunks, get both entities
        const relEntities = this.db.prepare(`
          SELECT e1.name as source_name, e2.name as target_name
          FROM relationships r
          JOIN entities e1 ON r.source_entity = e1.id
          JOIN entities e2 ON r.target_entity = e2.id
          WHERE r.id = ?
        `).get(result.relationship_id) as { source_name: string; target_name: string } | undefined;
        if (relEntities) {
          chunkEntities = [relEntities.source_name, relEntities.target_name];
        }
      }
      
      // Enhanced graph boost calculation with decay + cap
      let graphBoost = 0;
      if (useGraph && !vectorDegraded) {
        const queryEntities = this.extractTermsFromText(query);

        // Base boost for knowledge graph chunks
        if (result.chunk_type === 'entity') {
          graphBoost += 0.15;
        } else if (result.chunk_type === 'relationship') {
          graphBoost += 0.25;
        }

        // Collect per-entity scores (instead of blind accumulation)
        const entityScores: number[] = [];
        const queryLower = query.toLowerCase();
        for (const entity of chunkEntities) {
          let score = 0;
          const entityLower = entity.toLowerCase();
          // Vector-matched entity (cross-lingual: "할랄 인증" → "KMF")
          if (queryMatchedEntities.has(entity)) {
            score = 0.3;
          }
          // Exact text match with extracted terms
          else if (queryEntities.some(qe => qe.toLowerCase() === entityLower)) {
            score = 0.3;
          }
          // Partial match: entity name appears in query or vice versa
          else if (queryLower.includes(entityLower) || entityLower.includes(queryLower)) {
            score = 0.2;
          }
          // Word-level partial match
          else if (entityLower.split(/\s+/).some(word => word.length >= 3 && queryLower.includes(word))) {
            score = 0.15;
          }
          // Connected to a vector-matched entity (additive, independent)
          if (connectedEntities.has(entity)) {
            score += 0.15;
          }
          if (score > 0) entityScores.push(score);
        }

        // Geometric decay: sort descending, apply 0.5^i decay per entity
        entityScores.sort((a, b) => b - a);
        let entityBoost = 0;
        for (let i = 0; i < entityScores.length; i++) {
          entityBoost += entityScores[i] * Math.pow(0.5, i);
        }
        // Hard cap to prevent graph domination
        graphBoost += Math.min(entityBoost, 0.4);
      }
      
      // Generate semantic summary (skip when degraded — no embeddings available).
      // RAG_MEMORY_SEARCH_SUMMARIES=off: diagnostic escape hatch (v5) — the summary
      // path embeds EVERY sentence of EVERY candidate (~100+ inferences per search,
      // measured 90-120s cold). Off = preview slices + relevanceScore 0; ranking
      // then rests on vectorSimilarity + boosts. Default unchanged.
      let summary: string, keyHighlight: string, relevanceScore: number;
      if (vectorDegraded || !primaryQueryEmbedding || process.env.RAG_MEMORY_SEARCH_SUMMARIES === 'off') {
        keyHighlight = result.text.slice(0, 150);
        summary = result.text.slice(0, 300);
        relevanceScore = 0;
      } else {
        ({ summary, keyHighlight, relevanceScore } = await this.generateContentSummary(
          result.text,
          primaryQueryEmbedding,
          chunkEntities,
          result.chunk_type === 'relationship' ? 1 : 2 // Shorter summary for relationships
        ));
      }
      
      const vectorSimilarity = Math.max(0, 1 - result.distance / 2);
      const ftsBoost = ftsBoostMap.get(result.chunk_id) || 0;
      const finalScore = Math.max(vectorSimilarity, relevanceScore) + graphBoost + ftsBoost;
      
      // Determine document title and source ID
      let documentTitle: string;
      let sourceId: string;
      
      if (result.chunk_type === 'document') {
        const metadata = JSON.parse(result.doc_metadata);
        documentTitle = metadata.title || metadata.name || result.document_id || 'Unknown Document';
        sourceId = result.document_id || '';
      } else if (result.chunk_type === 'entity') {
        documentTitle = 'Knowledge Graph Entity';
        sourceId = result.entity_id || '';
      } else if (result.chunk_type === 'relationship') {
        documentTitle = 'Knowledge Graph Relationship';
        sourceId = result.relationship_id || '';
      } else {
        documentTitle = 'Unknown Source';
        sourceId = '';
      }
      
      enhancedResults.push({
        relevance_score: finalScore,
        key_highlight: keyHighlight,
        content_summary: summary,
        chunk_id: result.chunk_id,
        document_title: documentTitle,
        entities: chunkEntities,
        vector_similarity: vectorSimilarity,
        graph_boost: (useGraph && !vectorDegraded) ? graphBoost : undefined,
        fts_boost: ftsBoost > 0 ? ftsBoost : undefined,
        full_context_available: true,
        chunk_type: result.chunk_type as 'document' | 'entity' | 'relationship',
        source_id: sourceId
      });
    }

    // Sort by relevance and return top results
    const finalResults = enhancedResults
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, limit);

    // Log search statistics
    const docResults = finalResults.filter(r => r.chunk_type === 'document').length;
    const entityResults = finalResults.filter(r => r.chunk_type === 'entity').length;
    const relResults = finalResults.filter(r => r.chunk_type === 'relationship').length;

    console.error(`✅ Enhanced hybrid search completed: ${finalResults.length} results (${docResults} docs, ${entityResults} entities, ${relResults} relationships)`);

    // v3.6 envelope (spec §5c, breaking): search_mode moved from per-item to
    // top-level so state is visible even on empty results; coverage tells the
    // caller how much of the corpus is actually vector-searchable.
    const cov = this.coordinator?.coverage();
    const chunkPct = cov && cov.chunk.total > 0 ? Math.round((cov.chunk.embedded / cov.chunk.total) * 100) : 100;
    const graphPct = cov && cov.entity.total > 0 ? Math.round((cov.entity.embedded / cov.entity.total) * 100) : 100;
    const search_mode = vectorDegraded ? 'fts-only' : (chunkPct < 100 ? 'hybrid-partial' : 'hybrid');
    return {
      results: finalResults,
      search_mode,
      model_state: this.gate.status.state,
      coverage: { chunk_pct: chunkPct, graph_coverage_pct: graphPct },
      ...(degradationReason ? { degradation_reason: degradationReason } : {}),
      ...(ftsUnsearchable ? { warning: 'query has no searchable terms for FTS' } : {}),
    };
  }

  // v3.6 (spec §5c / 6R note 2): why is vector search degraded right now?
  degradationReason(): 'disabled' | 'model_not_ready' | 'reconciling' | 'reconciliation_failed' | undefined {
    if (this.gate.isDisabled) return 'disabled';
    if (!this.gate.isReady) return 'model_not_ready';
    const rs = this.coordinator?.reconState;
    if (rs === 'failed') return 'reconciliation_failed';
    if (rs && rs !== 'complete' && rs !== 'n/a') return 'reconciling';
    return undefined;
  }

  // NEW: Get detailed context for a specific chunk
  async getDetailedContext(chunkId: string, includeSurrounding = true): Promise<DetailedContext> {
    if (!this.db) throw new Error('Database not initialized');
    
    console.error(`📖 Getting detailed context for chunk: ${chunkId}`);
    
    // Get the main chunk
    const chunk = this.db.prepare(`
      SELECT 
        m.chunk_id,
        m.document_id,
        m.chunk_index,
        m.text,
        d.content as doc_content,
        d.metadata as doc_metadata
      FROM chunk_metadata m
      JOIN documents d ON m.document_id = d.id
      WHERE m.chunk_id = ?
    `).get(chunkId) as {
      chunk_id: string;
      document_id: string;
      chunk_index: number;
      text: string;
      doc_content: string;
      doc_metadata: string;
    } | undefined;
    
    if (!chunk) {
      throw new Error(`Chunk with ID ${chunkId} not found`);
    }
    
    // Get entities for this chunk
    const entities = this.db.prepare(`
      SELECT e.name 
      FROM chunk_entities ce
      JOIN chunk_metadata m ON ce.chunk_rowid = m.rowid
      JOIN entities e ON e.id = ce.entity_id
      WHERE m.chunk_id = ?
    `).all(chunkId).map((row: any) => row.name);
    
    let surroundingChunks: Array<{ chunk_id: string; text: string; position: 'before' | 'after' }> = [];
    
    if (includeSurrounding) {
      // Get preceding and following chunks from the same document
      const beforeChunk = this.db.prepare(`
        SELECT chunk_id, text
        FROM chunk_metadata
        WHERE document_id = ? AND chunk_index = ?
      `).get(chunk.document_id, chunk.chunk_index - 1) as { chunk_id: string; text: string } | undefined;
      
      const afterChunk = this.db.prepare(`
        SELECT chunk_id, text
        FROM chunk_metadata
        WHERE document_id = ? AND chunk_index = ?
      `).get(chunk.document_id, chunk.chunk_index + 1) as { chunk_id: string; text: string } | undefined;
      
      if (beforeChunk) {
        surroundingChunks.push({
          chunk_id: beforeChunk.chunk_id,
          text: beforeChunk.text,
          position: 'before'
        });
      }
      
      if (afterChunk) {
        surroundingChunks.push({
          chunk_id: afterChunk.chunk_id,
          text: afterChunk.text,
          position: 'after'
        });
      }
    }
    
    const metadata = JSON.parse(chunk.doc_metadata);
    const documentTitle = metadata.title || metadata.name || chunk.document_id;
    
    console.error(`✅ Retrieved detailed context with ${surroundingChunks.length} surrounding chunks`);
    
    return {
      chunk_id: chunk.chunk_id,
      document_id: chunk.document_id,
      full_text: chunk.text,
      document_title: documentTitle,
      surrounding_chunks: surroundingChunks.length > 0 ? surroundingChunks : undefined,
      entities: entities,
      metadata: metadata
    };
  }

  async getKnowledgeGraphStats(): Promise<any> {
    if (!this.db) throw new Error('Database not initialized');
    
    const entityStats = this.db.prepare(`
      SELECT entityType, COUNT(*) as count
      FROM entities
      GROUP BY entityType
    `).all() as { entityType: string; count: number }[];
    
    const relationshipStats = this.db.prepare(`
      SELECT relationType, COUNT(*) as count
      FROM relationships
      GROUP BY relationType
    `).all() as { relationType: string; count: number }[];
    
    const documentCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM documents
    `).get() as { count: number };
    
    const chunkCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM chunk_metadata
    `).get() as { count: number };
    
    // v3.6 (spec §8-2, additive): server self-report — the framework's /start
    // reads version, model/reconciliation state, and provenance coverage here.
    const gs = this.gate.status;
    const cov = this.coordinator?.coverage();
    // v14 (spec §7.2): document 기준 chunking 전환 상태 — 상호배타, 합 = documents.
    // regex 분류는 SQL 밖(JS)에서: current = 런타임이 인식하는 c1 형식(강한 파서),
    // legacy = 'legacy-unknown', unknown = 그 외 전부.
    const sigRows = this.db.prepare(`SELECT chunking_signature AS s, count(*) AS n FROM documents GROUP BY chunking_signature`)
      .all() as Array<{ s: string; n: number }>;
    let sigCur = 0, sigLeg = 0, sigUnk = 0;
    for (const r of sigRows) {
      if (r.s === LEGACY_SIGNATURE) sigLeg += r.n;
      else if (isCurrentFormatSignature(r.s)) sigCur += r.n;
      else sigUnk += r.n;
    }
    return {
      entities: {
        total: entityStats.reduce((sum, stat) => sum + stat.count, 0),
        by_type: Object.fromEntries(entityStats.map(s => [s.entityType, s.count]))
      },
      relationships: {
        total: relationshipStats.reduce((sum, stat) => sum + stat.count, 0),
        by_type: Object.fromEntries(relationshipStats.map(s => [s.relationType, s.count]))
      },
      documents: documentCount.count,
      chunks: chunkCount.count,
      chunking: { current: sigCur, legacy: sigLeg, unknown: sigUnk,
                  default_signature: effectiveSignature(DEFAULT_MAX_TOKENS) },
      server: {
        version: PKG_VERSION,
        node: process.versions.node,
        // Which calendar produced the date-only labels in this database. Surfaced because a
        // wrong value is otherwise invisible: the labels look plausible either way.
        calendar_timezone: this.calendarTimeZone,
        embeddings_mode: this.embeddingsMode,
        model: `${EMBEDDING_MODEL}@${MODEL_REVISION}`,
        model_state: gs.state,
        ready_since: gs.readySince ?? null,
        last_error: gs.lastError ? sanitizeErrorMessage(gs.lastError) : null,
        retry_at: gs.retryAt ?? null,
        reconciliation_state: this.coordinator?.reconState ?? 'n/a',
        reconciliation_last_error: this.coordinator?.reconLastError ?? null,
        coverage: cov ? {
          chunk: { total: cov.chunk.total, embedded: cov.chunk.embedded, verified: cov.chunk.verified, legacy_assumed: cov.chunk.legacy_assumed, missing: cov.chunk.total - cov.chunk.embedded },
          entity: { total: cov.entity.total, embedded: cov.entity.embedded, verified: cov.entity.verified, legacy_assumed: cov.entity.legacy_assumed, missing: cov.entity.total - cov.entity.embedded },
        } : null,
      }
    };
  }

  // === GRAPH ANALYTICS TOOLS (graphology) ===

  private _buildGraphologyGraph(): { graph: Graph; entities: any[] } {
    if (!this.db) throw new Error('Database not initialized');

    const graph = new Graph({ type: 'undirected', allowSelfLoops: false });

    // Load entities as nodes
    const entities = this.db.prepare('SELECT id, name, entityType FROM entities').all() as any[];
    for (const entity of entities) {
      graph.addNode(entity.id, { name: entity.name, entityType: entity.entityType });
    }

    // Load relationships as edges
    const relations = this.db.prepare('SELECT id, source_entity, target_entity, relationType FROM relationships').all() as any[];
    for (const rel of relations) {
      if (graph.hasNode(rel.source_entity) && graph.hasNode(rel.target_entity)) {
        try {
          graph.addEdge(rel.source_entity, rel.target_entity, {
            relationType: rel.relationType,
            id: rel.id,
          });
        } catch (e) {
          // Skip duplicate edges (graphology undirected merges A→B and B→A)
        }
      }
    }

    return { graph, entities };
  }

  async getGraphMetrics(
    entityNames?: string[],
    metrics?: string[],
    limit: number = 10
  ): Promise<any> {
    if (!this.db) throw new Error('Database not initialized');

    const { graph } = this._buildGraphologyGraph();
    if (graph.order === 0) {
      return { metrics: {}, message: 'Knowledge graph is empty' };
    }

    const allMetrics = metrics || ['degree', 'betweenness', 'closeness', 'pagerank'];
    const result: Record<string, Record<string, number>> = {};

    if (allMetrics.includes('degree')) {
      result.degree = degree.degreeCentrality(graph);
    }
    if (allMetrics.includes('betweenness')) {
      result.betweenness = betweennessCentrality(graph);
    }
    if (allMetrics.includes('closeness')) {
      result.closeness = closenessCentrality(graph);
    }
    if (allMetrics.includes('pagerank')) {
      result.pagerank = pagerank(graph);
    }

    // Build id→name map
    const idToName = new Map<string, string>();
    graph.forEachNode((id: string, attrs: any) => {
      idToName.set(id, attrs.name);
    });

    // If specific entities requested, filter to those
    if (entityNames && entityNames.length > 0) {
      const targetIds = new Set<string>();
      for (const name of entityNames) {
        const id = `entity_${name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;
        if (graph.hasNode(id)) targetIds.add(id);
      }

      const filtered: Record<string, Record<string, number | null>> = {};
      for (const [metricName, scores] of Object.entries(result)) {
        filtered[metricName] = {};
        for (const id of targetIds) {
          const name = idToName.get(id) || id;
          filtered[metricName][name] = scores[id] ?? null;
        }
      }
      return { metrics: filtered, entityCount: graph.order, edgeCount: graph.size };
    }

    // Otherwise return top-N per metric
    const topResults: Record<string, Array<{ name: string; score: number }>> = {};
    for (const [metricName, scores] of Object.entries(result)) {
      const sorted = Object.entries(scores)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([id, score]) => ({
          name: idToName.get(id) || id,
          score: Math.round(score * 10000) / 10000,
        }));
      topResults[metricName] = sorted;
    }
    return { metrics: topResults, entityCount: graph.order, edgeCount: graph.size };
  }

  async detectCommunities(resolution: number = 1.0): Promise<any> {
    if (!this.db) throw new Error('Database not initialized');

    const { graph } = this._buildGraphologyGraph();
    if (graph.order === 0) {
      return { communities: [], modularity: 0, message: 'Knowledge graph is empty' };
    }

    // Run Louvain community detection — assign to node attributes
    louvain.assign(graph, { resolution });

    // Assign isolated nodes (Louvain skips degree-0 nodes)
    let maxCommunityId = -1;
    graph.forEachNode((id: string, attrs: any) => {
      if (typeof attrs.community === 'number' && attrs.community > maxCommunityId) {
        maxCommunityId = attrs.community;
      }
    });
    graph.forEachNode((id: string, attrs: any) => {
      if (attrs.community === undefined) {
        graph.setNodeAttribute(id, 'community', ++maxCommunityId);
      }
    });

    // Build id→name map
    const idToName = new Map<string, string>();
    graph.forEachNode((id: string, attrs: any) => {
      idToName.set(id, attrs.name);
    });

    // Group entities by community
    const communityMap = new Map<number, Array<{ name: string; entityType: string }>>();
    graph.forEachNode((nodeId: string, attrs: any) => {
      const communityId = attrs.community as number;
      if (!communityMap.has(communityId)) {
        communityMap.set(communityId, []);
      }
      communityMap.get(communityId)!.push({
        name: idToName.get(nodeId) || nodeId,
        entityType: attrs.entityType,
      });
    });

    // Sort communities by size (largest first)
    const sortedCommunities = [...communityMap.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([_id, members], index) => ({
        communityId: index,
        size: members.length,
        members: members.sort((a, b) => a.name.localeCompare(b.name)),
      }));

    // Calculate modularity (reads 'community' attribute from nodes)
    const modularityScore = modularity(graph);

    // Cross-community edges
    let crossEdges = 0;
    graph.forEachEdge((_edge: string, _attrs: any, source: string, target: string) => {
      const srcCommunity = graph.getNodeAttribute(source, 'community');
      const tgtCommunity = graph.getNodeAttribute(target, 'community');
      if (srcCommunity !== tgtCommunity) crossEdges++;
    });

    return {
      communities: sortedCommunities,
      totalCommunities: sortedCommunities.length,
      modularity: Math.round(modularityScore * 10000) / 10000,
      crossCommunityEdges: crossEdges,
      entityCount: graph.order,
      edgeCount: graph.size,
    };
  }

  async analyzeGraphStructure(): Promise<any> {
    if (!this.db) throw new Error('Database not initialized');

    const { graph } = this._buildGraphologyGraph();
    if (graph.order === 0) {
      return { message: 'Knowledge graph is empty', entityCount: 0, edgeCount: 0 };
    }

    // Density
    const density = graph.size > 0
      ? (2 * graph.size) / (graph.order * (graph.order - 1))
      : 0;

    // Degree distribution
    const degrees: number[] = [];
    const isolatedNodes: string[] = [];
    graph.forEachNode((id: string, attrs: any) => {
      const deg = graph.degree(id);
      degrees.push(deg);
      if (deg === 0) isolatedNodes.push(attrs.name);
    });
    degrees.sort((a, b) => a - b);
    const avgDegree = degrees.reduce((s, d) => s + d, 0) / degrees.length;
    const medianDegree = degrees[Math.floor(degrees.length / 2)];

    // Connected components (BFS)
    const visited = new Set<string>();
    const components: string[][] = [];
    graph.forEachNode((startId: string) => {
      if (visited.has(startId)) return;
      const component: string[] = [];
      const queue: string[] = [startId];
      visited.add(startId);
      while (queue.length > 0) {
        const nodeId = queue.shift()!;
        component.push(graph.getNodeAttribute(nodeId, 'name'));
        graph.forEachNeighbor(nodeId, (neighbor: string) => {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        });
      }
      components.push(component);
    });
    components.sort((a, b) => b.length - a.length);

    // Relationship type distribution
    const relTypeCount: Record<string, number> = {};
    graph.forEachEdge((_edge: string, attrs: any) => {
      const type = attrs.relationType || 'UNKNOWN';
      relTypeCount[type] = (relTypeCount[type] || 0) + 1;
    });

    // Average clustering coefficient
    let totalClustering = 0;
    let clusterableNodes = 0;
    graph.forEachNode((nodeId: string) => {
      const neighbors = graph.neighbors(nodeId);
      if (neighbors.length < 2) return;
      let triangles = 0;
      for (let i = 0; i < neighbors.length; i++) {
        for (let j = i + 1; j < neighbors.length; j++) {
          if (graph.hasEdge(neighbors[i], neighbors[j])) triangles++;
        }
      }
      const possibleTriangles = (neighbors.length * (neighbors.length - 1)) / 2;
      totalClustering += triangles / possibleTriangles;
      clusterableNodes++;
    });
    const avgClustering = clusterableNodes > 0 ? totalClustering / clusterableNodes : 0;

    return {
      entityCount: graph.order,
      edgeCount: graph.size,
      density: Math.round(density * 10000) / 10000,
      connectedComponents: {
        count: components.length,
        largest: components[0]?.length || 0,
        sizes: components.map(c => c.length),
        isolatedNodes,
      },
      degreeDistribution: {
        min: degrees[0],
        max: degrees[degrees.length - 1],
        avg: Math.round(avgDegree * 100) / 100,
        median: medianDegree,
      },
      averageClusteringCoefficient: Math.round(avgClustering * 10000) / 10000,
      relationshipTypes: relTypeCount,
    };
  }

  // === MIGRATION TOOLS ===

  async getMigrationStatus(): Promise<{ currentVersion: number; migrations: Array<{ version: number; description: string; applied: boolean; applied_at?: string }>; pendingCount: number }> {
    if (!this.db) throw new Error('Database not initialized');
    
    const migrationManager = new MigrationManager(this.db);
    
    // Add all migrations
    migrations.forEach(migration => {
      migrationManager.addMigration(migration);
    });
    
    const currentVersion = migrationManager.getCurrentVersion();
    const allMigrations = migrationManager.listMigrations();
    const pendingCount = allMigrations.filter(m => !m.applied).length;
    
    return {
      currentVersion,
      migrations: allMigrations,
      pendingCount
    };
  }



  async rollbackMigration(targetVersion: number): Promise<{ rolledBack: number; currentVersion: number; rolledBackMigrations: Array<{ version: number; description: string }>; semanticRollback?: boolean; warning?: string }> {
    if (!this.db) throw new Error('Database not initialized');
    
    const migrationManager = new MigrationManager(this.db);
    
    // Add all migrations
    migrations.forEach(migration => {
      migrationManager.addMigration(migration);
    });
    
    const currentVersion = migrationManager.getCurrentVersion();
    
    if (targetVersion >= currentVersion) {
      return {
        rolledBack: 0,
        currentVersion,
        rolledBackMigrations: []
      };
    }
    
    const migrationsToRollback = migrations
      .filter(m => m.version > targetVersion && m.version <= currentVersion)
      .sort((a, b) => b.version - a.version);
    
    migrationManager.rollback(targetVersion);

    const result = {
      rolledBack: migrationsToRollback.length,
      currentVersion: migrationManager.getCurrentVersion(),
      rolledBackMigrations: migrationsToRollback.map(m => ({
        version: m.version,
        description: m.description
      }))
    };
    // v14 rollback is a compatibility rollback ONLY (spec §6.3): dropping the
    // chunking_signature column does not restore old chunk boundaries — c1 rows
    // read fine on v13 code. Say so in the RESPONSE, not just the tool
    // description, so a caller who rolled back sees the limit (advisor r5-10).
    if (result.rolledBackMigrations.some(m => m.version === 14)) {
      return {
        ...result,
        semanticRollback: false,
        warning: 'v14 rollback removes the chunking_signature column only; chunk boundaries produced by chunker c1 are NOT restored (compatibility rollback). Data restore path = pre-migration backup snapshot.'
      };
    }
    return result;
  }
}

// Initialize the manager
const ragKgManager = new RAGKnowledgeGraphManager();

// MCP Server setup
const server = new Server({
  name: "rag-memory-server",
  version: PKG_VERSION,
}, {
    capabilities: {
      tools: {},
    },
});

// Use our new structured tool system for listing tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = getAllMCPTools();
  console.error(`📋 Serving ${tools.length} tools with comprehensive documentation`);
  return { tools };
});

// Enhanced tool call handler with validation
server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new Error(`No arguments provided for tool: ${name}`);
  }

  try {
    // Validate arguments using our structured schema
    const validatedArgs = validateToolArgs(name, args);
    
    switch (name) {
      // Original MCP tools
      case "createEntities":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.createEntities((validatedArgs as any).entities as Array<Entity & { status?: 'active' | 'provisional'; sources?: SourceInput[] }>), null, 2) }] };
      case "createRelations":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.createRelations((validatedArgs as any).relations as Relation[]), null, 2) }] };
      case "addObservations":
        // v13: status·sources 를 그대로 넘긴다. 여기서 떨어뜨리면 스키마가 받아도
        // 엔진에 도달하지 않아 provenance 가 조용히 사라진다.
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.addObservations((validatedArgs as any).observations as { entityName: string; contents: string[]; status?: 'active' | 'provisional'; sources?: SourceInput[] }[]), null, 2) }] };

      // v13 observation lifecycle (spec §6.1 / §6.2)
      case "correctObservation":
        return { content: [{ type: "text", text: JSON.stringify({ observation_id: await ragKgManager.correctObservation(
          (validatedArgs as any).observation_id as string,
          (validatedArgs as any).content as string,
          (validatedArgs as any).change_kind ?? 'correction',
          (validatedArgs as any).reason
        ) }, null, 2) }] };
      case "retractObservation":
        await ragKgManager.retractObservation((validatedArgs as any).observation_id as string, (validatedArgs as any).reason);
        return { content: [{ type: "text", text: JSON.stringify({ observation_id: (validatedArgs as any).observation_id, status: 'retracted' }, null, 2) }] };
      case "restoreObservation":
        await ragKgManager.restoreObservation((validatedArgs as any).observation_id as string, (validatedArgs as any).reason);
        return { content: [{ type: "text", text: JSON.stringify({ observation_id: (validatedArgs as any).observation_id, status: 'active' }, null, 2) }] };
      case "approveObservation":
        await ragKgManager.approveObservation((validatedArgs as any).observation_id as string, (validatedArgs as any).reason);
        return { content: [{ type: "text", text: JSON.stringify({ observation_id: (validatedArgs as any).observation_id, status: 'active' }, null, 2) }] };
      case "declineObservation":
        await ragKgManager.declineObservation((validatedArgs as any).observation_id as string, (validatedArgs as any).reason as string);
        return { content: [{ type: "text", text: JSON.stringify({ observation_id: (validatedArgs as any).observation_id, status: 'retracted' }, null, 2) }] };
      case "purgeObservation":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.purgeObservation((validatedArgs as any).observation_id as string, (validatedArgs as any).confirm as string), null, 2) }] };
      case "getObservationHistory":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.getObservationHistory({
          entity_name: (validatedArgs as any).entity_name,
          observation_id: (validatedArgs as any).observation_id,
          root_id: (validatedArgs as any).root_id,
        }), null, 2) }] };

      case "deleteEntities":
        await ragKgManager.deleteEntities((validatedArgs as any).entityNames as string[]);
        return { content: [{ type: "text", text: "Entities deleted successfully" }] };
      case "deleteObservations":
        // v3.6 (spec §5c, breaking): structured per-entity results replace the
        // bare success string — mixed embedded/queued/no-op states are visible.
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.deleteObservations((validatedArgs as any).deletions as { entityName: string; observations: string[] }[]), null, 2) }] };
      case "deleteRelations":
        await ragKgManager.deleteRelations((validatedArgs as any).relations as Relation[]);
        return { content: [{ type: "text", text: "Relations deleted successfully" }] };
      case "updateRelations":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.updateRelations((validatedArgs as any).updates), null, 2) }] };
      case "readGraph":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.readGraph(), null, 2) }] };
      case "searchNodes":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.searchNodes((validatedArgs as any).query as string, (validatedArgs as any).limit || 10, (validatedArgs as any).since, (validatedArgs as any).until), null, 2) }] };
      case "openNodes":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.openNodes((validatedArgs as any).names as string[]), null, 2) }] };
      case "getNeighbors":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.getNeighbors(
          (validatedArgs as any).entityNames as string[],
          (validatedArgs as any).depth || 1,
          (validatedArgs as any).relationType
        ), null, 2) }] };

      // New RAG tools
      case "storeDocument":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.storeDocument((validatedArgs as any).id as string, (validatedArgs as any).content as string, (validatedArgs as any).metadata || {}), null, 2) }] };
      case "chunkDocument":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.chunkDocument((validatedArgs as any).documentId as string, { maxTokens: (validatedArgs as any).maxTokens, overlap: (validatedArgs as any).overlap }), null, 2) }] };
      case "embedChunks":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.embedChunks((validatedArgs as any).documentId as string), null, 2) }] };
      case "extractTerms":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.extractTerms((validatedArgs as any).documentId as string, { minLength: (validatedArgs as any).minLength, includeCapitalized: (validatedArgs as any).includeCapitalized, customPatterns: (validatedArgs as any).customPatterns }), null, 2) }] };
      case "linkEntitiesToDocument":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.linkEntitiesToDocument((validatedArgs as any).documentId as string, (validatedArgs as any).entityNames as string[]), null, 2) }] };
      case "hybridSearch":
        const limit = typeof (validatedArgs as any).limit === 'number' ? (validatedArgs as any).limit : 5;
        // v5.3.0: graph is opt-in — only an explicit true enables the re-ranker (schema default false).
        const useGraph = (validatedArgs as any).useGraph === true;
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.hybridSearch((validatedArgs as any).query as string, limit, useGraph), null, 2) }] };
      case "getDetailedContext":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.getDetailedContext((validatedArgs as any).chunkId as string, (validatedArgs as any).includeSurrounding !== false), null, 2) }] };
      case "getKnowledgeGraphStats":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.getKnowledgeGraphStats(), null, 2) }] };
      case "deleteDocuments":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.deleteDocuments((validatedArgs as any).documentIds as string | string[]), null, 2) }] };
      case "listDocuments":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.listDocuments((validatedArgs as any).includeMetadata !== false), null, 2) }] };
      case "syncDocumentFromFile":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.syncDocumentFromFile(
          (validatedArgs as any).path as string,
          (validatedArgs as any).documentId as string,
          {
            metadata: (validatedArgs as any).metadata,
            content: (validatedArgs as any).content,
            excludePattern: (validatedArgs as any).excludePattern,
            entityNames: (validatedArgs as any).entityNames,
            chunkParams: (validatedArgs as any).chunkParams,
          }
        ), null, 2) }] };

      // NEW: Entity embedding tools
      case "embedAllEntities":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.embedAllEntities(), null, 2) }] };

      // NEW: Export/Import tools
      case "exportGraph":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.exportGraph(), null, 2) }] };
      case "importGraph":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.importGraph((validatedArgs as any).data, { merge: (validatedArgs as any).merge !== false }), null, 2) }] };

      // NEW: Migration tools
      case "getMigrationStatus":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.getMigrationStatus(), null, 2) }] };
      case "runMigrations":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.runMigrations(), null, 2) }] };
      case "rollbackMigration":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.rollbackMigration((validatedArgs as any).targetVersion as number), null, 2) }] };

      // Graph Analytics tools (graphology)
      case "getGraphMetrics":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.getGraphMetrics((validatedArgs as any).entityNames, (validatedArgs as any).metrics, (validatedArgs as any).limit || 10), null, 2) }] };
      case "detectCommunities":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.detectCommunities((validatedArgs as any).resolution || 1.0), null, 2) }] };
      case "analyzeGraphStructure":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.analyzeGraphStructure(), null, 2) }] };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    // v3.6 (spec §5c): machine-distinguishable failures. Embedding-gate errors
    // become structured retryable/terminal payloads; every error response now
    // sets isError so clients stop parsing "Error: ..." strings.
    if (error instanceof GateNotReadyError) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({
        code: error.code, state: error.state,
        ...(error.retryAfterMs !== undefined ? { retry_after_ms: error.retryAfterMs } : {}),
        message: error.message }) }] };
    }
    if (error instanceof GateDisabledError) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({
        code: error.code, state: error.state, message: error.message }) }] };
    }
    if (error instanceof Error) {
      console.error(`❌ Tool execution error for ${name}:`, error.message);
      return { isError: true, content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
    throw error;
  }
});

async function main() {
  try {
    assertNodeVersion();
    await ragKgManager.initialize();
    printBanner({
      model: EMBEDDING_MODEL, revision: MODEL_REVISION, dtype: MODEL_DTYPE,
      cachePath: resolveModelCacheDir(process.env, process.platform, os.homedir()),
      dbPath: DB_FILE_PATH,
    });

    if (ragKgManager.embeddingsMode === 'eager') {
      // eager = wait for BOTH the first model load attempt and reconciliation to
      // settle (success or failure) before connecting — v3.5-equivalent boot
      // extended to legacy DBs (spec §9). Failures fall back to background retry.
      await Promise.allSettled([ragKgManager.gate.start(), ragKgManager.startReconciliation()]);
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🚀 Enhanced RAG Knowledge Graph MCP Server running on stdio");

    if (ragKgManager.embeddingsMode === 'lazy') {
      // Background: model load + provenance reconciliation run in parallel.
      // Failures surface via gate/coordinator state, never as rejections.
      void ragKgManager.gate.start().catch(() => {});
      void ragKgManager.startReconciliation().catch(() => {});
    } else if (ragKgManager.embeddingsMode === 'off') {
      // off mode still CLASSIFIES reconciliation state (deferred vs n/a) so
      // stats honor the mode matrix — no sanitation, no inference (beta B7).
      void ragKgManager.startReconciliation().catch(() => {});
    }

    // Graceful shutdown (spec §3 order, beta-2R-amended) — transport close
    // FIRST so stdin stops holding the event loop, then settle coordinator and
    // gate, then DB close. process.exit is forbidden EXCEPT the one spec'd
    // case: a model load/download still pending after the settle deadline
    // (un-abortable fetch would hold the loop forever) — see shutdownAll.
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async () => {
        try { await server.close(); } catch { /* transport already gone */ }
        try { process.stdin.pause(); process.stdin.unref?.(); } catch { /* best-effort */ }
        await ragKgManager.shutdownAll();
      })();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('exit', () => { try { ragKgManager.cleanup(); } catch { /* idempotent */ } });
    console.error('🛡️ shutdown handlers registered'); // deterministic handler-ready marker (5R test residual)
  } catch (error) {
    console.error("Failed to initialize server:", error);
    try { ragKgManager.cleanup(); } catch { /* already down */ }
    process.exitCode = 1;
  }
}

// Boot the server unless explicitly suppressed. Tests import this module with
// RAG_MEMORY_NO_AUTOSTART=1 to access the class without starting the stdio server.
// (An argv-vs-import.meta.url comparison is unreliable: npx/bin launches the entry
// via a symlinked path, so the two never match and main() silently skips → the
// MCP client cannot connect. v3.5.0 shipped that bug; env-var opt-out is robust.)
if (process.env.RAG_MEMORY_NO_AUTOSTART !== '1') {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    try { ragKgManager.cleanup(); } catch { /* already down */ }
    process.exitCode = 1;
  });
}
