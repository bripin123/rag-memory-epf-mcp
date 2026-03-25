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

// Import our new structured tool system
import { getAllMCPTools, validateToolArgs, getSystemInfo } from './src/tools/tool-registry.js';

// Import migration system
import { MigrationManager } from './src/migrations/migration-manager.js';
import { migrations } from './src/migrations/migrations.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const PKG_VERSION: string = require('./package.json').version;

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
  start_pos: number;
  end_pos: number;
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
function safeRowid(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid rowid: ${value}`);
  }
  return n;
}

// Enhanced RAG-enabled Knowledge Graph Manager
class RAGKnowledgeGraphManager {
  private db: Database.Database | null = null;
  private encoding: any = null;
  private embeddingModel: any = null;
  private modelInitialized: boolean = false;
  private embeddingCache: Map<string, Float32Array> = new Map();
  private readonly EMBEDDING_CACHE_MAX = 500;
  private dictionaryCache: { nativeToEn: Record<string, string>; enToNative: Record<string, string> } | null = null;

  async initialize() {
    console.error('🚀 Initializing RAG Knowledge Graph MCP Server...');

    // Initialize database
    this.db = new Database(DB_FILE_PATH);

    // Load sqlite-vec extension
    sqliteVec.load(this.db);

    // SQLite performance & safety optimizations
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('cache_size = -32000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('mmap_size = 268435456');
    this.db.pragma('foreign_keys = ON');

    // Initialize tiktoken
    this.encoding = get_encoding("cl100k_base");

    // Initialize embedding model
    await this.initializeEmbeddingModel();

    // Run database migrations
    await this.runMigrations();

    console.error('✅ RAG-enabled knowledge graph initialized');
    
    // Log system info
    const systemInfo = getSystemInfo();
    console.error(`📊 System Info: ${systemInfo.toolCounts.total} tools available (${systemInfo.toolCounts.knowledgeGraph} knowledge graph, ${systemInfo.toolCounts.rag} RAG, ${systemInfo.toolCounts.graphQuery} query)`);
  }

  private async initializeEmbeddingModel() {
    try {
      console.error(`🤖 Loading embedding model: ${EMBEDDING_MODEL} (1024-dim, 100+ languages)...`);

      // Configure environment to allow remote model downloads
      env.allowRemoteModels = true;
      env.allowLocalModels = true;

      this.embeddingModel = await pipeline(
        'feature-extraction',
        EMBEDDING_MODEL,
        {
          revision: 'main',
          dtype: 'fp16',
        }
      );

      this.modelInitialized = true;
      console.error(`✅ ${EMBEDDING_MODEL} model loaded successfully`);
      
    } catch (error) {
      console.error('❌ Failed to load embedding model:', error);
      console.error('📋 Falling back to simple embedding generation');
      this.modelInitialized = false;
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
    if (this.embeddingModel) {
      // Clean up the embedding model if it has cleanup methods
      this.embeddingModel = null;
      this.modelInitialized = false;
    }
    this.embeddingCache.clear();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // === ORIGINAL MCP FUNCTIONALITY ===

  private _timestampObservation(obs: string): string {
    // If observation already has a date prefix like [2026-03-21], skip
    if (/^\[\d{4}-\d{2}-\d{2}\]/.test(obs)) return obs;
    const today = new Date().toISOString().slice(0, 10);
    return `[${today}] ${obs}`;
  }

  async createEntities(entities: Entity[]): Promise<Entity[]> {
    if (!this.db) throw new Error('Database not initialized');

    const result: Entity[] = [];
    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO entities (id, name, entityType, observations, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const entity of entities) {
      const entityId = `entity_${entity.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      const timestamped = (entity.observations || []).map(o => this._timestampObservation(o));

      // Try insert first
      const insertResult = insertStmt.run(entityId, entity.name, entity.entityType, JSON.stringify(timestamped), '{}');

      if (insertResult.changes > 0) {
        // New entity created
        result.push({ ...entity, observations: timestamped });
        console.error(`🔮 Generating embedding for new entity: ${entity.name}`);
        await this.embedEntity(entityId);
      } else {
        // Entity already exists — upsert: merge observations and update entityType
        const existing = this.db.prepare(`SELECT observations, entityType FROM entities WHERE id = ?`)
          .get(entityId) as { observations: string; entityType: string } | undefined;

        if (existing) {
          const currentObs: string[] = JSON.parse(existing.observations);
          // Strip date prefix for dedup comparison
          const stripDate = (s: string) => s.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '');
          const currentBare = new Set(currentObs.map(stripDate));
          const newObs = timestamped.filter(o => !currentBare.has(stripDate(o)));
          const needsTypeUpdate = entity.entityType && entity.entityType !== 'CONCEPT' && entity.entityType !== existing.entityType;

          if (newObs.length > 0 || needsTypeUpdate) {
            const mergedObs = [...currentObs, ...newObs];
            const updatedType = needsTypeUpdate ? entity.entityType : existing.entityType;
            this.db.prepare(`UPDATE entities SET observations = ?, entityType = ? WHERE id = ?`)
              .run(JSON.stringify(mergedObs), updatedType, entityId);

            console.error(`♻️ Upserted entity: ${entity.name} (+${newObs.length} obs${needsTypeUpdate ? ', type→' + updatedType : ''})`);
            await this.embedEntity(entityId);
            result.push({ ...entity, observations: mergedObs });
          }
        }
      }
    }

    return result;
  }

  async createRelations(relations: Relation[]): Promise<Relation[]> {
    if (!this.db) throw new Error('Database not initialized');
    
    const newRelations = [];
    
    for (const relation of relations) {
      // Ensure entities exist
      await this.createEntities([
        { name: relation.from, entityType: 'CONCEPT', observations: [] },
        { name: relation.to, entityType: 'CONCEPT', observations: [] }
      ]);
      
      const sourceId = `entity_${relation.from.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      const targetId = `entity_${relation.to.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      const relationId = `rel_${sourceId}_${relation.relationType}_${targetId}`.toLowerCase();
      
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO relationships 
        (id, source_entity, target_entity, relationType, confidence, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      const result = stmt.run(relationId, sourceId, targetId, relation.relationType, 1.0, '{}');
      if (result.changes > 0) {
        newRelations.push(relation);
      }
    }

    return newRelations;
  }

  async addObservations(observations: { entityName: string; contents: string[] }[]): Promise<{ entityName: string; addedObservations: string[] }[]> {
    if (!this.db) throw new Error('Database not initialized');
    
    const results = [];
    
    for (const obs of observations) {
      const entityId = `entity_${obs.entityName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      
      // Get current observations
      const entity = this.db.prepare(`
        SELECT observations FROM entities WHERE id = ?
      `).get(entityId) as { observations: string } | undefined;
      
      if (!entity) {
        throw new Error(`Entity with name ${obs.entityName} not found`);
      }
      
      const currentObservations: string[] = JSON.parse(entity.observations);
      const stripDate = (s: string) => s.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '');
      const currentBare = new Set(currentObservations.map(stripDate));
      const timestamped = obs.contents.map(c => this._timestampObservation(c));
      const newObservations = timestamped.filter(c => !currentBare.has(stripDate(c)));

      if (newObservations.length > 0) {
        const updatedObservations = [...currentObservations, ...newObservations];
        
        this.db.prepare(`
          UPDATE entities SET observations = ? WHERE id = ?
        `).run(JSON.stringify(updatedObservations), entityId);
        
        // Regenerate embedding for the updated entity
        console.error(`🔮 Regenerating embedding for updated entity: ${obs.entityName}`);
        await this.embedEntity(entityId);
      }
      
      results.push({ entityName: obs.entityName, addedObservations: newObservations });
    }

    return results;
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    
    console.error(`🗑️ Deleting entities: ${entityNames.join(', ')}`);
    
    for (const name of entityNames) {
      const entityId = `entity_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      
      try {
        // Check if entity exists first
        const entityExists = this.db.prepare(`
          SELECT id FROM entities WHERE id = ?
        `).get(entityId);
        
        if (!entityExists) {
          console.warn(`⚠️ Entity '${name}' not found, skipping`);
          continue;
        }
        
        // Step 0: Delete entity embeddings
        const embeddingMetadata = this.db.prepare(`
          SELECT rowid FROM entity_embedding_metadata WHERE entity_id = ?
        `).get(entityId) as { rowid: number } | undefined;
        
        if (embeddingMetadata) {
          const embeddings = this.db.prepare(`
            DELETE FROM entity_embeddings WHERE rowid = ?
          `).run(embeddingMetadata.rowid);
          
          const metadata = this.db.prepare(`
            DELETE FROM entity_embedding_metadata WHERE entity_id = ?
          `).run(entityId);
          
          if (embeddings.changes > 0 || metadata.changes > 0) {
            console.error(`  ├─ Removed entity embeddings for '${name}'`);
          }
        }
        
        // Step 1: Delete chunk-entity associations
        const chunkAssociations = this.db.prepare(`
          DELETE FROM chunk_entities WHERE entity_id = ?
        `).run(entityId);
        if (chunkAssociations.changes > 0) {
          console.error(`  ├─ Removed ${chunkAssociations.changes} chunk associations for '${name}'`);
        }
        
        // Step 2: Delete relationships where this entity is involved
        const relationships = this.db.prepare(`
          DELETE FROM relationships 
          WHERE source_entity = ? OR target_entity = ?
        `).run(entityId, entityId);
        if (relationships.changes > 0) {
          console.error(`  ├─ Removed ${relationships.changes} relationships for '${name}'`);
        }
        
        // Step 3: Finally delete the entity itself
        const entity = this.db.prepare(`
          DELETE FROM entities WHERE id = ?
        `).run(entityId);
        if (entity.changes > 0) {
          console.error(`  └─ Deleted entity '${name}' successfully`);
        } else {
          console.warn(`  └─ Entity '${name}' was not deleted (possibly already removed)`);
        }
        
      } catch (error) {
        console.error(`❌ Failed to delete entity '${name}':`, error);
        // Continue with other entities instead of failing completely
      }
    }
    
    console.error(`✅ Entity deletion process completed`);
  }

  async deleteObservations(deletions: { entityName: string; observations: string[] }[]): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    
    for (const deletion of deletions) {
      const entityId = `entity_${deletion.entityName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      
      const entity = this.db.prepare(`
        SELECT observations FROM entities WHERE id = ?
      `).get(entityId) as { observations: string } | undefined;
      
      if (entity) {
        const currentObservations = JSON.parse(entity.observations);
        const filteredObservations = currentObservations.filter(
          (obs: string) => !deletion.observations.includes(obs)
        );
        
        this.db.prepare(`
          UPDATE entities SET observations = ? WHERE id = ?
        `).run(JSON.stringify(filteredObservations), entityId);
      }
    }
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    for (const relation of relations) {
      const sourceId = `entity_${relation.from.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      const targetId = `entity_${relation.to.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

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
      const sourceId = `entity_${update.from.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      const targetId = `entity_${update.to.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
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
    const seedIds = entityNames.map(name => `entity_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`);

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

  async searchNodes(query: string, limit = 10, since?: string, until?: string): Promise<KnowledgeGraph> {
    if (!this.db) throw new Error('Database not initialized');

    console.error(`🔍 Semantic entity search: "${query}"`);

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

    if (filteredResults.length === 0) {
      console.error(`ℹ️ No semantic matches found for "${query}"`);
      return { entities: [], relations: [] };
    }

    const entities = filteredResults.map(result => ({
      name: result.name,
      entityType: result.entityType,
      observations: JSON.parse(result.observations),
      similarity: Math.max(0, 1 - result.distance / 2) // Convert cosine distance (0-2) to similarity (1-0)
    }));
    
    // Get relationships between the found entities
    const entityNames = entities.map(e => e.name);
    const relations = this.db.prepare(`
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

    console.error(`✅ Found ${entities.length} semantically similar entities with ${relations.length} relationships`);
    
    return { entities, relations };
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

  // Generate embedding text for an entity (combines name, type, and observations)
  private generateEntityEmbeddingText(entity: { name: string; entityType: string; observations: string[] }): string {
    const observationsText = entity.observations.join('\n- ');
    return `${entity.name} [${entity.entityType}]\n- ${observationsText}`.trim();
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
  private async embedEntity(entityId: string): Promise<boolean> {
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
    const embeddingText = this.generateEntityEmbeddingText({
      name: entity.name,
      entityType: entity.entityType,
      observations: parsedObservations
    });
    
    // Generate embedding
    const embedding = await this.generateEmbedding(embeddingText);
    
    try {
      // Delete existing embedding if any
      const existingMetadata = this.db.prepare(`
        SELECT rowid FROM entity_embedding_metadata WHERE entity_id = ?
      `).get(entityId) as { rowid: number } | undefined;
      
      if (existingMetadata) {
        this.db.prepare(`DELETE FROM entity_embeddings WHERE rowid = ?`).run(existingMetadata.rowid);
        this.db.prepare(`DELETE FROM entity_embedding_metadata WHERE entity_id = ?`).run(entityId);
      }
      
      // Insert new embedding
      const result = this.db.prepare(`
        INSERT INTO entity_embeddings (embedding) VALUES (?)
      `).run(Buffer.from(embedding.buffer));
      
      // Store metadata
      this.db.prepare(`
        INSERT INTO entity_embedding_metadata (rowid, entity_id, embedding_text)
        VALUES (?, ?, ?)
      `).run(result.lastInsertRowid, entityId, embeddingText);
      
      return true;
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
      const embedding = await this.generateEmbedding(chunk.text);
      const rowid = safeRowid(chunk.rowid);

      try {
        // Delete existing embedding if any
        this.db.exec(`DELETE FROM chunks WHERE rowid = ${rowid}`);

        // Insert new embedding - rowid as literal integer for vec0 compatibility
        this.db.prepare(`
          INSERT INTO chunks (rowid, embedding) VALUES (${rowid}, ?)
        `).run(Buffer.from(embedding.buffer));

        embeddedCount++;
      } catch (error) {
        const errMsg = `chunk ${chunk.chunk_id} (rowid=${rowid}, type=${typeof chunk.rowid}): ${error instanceof Error ? error.message : String(error)}`;
        console.error(`Failed to embed ${errMsg}`);
        errors.push(errMsg);
      }
    }

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
  private chunkText(text: string, maxTokens = 800, overlap = 160): Chunk[] {
    if (!this.encoding) throw new Error('Tokenizer not initialized');
    
    const tokens = this.encoding.encode(text);
    const chunks: Chunk[] = [];
    
    for (let i = 0; i < tokens.length; i += maxTokens - overlap) {
      const chunkTokens = tokens.slice(i, i + maxTokens);
      const decodedBytes = this.encoding.decode(chunkTokens);
      const chunkText = new TextDecoder().decode(decodedBytes);
      
      chunks.push({
        id: '',
        document_id: '',
        chunk_index: chunks.length,
        text: chunkText,
        start_pos: i,
        end_pos: i + chunkTokens.length
      });
    }
    
    return chunks;
  }

  // Generate embeddings using sentence transformers
  // isQuery: true for search queries (adds instruction prefix), false for documents/entities
  private async generateEmbedding(text: string, dimensions = 1024, isQuery = false): Promise<Float32Array> {
    // Check cache first
    const cacheKey = `${text.length > 100 ? text.substring(0, 100) : text}_${dimensions}_${isQuery}`;
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) return cached;

    if (this.modelInitialized && this.embeddingModel) {
      try {
        // BGE-M3: no instruction prefix needed, cls pooling
        const inputText = text;
        const result = await this.embeddingModel(inputText, { pooling: 'cls', normalize: true });
        
        // Extract the embedding array and convert to Float32Array
        const embedding = result.data;
        const modelResult = new Float32Array(embedding.slice(0, dimensions));
        // Cache the result (LRU: evict oldest if full)
        if (this.embeddingCache.size >= this.EMBEDDING_CACHE_MAX) {
          const firstKey = this.embeddingCache.keys().next().value;
          if (firstKey) this.embeddingCache.delete(firstKey);
        }
        this.embeddingCache.set(cacheKey, modelResult);
        return modelResult;
        
      } catch (error) {
        console.error(`⚠️ Embedding model failed for text "${text.slice(0, 50)}...":`, error instanceof Error ? error.message : error);
        // Fall through to enhanced general implementation
      }
    }
    
    // Enhanced general-purpose semantic embedding
    const embedding = new Array(dimensions).fill(0);
    
    // Normalize and tokenize text (preserve Unicode letters including Korean, Arabic, etc.)
    const normalizedText = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    const words = normalizedText.split(' ').filter(word => word.length > 1);
    
    if (words.length === 0) {
      const emptyResult = new Float32Array(embedding);
      // Cache the result (LRU: evict oldest if full)
      if (this.embeddingCache.size >= this.EMBEDDING_CACHE_MAX) {
        const firstKey = this.embeddingCache.keys().next().value;
        if (firstKey) this.embeddingCache.delete(firstKey);
      }
      this.embeddingCache.set(cacheKey, emptyResult);
      return emptyResult;
    }
    
    // Enhanced word importance calculation
    const wordFreq = new Map<string, number>();
    const wordPositions = new Map<string, number[]>();
    
    words.forEach((word, position) => {
      wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
      if (!wordPositions.has(word)) {
        wordPositions.set(word, []);
      }
      wordPositions.get(word)!.push(position);
    });
    
    const totalWords = words.length;
    const uniqueWords = wordFreq.size;
    const vocabulary = Array.from(wordFreq.keys());
    
    // Create enhanced semantic features for each unique word
    vocabulary.forEach(word => {
      const freq = wordFreq.get(word) || 1;
      const positions = wordPositions.get(word) || [];
      
      // Enhanced TF-IDF calculation
      const tf = freq / totalWords;
      const idf = Math.log(totalWords / freq); // More aggressive IDF for rare words
      const tfidf = tf * idf;
      
      // Multi-position importance (average of all positions)
      const avgPosition = positions.reduce((sum, pos) => sum + pos, 0) / positions.length;
      const positionWeight = this.calculatePositionWeight(avgPosition, totalWords);
      
      // Word characteristics for semantic diversity
      const wordLength = word.length;
      const vowelCount = (word.match(/[aeiou]/g) || []).length;
      const consonantCount = wordLength - vowelCount;
      const vowelRatio = vowelCount / wordLength;
      const hasCapitals = /[A-Z]/.test(word);
      const hasNumbers = /\d/.test(word);
      
      // Word complexity indicators
      const isLongWord = wordLength > 6;
      const isRareWord = freq === 1 && wordLength > 4;
      const isCompoundWord = word.includes('_') || word.includes('-');
      
      // Multiple hash functions for better semantic distribution
      const hash1 = this.semanticHash(word, 1);
      const hash2 = this.semanticHash(word, 2);
      const hash3 = this.semanticHash(word, 3);
      const hash4 = this.semanticHash(word + '_semantic', 1);
      
      // Enhanced base weight with word importance
      let baseWeight = tfidf * positionWeight;
      
      // Boost important words
      if (isLongWord) baseWeight *= 1.3;
      if (isRareWord) baseWeight *= 1.5;
      if (isCompoundWord) baseWeight *= 1.2;
      if (hasCapitals) baseWeight *= 1.1;
      
      // Primary word representation with enhanced distribution
      embedding[hash1 % dimensions] += baseWeight * 1.2;
      embedding[hash2 % dimensions] += baseWeight * 1.0;
      embedding[hash3 % dimensions] += baseWeight * 0.8;
      
      // Character-level features
      embedding[hash4 % dimensions] += vowelRatio * baseWeight * 0.5;
      embedding[(hash1 + wordLength) % dimensions] += (wordLength / 15.0) * baseWeight * 0.4;
      
      // Structural and linguistic features
      if (hasCapitals) {
        embedding[(hash2 + 7) % dimensions] += baseWeight * 0.6;
      }
      if (hasNumbers) {
        embedding[(hash3 + 11) % dimensions] += baseWeight * 0.6;
      }
      if (wordLength > 8) {  // Complex words get special treatment
        embedding[(hash1 + 13) % dimensions] += baseWeight * 0.7;
      }
      
      // Enhanced n-gram features with better context
      positions.forEach(position => {
        // Bigram features
        if (position > 0) {
          const bigram = words[position - 1] + '_' + word;
          const bigramHash = this.semanticHash(bigram, 4);
          embedding[bigramHash % dimensions] += baseWeight * 0.5;
        }
        
        if (position < words.length - 1) {
          const nextBigram = word + '_' + words[position + 1];
          const nextBigramHash = this.semanticHash(nextBigram, 5);
          embedding[nextBigramHash % dimensions] += baseWeight * 0.5;
        }
        
        // Trigram features for important words
        if (isLongWord || isRareWord) {
          if (position > 0 && position < words.length - 1) {
            const trigram = words[position - 1] + '_' + word + '_' + words[position + 1];
            const trigramHash = this.semanticHash(trigram, 6);
            embedding[trigramHash % dimensions] += baseWeight * 0.3;
          }
        }
      });
      
      // Enhanced prefix/suffix features for morphological richness
      if (wordLength >= 3) {
        const prefix2 = word.substring(0, Math.min(2, wordLength));
        const prefix3 = word.substring(0, Math.min(3, wordLength));
        const suffix2 = word.substring(Math.max(0, wordLength - 2));
        const suffix3 = word.substring(Math.max(0, wordLength - 3));
        
        const prefix2Hash = this.semanticHash(prefix2 + '_pre2', 7);
        const prefix3Hash = this.semanticHash(prefix3 + '_pre3', 8);
        const suffix2Hash = this.semanticHash(suffix2 + '_suf2', 9);
        const suffix3Hash = this.semanticHash(suffix3 + '_suf3', 10);
        
        embedding[prefix2Hash % dimensions] += baseWeight * 0.3;
        embedding[prefix3Hash % dimensions] += baseWeight * 0.4;
        embedding[suffix2Hash % dimensions] += baseWeight * 0.3;
        embedding[suffix3Hash % dimensions] += baseWeight * 0.4;
      }
    });
    
    // Enhanced global text features
    const avgWordLength = words.reduce((sum, word) => sum + word.length, 0) / words.length;
    const maxWordLength = Math.max(...words.map(w => w.length));
    const textComplexity = uniqueWords / totalWords;
    const textDensity = Math.log(1 + totalWords);
    const lexicalDiversity = uniqueWords / Math.sqrt(totalWords); // Better diversity measure
    
    // Distribute enhanced global features
    const globalHash1 = this.semanticHash('_global_complexity_', 11);
    const globalHash2 = this.semanticHash('_global_density_', 12);
    const globalHash3 = this.semanticHash('_global_length_', 13);
    const globalHash4 = this.semanticHash('_global_diversity_', 14);
    const globalHash5 = this.semanticHash('_global_max_word_', 15);
    
    embedding[globalHash1 % dimensions] += textComplexity * 0.6;
    embedding[globalHash2 % dimensions] += textDensity / 8.0;
    embedding[globalHash3 % dimensions] += avgWordLength / 12.0;
    embedding[globalHash4 % dimensions] += lexicalDiversity * 0.5;
    embedding[globalHash5 % dimensions] += maxWordLength / 15.0;
    
    // Enhanced document length normalization
    const docLengthNorm = Math.log(1 + totalWords);
    for (let i = 0; i < dimensions; i++) {
      embedding[i] = embedding[i] / Math.max(docLengthNorm, 1.0);
    }
    
    // L2 normalization for cosine similarity
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    const normalizedEmbedding = magnitude > 0 ? embedding.map(val => val / magnitude) : embedding;

    const fallbackResult = new Float32Array(normalizedEmbedding);
    // Cache the result (LRU: evict oldest if full)
    if (this.embeddingCache.size >= this.EMBEDDING_CACHE_MAX) {
      const firstKey = this.embeddingCache.keys().next().value;
      if (firstKey) this.embeddingCache.delete(firstKey);
    }
    this.embeddingCache.set(cacheKey, fallbackResult);
    return fallbackResult;
  }
  
  // Calculate position-based importance weight
  private calculatePositionWeight(position: number, totalWords: number): number {
    if (totalWords === 1) return 1.0;
    
    // Higher weight for beginning and end, lower for middle
    const relativePos = position / (totalWords - 1);
    
    // U-shaped curve: higher at start (0) and end (1), lower in middle (0.5)
    const positionWeight = 1.0 - 0.3 * Math.sin(relativePos * Math.PI);
    
    return positionWeight;
  }
  
  // General-purpose semantic hash function
  private semanticHash(str: string, seed: number): number {
    let hash = seed;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  // === NEW SEPARATE TOOLS ===

  async storeDocument(id: string, content: string, metadata: Record<string, any> = {}): Promise<{ id: string; stored: boolean }> {
    if (!this.db) throw new Error('Database not initialized');
    
    console.error(`📄 Storing document: ${id}`);
    
    // Clean up existing document
    await this.cleanupDocument(id);
    
    // Store document
    this.db.prepare(`
      INSERT OR REPLACE INTO documents (id, content, metadata)
      VALUES (?, ?, ?)
    `).run(id, content, JSON.stringify(metadata));
    
    console.error(`✅ Document stored: ${id}`);
    return { id, stored: true };
  }

  async chunkDocument(documentId: string, options: { maxTokens?: number; overlap?: number } = {}): Promise<{ documentId: string; chunks: Array<{ id: string; text: string; startPos: number; endPos: number }> }> {
    if (!this.db) throw new Error('Database not initialized');
    
    // Get document
    const document = this.db.prepare(`
      SELECT content FROM documents WHERE id = ?
    `).get(documentId) as { content: string } | undefined;
    
    if (!document) {
      throw new Error(`Document with ID ${documentId} not found`);
    }
    
    const { maxTokens = 800, overlap = 160 } = options;
    
    console.error(`🔪 Chunking document: ${documentId} (maxTokens: ${maxTokens}, overlap: ${overlap})`);
    
    // Clean up existing chunks
    await this.cleanupDocument(documentId);
    
    // Create chunks
    const chunks = this.chunkText(document.content, maxTokens, overlap);
    const resultChunks = [];
    
    for (const chunk of chunks) {
      const chunkId = `${documentId}_chunk_${chunk.chunk_index}`;
      
      // Store chunk metadata (no embedding yet)
      this.db.prepare(`
        INSERT INTO chunk_metadata (
          chunk_id, document_id, chunk_index, text, start_pos, end_pos
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(chunkId, documentId, chunk.chunk_index, chunk.text, chunk.start_pos, chunk.end_pos);
      
      resultChunks.push({
        id: chunkId,
        text: chunk.text,
        startPos: chunk.start_pos,
        endPos: chunk.end_pos
      });
    }
    
    console.error(`✅ Document chunked: ${chunks.length} chunks created`);
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
      // Generate embedding
      const embedding = await this.generateEmbedding(chunk.text);
      const rowid = Number(chunk.rowid);

      // Store in vector table
      try {
        // First, delete any existing embedding for this rowid
        this.db.exec(`DELETE FROM chunks WHERE rowid = ${safeRowid(rowid)}`);

        // Insert new embedding with explicit rowid to match chunk_metadata
        // Use parameterized only for embedding blob, rowid as literal integer
        this.db.prepare(`
          INSERT INTO chunks (rowid, embedding) VALUES (${rowid}, ?)
        `).run(Buffer.from(embedding.buffer));

        embeddedCount++;
      } catch (error) {
        const errMsg = `chunk ${chunk.chunk_id} (rowid=${rowid}, type=${typeof chunk.rowid}): ${error instanceof Error ? error.message : String(error)}`;
        console.error(`Failed to embed ${errMsg}`);
        errors.push(errMsg);
      }
    }

    console.error(`✅ Chunks embedded: ${embeddedCount}/${chunks.length}`);

    // Auto-link entities to document after embedding
    const linkedCount = await this.autoLinkEntities(documentId);

    return { documentId, embeddedChunks: embeddedCount, totalChunks: chunks.length, linkedEntities: linkedCount, ...(errors.length > 0 && { errors: errors.slice(0, 5) }) };
  }

  // Check if a string contains CJK (Chinese/Japanese/Korean) characters
  private hasCJK(text: string): boolean {
    return /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(text);
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
      return (text: string) => re.test(text);
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
        `SELECT rowid, text FROM chunk_metadata WHERE document_id = ?`
      ).all(documentId) as Array<{ rowid: number; text: string }>;

      if (chunks.length === 0) return 0;

      // Get all entities with observations for richer matching
      const entities = this.db.prepare(
        `SELECT e.id, e.name, e.entityType,
                GROUP_CONCAT(o.content, ' ||| ') as observations
         FROM entities e
         LEFT JOIN observations o ON o.entityId = e.id
         GROUP BY e.id`
      ).all() as Array<{ id: string; name: string; entityType: string; observations: string | null }>;

      // Minimum name length: 2 for CJK (e.g. "할랄"), 4 for Latin (avoid "API", "Bug")
      const MIN_LEN_CJK = 2;
      const MIN_LEN_LATIN = 4;

      const insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO chunk_entities (chunk_rowid, entity_id) VALUES (?, ?)
      `);

      let linkedCount = 0;

      for (const entity of entities) {
        const minLen = this.hasCJK(entity.name) ? MIN_LEN_CJK : MIN_LEN_LATIN;
        if (entity.name.length < minLen) continue;

        const nameMatcher = this.buildEntityMatcher(entity.name);

        // Also collect observation-derived aliases (short keywords from observations)
        const aliases: ((text: string) => boolean)[] = [];
        if (entity.observations) {
          const obs = entity.observations.split(' ||| ');
          for (const ob of obs) {
            // Extract file paths or identifiers mentioned in observations (e.g. "gemini_converter.py")
            const pathMatch = ob.match(/[\w\-]+\.\w{1,4}\b/g);
            if (pathMatch) {
              for (const p of pathMatch) {
                if (p.length >= 4) {
                  aliases.push((text: string) => text.toLowerCase().includes(p.toLowerCase()));
                }
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
    
    // Get chunks for this document
    const chunks = this.db.prepare(`
      SELECT rowid FROM chunk_metadata WHERE document_id = ?
    `).all(documentId) as Array<{ rowid: number }>;
    
    let linkedCount = 0;
    
    for (const entityName of entityNames) {
      const entityId = `entity_${entityName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      
      // Verify entity exists
      const entity = this.db.prepare(`
        SELECT id FROM entities WHERE id = ?
      `).get(entityId);
      
      if (!entity) {
        console.warn(`Entity ${entityName} not found, skipping`);
        continue;
      }
      
      // Link entity to all chunks of the document
      for (const chunk of chunks) {
        this.db.prepare(`
          INSERT OR IGNORE INTO chunk_entities (chunk_rowid, entity_id)
          VALUES (?, ?)
        `).run(chunk.rowid, entityId);
      }
      
      linkedCount++;
    }
    
    console.error(`✅ Entities linked: ${linkedCount} entities linked to document`);
    return { documentId, linkedEntities: linkedCount };
  }

  private async cleanupDocument(documentId: string): Promise<void> {
    if (!this.db) return;
    
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

  async exportGraph(): Promise<{ entities: any[]; relations: any[]; documents: any[]; metadata: { exportedAt: string; version: string; entityCount: number; relationCount: number; documentCount: number } }> {
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

    return {
      entities,
      relations,
      documents,
      metadata: {
        exportedAt: new Date().toISOString(),
        version: PKG_VERSION,
        entityCount: entities.length,
        relationCount: relations.length,
        documentCount: documents.length
      }
    };
  }

  async importGraph(data: { entities?: any[]; relations?: any[]; documents?: any[] }, options: { merge?: boolean } = { merge: true }): Promise<{ imported: { entities: number; relations: number; documents: number }; skipped: { entities: number; relations: number; documents: number } }> {
    if (!this.db) throw new Error('Database not initialized');

    console.error(`📥 Importing knowledge graph (merge: ${options.merge !== false})...`);

    const imported = { entities: 0, relations: 0, documents: 0 };
    const skipped = { entities: 0, relations: 0, documents: 0 };

    // If merge=false, clear existing data first
    if (options.merge === false) {
      this.db.exec(`DELETE FROM relationships`);
      this.db.exec(`DELETE FROM entities`);
      this.db.exec(`DELETE FROM documents`);
      console.error('🗑️ Cleared existing data for full import');
    }

    // Import entities using INSERT OR IGNORE
    if (data.entities && Array.isArray(data.entities)) {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO entities (id, name, entityType, observations, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const entity of data.entities) {
        const result = stmt.run(
          entity.id,
          entity.name,
          entity.entityType || 'CONCEPT',
          JSON.stringify(entity.observations || []),
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
      const stmt = this.db.prepare(`
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
      const stmt = this.db.prepare(`
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

    console.error(`✅ Import completed: ${imported.entities} entities, ${imported.relations} relations, ${imported.documents} documents imported`);

    return { imported, skipped };
  }

  async hybridSearch(query: string, limit = 5, useGraph = true): Promise<EnhancedSearchResult[]> {
    if (!this.db) throw new Error('Database not initialized');
    if (!this.encoding) throw new Error('Tokenizer not initialized');
    
    console.error(`🔍 Enhanced hybrid search: "${query}"`);
    const queryVariants = this.buildCrossLingualVariants(query);
    if (queryVariants.length > 1) {
      console.error(`🌐 Cross-lingual variants: ${queryVariants.slice(1).join(' | ')}`);
    }
    const primaryQueryEmbedding = await this.generateEmbedding(queryVariants[0], 1024, true);

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
        start_pos: number;
        end_pos: number;
        chunk_metadata: string;
        distance: number;
        doc_metadata: string;
      }>;
    };

    type ChunkSearchResult = ReturnType<typeof searchChunks>[number];

    // Search original query plus cross-lingual expansions and keep best match per chunk.
    const resultMap = new Map<string, ChunkSearchResult>();
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
    const vectorResults = Array.from(resultMap.values()).sort((a, b) => a.distance - b.distance);

    // FTS5 full-text search as additional signal (Reciprocal Rank Fusion)
    const ftsBoostMap = new Map<string, number>();
    try {
      const ftsSearchQuery = (q: string) => {
        // Escape FTS5 special characters and build a query with OR between terms
        const sanitized = q.replace(/["\*\(\)\-]/g, ' ').trim();
        if (!sanitized) return [];
        const terms = sanitized.split(/\s+/).filter(t => t.length > 0);
        if (terms.length === 0) return [];
        const ftsExpr = terms.map(t => `"${t}"`).join(' OR ');
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
      return [];
    }

    // Get entity information for graph enhancement via vector similarity
    let connectedEntities = new Set<string>();
    let queryMatchedEntities = new Set<string>();
    if (useGraph) {
      // Vector search: find entities semantically similar to the query (dual search)
      try {
        const searchEntities = (embedding: Float32Array) => {
          return this.db!.prepare(`
            SELECT
              em.entity_id,
              e.name,
              ee.distance
            FROM entity_embeddings ee
            JOIN entity_embedding_metadata em ON ee.rowid = em.rowid
            JOIN entities e ON e.id = em.entity_id
            WHERE ee.embedding MATCH ?
              AND k = 10
            ORDER BY ee.distance
          `).all(Buffer.from(embedding.buffer)) as Array<{ entity_id: string; name: string; distance: number }>;
        };

        // Merge all query variant entity results
        const entityMap = new Map<string, { entity_id: string; name: string; distance: number }>();
        for (const variant of queryVariants) {
          const embedding = await this.generateEmbedding(variant, 1024, true);
          for (const e of searchEntities(embedding)) {
            const existing = entityMap.get(e.entity_id);
            if (!existing || e.distance < existing.distance) {
              entityMap.set(e.entity_id, e);
            }
          }
        }
        const similarEntities = Array.from(entityMap.values()).sort((a, b) => a.distance - b.distance);

        for (const entity of similarEntities) {
          const similarity = Math.max(0, 1 - entity.distance / 2);
          if (similarity > 0.5) {
            queryMatchedEntities.add(entity.name);

            // Get connected entities via relationships
            const connected = this.db.prepare(`
              SELECT DISTINCT
                CASE
                  WHEN r.source_entity = ? THEN e2.name
                  ELSE e1.name
                END as connected_name
              FROM relationships r
              JOIN entities e1 ON e1.id = r.source_entity
              JOIN entities e2 ON e2.id = r.target_entity
              WHERE r.source_entity = ? OR r.target_entity = ?
            `).all(entity.entity_id, entity.entity_id, entity.entity_id) as { connected_name: string }[];

            connected.forEach((row) => connectedEntities.add(row.connected_name));
          }
        }
      } catch (error) {
        console.error('⚠️ Entity vector search for graph enhancement failed:', error);
        // Fallback: text-based matching (original behavior)
        const queryEntities = this.extractTermsFromText(query);
        for (const entity of queryEntities) {
          const connected = this.db.prepare(`
            SELECT DISTINCT
              CASE
                WHEN r.source_entity = e1.id THEN e2.name
                ELSE e1.name
              END as connected_name
            FROM entities e1
            JOIN relationships r ON (r.source_entity = e1.id OR r.target_entity = e1.id)
            JOIN entities e2 ON (e2.id = r.source_entity OR e2.id = r.target_entity)
            WHERE e1.name = ? AND e2.name != ?
          `).all(entity, entity) as { connected_name: string }[];
          connected.forEach((row) => connectedEntities.add(row.connected_name));
        }
      }
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
      
      // Enhanced graph boost calculation
      let graphBoost = 0;
      if (useGraph) {
        const queryEntities = this.extractTermsFromText(query);
        
        // Base boost for knowledge graph chunks
        if (result.chunk_type === 'entity') {
          graphBoost += 0.15; // Entities are inherently valuable
        } else if (result.chunk_type === 'relationship') {
          graphBoost += 0.25; // Relationships show connections
        }
        
        // Additional boost for entity matches
        const queryLower = query.toLowerCase();
        for (const entity of chunkEntities) {
          const entityLower = entity.toLowerCase();
          // Vector-matched entity (cross-lingual: "할랄 인증" → "KMF")
          if (queryMatchedEntities.has(entity)) {
            graphBoost += 0.3;
          }
          // Exact text match with extracted terms
          else if (queryEntities.some(qe => qe.toLowerCase() === entityLower)) {
            graphBoost += 0.3;
          }
          // Partial match: entity name appears in query or vice versa
          else if (queryLower.includes(entityLower) || entityLower.includes(queryLower)) {
            graphBoost += 0.2;
          }
          // Word-level partial match
          else if (entityLower.split(/\s+/).some(word => word.length >= 3 && queryLower.includes(word))) {
            graphBoost += 0.15;
          }
          // Connected to a vector-matched entity
          if (connectedEntities.has(entity)) {
            graphBoost += 0.15;
          }
        }
      }
      
      // Generate semantic summary
      const { summary, keyHighlight, relevanceScore } = await this.generateContentSummary(
        result.text,
        primaryQueryEmbedding,
        chunkEntities,
        result.chunk_type === 'relationship' ? 1 : 2 // Shorter summary for relationships
      );
      
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
        graph_boost: useGraph ? graphBoost : undefined,
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
    
    return finalResults;
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
      chunks: chunkCount.count
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



  async rollbackMigration(targetVersion: number): Promise<{ rolledBack: number; currentVersion: number; rolledBackMigrations: Array<{ version: number; description: string }> }> {
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
    
    return {
      rolledBack: migrationsToRollback.length,
      currentVersion: migrationManager.getCurrentVersion(),
      rolledBackMigrations: migrationsToRollback.map(m => ({
        version: m.version,
        description: m.description
      }))
    };
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
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.createEntities((validatedArgs as any).entities as Entity[]), null, 2) }] };
      case "createRelations":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.createRelations((validatedArgs as any).relations as Relation[]), null, 2) }] };
      case "addObservations":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.addObservations((validatedArgs as any).observations as { entityName: string; contents: string[] }[]), null, 2) }] };
      case "deleteEntities":
        await ragKgManager.deleteEntities((validatedArgs as any).entityNames as string[]);
        return { content: [{ type: "text", text: "Entities deleted successfully" }] };
      case "deleteObservations":
        await ragKgManager.deleteObservations((validatedArgs as any).deletions as { entityName: string; observations: string[] }[]);
        return { content: [{ type: "text", text: "Observations deleted successfully" }] };
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
        const useGraph = (validatedArgs as any).useGraph !== false;
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.hybridSearch((validatedArgs as any).query as string, limit, useGraph), null, 2) }] };
      case "getDetailedContext":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.getDetailedContext((validatedArgs as any).chunkId as string, (validatedArgs as any).includeSurrounding !== false), null, 2) }] };
      case "getKnowledgeGraphStats":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.getKnowledgeGraphStats(), null, 2) }] };
      case "deleteDocuments":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.deleteDocuments((validatedArgs as any).documentIds as string | string[]), null, 2) }] };
      case "listDocuments":
        return { content: [{ type: "text", text: JSON.stringify(await ragKgManager.listDocuments((validatedArgs as any).includeMetadata !== false), null, 2) }] };
      
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
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`❌ Tool execution error for ${name}:`, error.message);
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
    throw error;
  }
});

async function main() {
  try {
    await ragKgManager.initialize();
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🚀 Enhanced RAG Knowledge Graph MCP Server running on stdio");
    
    // Cleanup on exit — avoid process.exit() to prevent ONNX runtime mutex crash
    const shutdown = () => {
      console.error('\n🧹 Cleaning up...');
      try { ragKgManager.cleanup(); } catch {}
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('exit', shutdown);
    
  } catch (error) {
    console.error("Failed to initialize server:", error);
    ragKgManager.cleanup();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  ragKgManager.cleanup();
  process.exit(1);
});
