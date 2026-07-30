import { z } from 'zod';
import { ToolDefinition, ToolCapabilityInfo, ToolRegistrationDescription } from './types.js';

// === CREATE ENTITIES TOOL ===

const createEntitiesCapability: ToolCapabilityInfo = {
  description: 'Create multiple new entities in the knowledge graph with comprehensive metadata',
  parameters: {
    type: 'object',
    properties: {
      entities: {
        type: 'array',
        description: 'Array of entities to create in the knowledge graph',
        items: {
          type: 'object'
        }
      }
    },
    required: ['entities'],
  },
};

const createEntitiesDescription: ToolRegistrationDescription = () => `<description>
Create multiple new entities in the knowledge graph with comprehensive metadata and observations.
**Essential for building the foundational structure of your knowledge representation.**
Use this tool to add new concepts, people, places, or any identifiable objects to your graph.
</description>

<importantNotes>
- (!important!) **Entities are the building blocks** of your knowledge graph - use descriptive names
- (!important!) EntityType helps categorize and filter entities (e.g., PERSON, CONCEPT, PLACE, TECHNOLOGY)
- (!important!) Observations provide context and evidence for the entity's existence or properties
- (!important!) **Avoid duplicate entities** - check if similar entities exist first using search_nodes
</importantNotes>

<whenToUseThisTool>
- When introducing new concepts, people, or objects into your knowledge base
- When processing documents and need to extract and formalize key entities
- When building domain-specific knowledge representations
- When creating structured data from unstructured text
- **Before creating relationships** - ensure both entities exist
- When migrating knowledge from other systems into the graph
</whenToUseThisTool>

<features>
- Batch creation of multiple entities in a single operation
- Automatic unique ID generation based on entity names
- Support for custom entity types for domain categorization
- Rich observation arrays for evidence and context
- Automatic deduplication (existing entities are ignored)
- Metadata support for extensible entity properties
</features>

<bestPractices>
- Use consistent naming conventions (e.g., "John Smith" not "john smith")
- Choose meaningful entityTypes that reflect your domain (PERSON, TECHNOLOGY, CONCEPT, etc.)
- Include rich observations that provide context and evidence
- Group related entity creation for better performance
- Use descriptive names that uniquely identify the entity
- Consider hierarchical naming for complex domains (e.g., "JavaScript.React.Hooks")
</bestPractices>

<parameters>
- entities: Array of entity objects, each containing:
  - name: Unique identifier/name for the entity (string, required)
  - entityType: Category/classification of the entity (string, required)
  - observations: Array of contextual information and evidence (string[], required)
</parameters>

<examples>
- Adding people: {"entities": [{"name": "Albert Einstein", "entityType": "PERSON", "observations": ["Physicist who developed relativity theory", "Nobel Prize winner in 1921"]}]}
- Adding concepts: {"entities": [{"name": "Machine Learning", "entityType": "CONCEPT", "observations": ["Subset of artificial intelligence", "Focuses on learning from data"]}]}
- Adding technologies: {"entities": [{"name": "React", "entityType": "TECHNOLOGY", "observations": ["JavaScript library for building UIs", "Developed by Facebook"]}]}
</examples>`;

const createEntitiesSchema: z.ZodRawShape = {
  entities: z.array(z.object({
    name: z.string().describe('The unique name/identifier of the entity'),
    entityType: z.string().describe('The category or type of the entity (e.g., PERSON, CONCEPT, TECHNOLOGY)'),
    observations: z.array(z.string()).describe('Array of contextual observations about the entity'),
    // v13: 아래 두 필드는 addObservations 와 같은 의미다. 스키마에 없으면 전달되지 않는다.
    status: z.enum(['active', 'provisional']).optional()
      .describe("'provisional' hides the observations from search until approveObservation. Default 'active'"),
    sources: z.array(z.object({
      source_kind: z.enum(['document', 'conversation', 'decision', 'import'])
        .describe('What kind of thing these observations came from'),
      source_ref: z.string().describe('Identifier of the source'),
      source_hash: z.string().optional().describe('Optional content hash of the source'),
    })).optional().describe('Provenance. Omit if genuinely unknown - do not invent a source'),
  })).describe('Array of entities to create in the knowledge graph'),
};

export const createEntitiesTool: ToolDefinition = {
  capability: createEntitiesCapability,
  description: createEntitiesDescription,
  schema: createEntitiesSchema,
  annotations: { idempotentHint: true },
};

// === CREATE RELATIONS TOOL ===

const createRelationsCapability: ToolCapabilityInfo = {
  description: 'Create multiple relationships between entities in the knowledge graph',
  parameters: {
    type: 'object',
    properties: {
      relations: {
        type: 'array',
        description: 'Array of relationships to create between existing entities',
        items: {
          type: 'object'
        }
      }
    },
    required: ['relations'],
  },
};

const createRelationsDescription: ToolRegistrationDescription = () => `<description>
Create multiple relationships between entities in the knowledge graph to establish connections and semantic links.
**Critical for building the interconnected structure that makes knowledge graphs powerful.**
Relationships define how entities relate to each other, enabling graph traversal and inference.
</description>

<importantNotes>
- (!important!) **Both entities must exist** before creating relationships - entities are auto-created if missing
- (!important!) Relationship types should be consistent and meaningful (e.g., IS_A, HAS, USES, IMPLEMENTS)
- (!important!) Direction matters: "from" → "to" represents the relationship direction
- (!important!) **Avoid redundant relationships** - check existing connections first
</importantNotes>

<whenToUseThisTool>
- When establishing semantic connections between concepts
- After creating entities that should be connected
- When processing text that implies relationships
- When building domain-specific ontologies
- When migrating relational data into graph format
- **Before querying graph paths** - ensure proper connectivity
</whenToUseThisTool>

<features>
- Batch creation of multiple relationships in one operation
- Automatic entity creation if referenced entities don't exist
- Support for custom relationship types
- Bidirectional relationship awareness
- Confidence scoring and metadata support
- Deduplication of identical relationships
</features>

<bestPractices>
- Use consistent relationship types across your domain
- Choose clear, unambiguous relationship names (IS_A, PART_OF, IMPLEMENTS)
- Consider both directions when appropriate (if A USES B, does B DEPEND_ON A?)
- Group related relationship creation for better performance
- Use verb-like relationship types that read naturally
- Document relationship semantics for complex domains
</bestPractices>

<parameters>
- relations: Array of relationship objects, each containing:
  - from: Name of the source entity (string, required)
  - to: Name of the target entity (string, required)
  - relationType: Type/category of the relationship (string, required)
</parameters>

<examples>
- Inheritance: {"relations": [{"from": "Dog", "to": "Animal", "relationType": "IS_A"}]}
- Usage: {"relations": [{"from": "React", "to": "JavaScript", "relationType": "USES"}]}
- Composition: {"relations": [{"from": "Car", "to": "Engine", "relationType": "HAS"}]}
- Multiple: {"relations": [{"from": "Einstein", "to": "Relativity", "relationType": "DEVELOPED"}, {"from": "Relativity", "to": "Physics", "relationType": "PART_OF"}]}
</examples>`;

const createRelationsSchema: z.ZodRawShape = {
  relations: z.array(z.object({
    from: z.string().describe('Name of the source entity in the relationship'),
    to: z.string().describe('Name of the target entity in the relationship'),
    relationType: z.string().describe('Type of relationship (e.g., IS_A, HAS, USES, IMPLEMENTS)'),
  })).describe('Array of relationships to create between entities'),
};

export const createRelationsTool: ToolDefinition = {
  capability: createRelationsCapability,
  description: createRelationsDescription,
  schema: createRelationsSchema,
  annotations: { idempotentHint: true },
};

// === ADD OBSERVATIONS TOOL ===

const addObservationsCapability: ToolCapabilityInfo = {
  description: 'Add new observations to existing entities to enrich their context and evidence',
  parameters: {
    type: 'object',
    properties: {
      observations: {
        type: 'array',
        description: 'Array of observation additions for specific entities',
        items: {
          type: 'object'
        }
      }
    },
    required: ['observations'],
  },
};

const addObservationsDescription: ToolRegistrationDescription = () => `<description>
Add new observations to existing entities to continuously enrich their context, evidence, and understanding.
**Essential for keeping your knowledge graph current and comprehensive.**
Observations provide the factual foundation that supports entity existence and properties.
</description>

<importantNotes>
- (!important!) **Entity must exist** - this tool only adds to existing entities
- (!important!) Duplicates are filtered - repeating existing text with a **new** sources entry
  adds evidence to the existing revision and returns null for that position
- (!important!) Observations are cumulative. **This tool never replaces anything** - use
  correctObservation to supersede and retractObservation to withdraw
- (!important!) **Be specific and factual** - observations should be verifiable statements
</importantNotes>

<whenToUseThisTool>
- When you discover new information about existing entities
- After processing additional documents that mention known entities
- When updating entity knowledge from new sources
- When refining and expanding entity descriptions
- **Before making knowledge-based decisions** - ensure entities have sufficient context
- When *expanding* incomplete entity information. **To correct a wrong observation use
  correctObservation** - adding a second, contradicting observation leaves both in search
</whenToUseThisTool>

<features>
- Batch addition of observations to multiple entities
- Automatic duplicate filtering - no redundant observations
- Supports rich textual observations with context
- Stable observation ids returned in observation_ids, aligned 1:1 with contents
- Real revision history: see correctObservation and getObservationHistory
- Integrates with document processing workflows
- Enables incremental knowledge building
</features>

<bestPractices>
- Keep observations factual and specific rather than general
- Put provenance in the sources field, not in the text. A source written in prose cannot be
  queried, deduplicated, or attached to a later revision
- Use consistent terminology across observations
- Add complementary observations that provide different perspectives
- Include temporal information when relevant ("As of 2024...")
- Group related observations by topic or source
</bestPractices>

<parameters>
- observations: Array of observation addition objects, each containing:
  - entityName: Name of the existing entity to update (string, required)
  - contents: Array of new observation strings to add (string[], required)
</parameters>

<examples>
- Scientific updates: {"observations": [{"entityName": "Quantum Computing", "contents": ["IBM achieved quantum advantage in 2024", "Shows promise for cryptography applications"]}]}
- Person details: {"observations": [{"entityName": "Marie Curie", "contents": ["First woman to win Nobel Prize", "Won Nobel Prizes in two different sciences"]}]}
- Technology evolution: {"observations": [{"entityName": "React", "contents": ["React 18 introduced concurrent features", "Widely adopted for enterprise applications"]}]}
</examples>`;

// v13: provenance 와 status 는 스키마에 있어야 실제로 전달된다. validateToolArgs 가
// z.object(...).parse() 로 검증하므로 스키마에 없는 키는 조용히 버려진다.
const sourceInputSchema = z.object({
  source_kind: z.enum(['document', 'conversation', 'decision', 'import'])
    .describe('What kind of thing this observation came from'),
  source_ref: z.string().describe('Identifier of the source (document id, decision id, ...)'),
  source_hash: z.string().optional().describe('Optional content hash of the source'),
}).describe('Where this observation came from');

const addObservationsSchema: z.ZodRawShape = {
  observations: z.array(z.object({
    entityName: z.string().describe('Name of the existing entity to add observations to'),
    contents: z.array(z.string()).describe('Array of new observation strings to add'),
    status: z.enum(['active', 'provisional']).optional()
      .describe("'provisional' hides it from search until approveObservation. Default 'active'"),
    sources: z.array(sourceInputSchema).optional()
      .describe('Provenance. Omit if genuinely unknown - do not invent a source'),
  })).describe('Array of observation additions for specific entities'),
};

export const addObservationsTool: ToolDefinition = {
  capability: addObservationsCapability,
  description: addObservationsDescription,
  schema: addObservationsSchema,
  annotations: { idempotentHint: true },
};

// === HYBRID SEARCH TOOL ===

const hybridSearchCapability: ToolCapabilityInfo = {
  description: 'Perform advanced hybrid search combining vector similarity with knowledge graph traversal',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to find relevant information'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return',
        default: 5
      },
      useGraph: {
        type: 'boolean',
        description: 'Whether to enhance results with knowledge graph connections',
        default: true
      }
    },
    required: ['query'],
  },
};

const hybridSearchDescription: ToolRegistrationDescription = () => `<description>
Perform sophisticated hybrid search that combines vector similarity with knowledge graph traversal for superior results.
**The most powerful search tool in the system** - leverages both semantic similarity and structural relationships.
Perfect for complex queries that benefit from both content matching and conceptual connections.
</description>

<importantNotes>
- (!important!) **Hybrid approach is more powerful** than pure vector or graph search alone
- (!important!) Graph enhancement finds related concepts even if not directly mentioned
- (!important!) Results include similarity scores, graph boost, and hybrid rankings
- (!important!) **Best results when knowledge graph is well-populated** with entities and relationships
</importantNotes>

<whenToUseThisTool>
- When you need comprehensive search across documents and knowledge
- For complex queries requiring conceptual understanding
- When exploring relationships between concepts
- **Before making decisions** - to gather all relevant information
- When researching topics that span multiple domains
- For discovery of implicit connections and patterns
</whenToUseThisTool>

<features>
- Vector similarity search using sentence transformers
- Knowledge graph traversal for conceptual enhancement
- Hybrid scoring combining multiple relevance signals
- Entity association highlighting
- Configurable result limits and graph usage
- Rich result metadata with multiple ranking scores
</features>

<bestPractices>
- Use natural language queries rather than keywords
- Enable graph enhancement for better conceptual coverage
- Start with broader queries, then narrow down based on results
- Review entity associations to understand why results were selected
- Use appropriate limits based on your analysis needs
- Combine with other tools for comprehensive knowledge exploration
</bestPractices>

<parameters>
- query: Natural language search query (string, required)
- limit: Maximum results to return, default 5 (number, optional)
- useGraph: Enable knowledge graph enhancement, default true (boolean, optional)
</parameters>

<examples>
- Conceptual search: {"query": "machine learning applications in healthcare", "limit": 10}
- Technical research: {"query": "React performance optimization techniques", "useGraph": true}
- Discovery mode: {"query": "Einstein's contributions to modern physics", "limit": 15}
- Quick lookup: {"query": "quantum computing advantages", "limit": 3, "useGraph": false}
</examples>`;

const hybridSearchSchema: z.ZodRawShape = {
  query: z.string().describe('The search query to find relevant information'),
  limit: z.number().optional().default(5).describe('Maximum number of results to return'),
  useGraph: z.boolean().optional().default(true).describe('Whether to enhance results with knowledge graph connections'),
};

export const hybridSearchTool: ToolDefinition = {
  capability: hybridSearchCapability,
  description: hybridSearchDescription,
  schema: hybridSearchSchema,
  annotations: { readOnlyHint: true },
};

// === EMBED ALL ENTITIES TOOL ===

const embedAllEntitiesCapability: ToolCapabilityInfo = {
  description: 'Generate semantic embeddings for all entities in the knowledge graph to enable vector search',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const embedAllEntitiesDescription: ToolRegistrationDescription = () => `<description>
Generate semantic vector embeddings for all entities in the knowledge graph to enable semantic search.
**Essential for upgrading your knowledge graph to use semantic vector search instead of pattern matching.**
This tool creates embeddings from entity names, types, and observations for powerful semantic discovery.
</description>

<importantNotes>
- (!important!) **Processes all entities** in the knowledge graph at once
- (!important!) **Enables semantic search** - required for vector-based entity discovery
- (!important!) **Replaces pattern matching** with intelligent similarity search
- (!important!) **Automatic for new entities** - only needed once for existing entities
</importantNotes>

<whenToUseThisTool>
- **After importing existing entities** that don't have embeddings yet
- When upgrading from pattern-based to semantic search
- When entities have been created without automatic embedding generation
- After significant updates to entity observations that require re-embedding
- When setting up semantic search capabilities for the first time
</whenToUseThisTool>

<features>
- Batch processing of all entities in the knowledge graph
- Generates embeddings from entity names, types, and observations
- Creates searchable vector representations using sentence transformers
- Enables semantic similarity search across all entities
- Automatic handling of embedding generation and storage
- Progress reporting for large entity collections
</features>

<bestPractices>
- Run once after importing entities from other systems
- Use when transitioning from pattern-based to semantic search
- Monitor progress output for large knowledge graphs
- Ensure embedding model is properly initialized before running
- Consider running after major entity data updates
- Use as a one-time setup tool for existing knowledge graphs
</bestPractices>

<parameters>
- No parameters required - processes all entities automatically
</parameters>

<examples>
- Initial setup: {} (no parameters needed)
- After import: {} (processes all existing entities)
- Post-migration: {} (enables semantic search for imported data)
</examples>`;

const embedAllEntitiesSchema: z.ZodRawShape = {
  // No parameters needed
};

export const embedAllEntitiesTool: ToolDefinition = {
  capability: embedAllEntitiesCapability,
  description: embedAllEntitiesDescription,
  schema: embedAllEntitiesSchema,
  annotations: { idempotentHint: true },
};

// === GET DETAILED CONTEXT TOOL ===

const getDetailedContextCapability: ToolCapabilityInfo = {
  description: 'Retrieve detailed context for a specific chunk including surrounding content',
  parameters: {
    type: 'object',
    properties: {
      chunkId: {
        type: 'string',
        description: 'ID of the chunk to get detailed context for'
      },
      includeSurrounding: {
        type: 'boolean',
        description: 'Whether to include surrounding chunks for better context',
        default: true
      }
    },
    required: ['chunkId'],
  },
};

const getDetailedContextDescription: ToolRegistrationDescription = () => `<description>
Retrieve comprehensive detailed context for a specific chunk, including the full text and surrounding content.
**Essential companion to hybridSearch** - use this to get complete context after reviewing search summaries.
Perfect drill-down tool for exploring the full content behind search result highlights.
</description>

<importantNotes>
- (!important!) **Use after hybridSearch** - to explore full context of interesting results
- (!important!) **Returns complete chunk text** - not just summaries or highlights
- (!important!) **Includes surrounding chunks** - for better context understanding
- (!important!) **Shows entity associations** - to understand knowledge graph connections
</importantNotes>

<whenToUseThisTool>
- **After reviewing hybridSearch results** - to get full context of interesting chunks
- When search summaries indicate relevant content that needs complete analysis
- When you need full text for decision making or detailed understanding
- When exploring content around a specific passage or concept
- For reading complete passages in their original document context
- When entity associations in search results warrant deeper investigation
</whenToUseThisTool>

<features>
- Complete chunk text retrieval without truncation
- Automatic surrounding chunk inclusion for context
- Entity association information for knowledge graph insights
- Document metadata and title for source identification
- Structured context with clear before/after chunk positioning
- Efficient lookup by chunk ID from search results
</features>

<bestPractices>
- Use hybridSearch first to identify relevant chunks of interest
- Review search summaries before requesting detailed context
- Use surrounding context to understand passage flow and meaning
- Pay attention to entity associations for related concept exploration
- Combine with additional searches based on detailed context insights
- Use for final verification when making knowledge-based decisions
</bestPractices>

<parameters>
- chunkId: Chunk ID from search results (string, required)
- includeSurrounding: Include before/after chunks, default true (boolean, optional)
</parameters>

<examples>
- Full context: {"chunkId": "doc1_chunk_5"}
- Context only: {"chunkId": "doc1_chunk_5", "includeSurrounding": false}
- From search: {"chunkId": "advanced_delivery_features_technical_chunk_2"}
</examples>`;

const getDetailedContextSchema: z.ZodRawShape = {
  chunkId: z.string().describe('ID of the chunk to get detailed context for'),
  includeSurrounding: z.boolean().optional().default(true).describe('Whether to include surrounding chunks for better context'),
};

export const getDetailedContextTool: ToolDefinition = {
  capability: getDetailedContextCapability,
  description: getDetailedContextDescription,
  schema: getDetailedContextSchema,
  annotations: { readOnlyHint: true },
};

// === UPDATE RELATIONS TOOL ===

const updateRelationsCapability: ToolCapabilityInfo = {
  description: 'Update existing relationships in the knowledge graph (confidence, metadata)',
  parameters: {
    type: 'object',
    properties: {
      updates: {
        type: 'array',
        description: 'Array of relation updates',
        items: {
          type: 'object'
        }
      }
    },
    required: ['updates'],
  },
};

const updateRelationsDescription: ToolRegistrationDescription = () => `<description>
Update existing relationships in the knowledge graph — change confidence scores or metadata without deleting and recreating.
**Enables fine-grained relationship management without data loss.**
</description>

<importantNotes>
- (!important!) **Relationship must exist** — identified by from + to + relationType
- (!important!) Only specified fields are updated — unspecified fields remain unchanged
- (!important!) Confidence scores range from 0.0 to 1.0
</importantNotes>

<whenToUseThisTool>
- When adjusting relationship strength/confidence based on new evidence
- When adding metadata to existing relationships
- When refining knowledge graph quality without destructive operations
</whenToUseThisTool>

<parameters>
- updates: Array of update objects, each containing:
  - from: Source entity name (string, required)
  - to: Target entity name (string, required)
  - relationType: Type of the relationship to update (string, required)
  - confidence: New confidence score 0.0-1.0 (number, optional)
  - metadata: New metadata object (object, optional)
</parameters>

<examples>
- Adjust confidence: {"updates": [{"from": "React", "to": "JavaScript", "relationType": "USES", "confidence": 0.95}]}
- Add metadata: {"updates": [{"from": "Einstein", "to": "Relativity", "relationType": "DEVELOPED", "metadata": {"year": 1905, "verified": true}}]}
</examples>`;

const updateRelationsSchema: z.ZodRawShape = {
  updates: z.array(z.object({
    from: z.string().describe('Name of the source entity'),
    to: z.string().describe('Name of the target entity'),
    relationType: z.string().describe('Type of the relationship to update'),
    confidence: z.number().min(0).max(1).optional().describe('New confidence score (0.0-1.0)'),
    metadata: z.record(z.any()).optional().describe('New metadata object'),
  })).describe('Array of relationship updates'),
};

export const updateRelationsTool: ToolDefinition = {
  capability: updateRelationsCapability,
  description: updateRelationsDescription,
  schema: updateRelationsSchema,
  annotations: { idempotentHint: true },
};

// === OBSERVATION LIFECYCLE TOOLS (v13, spec §6.1 / §6.2) ===

// 상태 전이 4종은 인자와 형태가 같다. 같은 문장을 네 번 복사하면 한 곳만 고치는
// drift 가 생기므로 팩토리로 만든다.
const transitionTool = (a: {
  verb: string; from: string; to: string; reasonRequired: boolean; extra: string;
}): ToolDefinition => ({
  capability: {
    description: `${a.verb} an observation revision (${a.from} -> ${a.to})`,
    parameters: {
      type: 'object',
      properties: {
        observation_id: { type: 'string', description: 'The revision to transition' },
        reason: { type: 'string', description: 'Why this transition happened' },
      },
      required: a.reasonRequired ? ['observation_id', 'reason'] : ['observation_id'],
    },
  },
  description: () => `<description>
${a.verb} an observation revision: status '${a.from}' becomes '${a.to}'.
**This is a state change, not a deletion** - the revision and its text survive and stay
visible through getObservationHistory.
</description>

<importantNotes>
- (!important!) Only '${a.from}' revisions can be ${a.to === 'active' ? 'moved to active' : a.to}; the transition table rejects anything else
- (!important!) 'superseded' is terminal - correct it into a new revision instead
- (!important!) Ordinary search returns only 'active' revisions, so this changes what search sees
- (!important!) ${a.extra}
</importantNotes>

<whenToUseThisTool>
- ${a.extra}
- When you need the record of the change to survive, not just the current text
</whenToUseThisTool>

<parameters>
- observation_id: The revision id, from addObservations/createEntities or getObservationHistory (string, required)
- reason: Why (string, ${a.reasonRequired ? 'required' : 'optional but strongly recommended'})
</parameters>`,
  schema: {
    observation_id: z.string().describe('The observation revision id to transition'),
    ...(a.reasonRequired
      ? { reason: z.string().describe('Why this transition happened') }
      : { reason: z.string().optional().describe('Why this transition happened') }),
  } as z.ZodRawShape,
});

export const retractObservationTool = transitionTool({
  verb: 'Retract', from: 'active', to: 'retracted', reasonRequired: false,
  extra: 'Use this when a fact turned out to be wrong or no longer holds and there is no replacement text',
});
export const restoreObservationTool = transitionTool({
  verb: 'Restore', from: 'retracted', to: 'active', reasonRequired: false,
  extra: 'Use this when a retraction itself was a mistake',
});
export const approveObservationTool = transitionTool({
  verb: 'Approve', from: 'provisional', to: 'active', reasonRequired: false,
  extra: 'Use this to accept a provisional observation so search starts returning it',
});
export const declineObservationTool = transitionTool({
  verb: 'Decline', from: 'provisional', to: 'retracted', reasonRequired: true,
  extra: 'Use this to reject a provisional observation while keeping the fact that it was proposed',
});

const correctObservationDescription: ToolRegistrationDescription = () => `<description>
Replace the text of an observation while keeping the previous version as history.
**This is the tool to use when a stored fact is wrong.** Overwriting loses the correction;
this supersedes the old revision so both the mistake and the fix stay retrievable.
</description>

<importantNotes>
- (!important!) The old revision becomes 'superseded' and the new one becomes 'active'
- (!important!) The new revision keeps the old one's position in the entity's observation array
- (!important!) Only an 'active' revision can be corrected
- (!important!) Ordinary search returns only the new text; the old text is reachable through getObservationHistory
</importantNotes>

<whenToUseThisTool>
- When an observation states something that is now known to be false (change_kind: 'correction')
- When the world changed and the old statement was true at the time (change_kind: 'world_change')
- **Instead of deleting and re-adding** - that loses the link between the two
</whenToUseThisTool>

<parameters>
- observation_id: The active revision to correct (string, required)
- content: The corrected text (string, required)
- change_kind: 'correction' (it was wrong) or 'world_change' (it stopped being true). Default 'correction'
- reason: Why (string, optional but strongly recommended)
</parameters>

<examples>
- {"observation_id": "…", "content": "Uses FTS5 for keyword search", "change_kind": "correction", "reason": "verified in source"}
</examples>`;

export const correctObservationTool: ToolDefinition = {
  capability: {
    description: 'Supersede an observation revision with corrected text, keeping the old one as history',
    parameters: {
      type: 'object',
      properties: {
        observation_id: { type: 'string', description: 'The active revision to correct' },
        content: { type: 'string', description: 'The corrected text' },
        change_kind: { type: 'string', description: "'correction' or 'world_change'" },
        reason: { type: 'string', description: 'Why this correction happened' },
      },
      required: ['observation_id', 'content'],
    },
  },
  description: correctObservationDescription,
  schema: {
    observation_id: z.string().describe('The active observation revision to correct'),
    content: z.string().describe('The corrected observation text'),
    change_kind: z.enum(['correction', 'world_change']).optional()
      .describe("'correction' = it was wrong; 'world_change' = it stopped being true. Default 'correction'"),
    reason: z.string().optional().describe('Why this correction happened'),
  },
};

const purgeObservationDescription: ToolRegistrationDescription = () => `<description>
**DESTRUCTIVE.** Physically delete an observation revision and every later revision of the same
root. History is gone afterwards - there is no undo.
</description>

<importantNotes>
- (!important!) **retractObservation is almost always what you want.** It hides the fact from
  search while keeping the record
- (!important!) You must pass confirm='PURGE'; any other value refuses
- (!important!) This is a **suffix purge**: purging revision 2 of a 3-revision chain removes 3 then 2
- (!important!) The root row is kept so the observation's array position stays reserved
- (!important!) Events for purged revisions are removed too
</importantNotes>

<whenToUseThisTool>
- When content must be erased for legal or privacy reasons, not because it is wrong
- **Never** as the normal way to remove an observation
</whenToUseThisTool>

<parameters>
- observation_id: The revision to purge from (string, required)
- confirm: Must be exactly 'PURGE' (string, required)
</parameters>`;

export const purgeObservationTool: ToolDefinition = {
  capability: {
    description: 'DESTRUCTIVE: physically delete an observation revision and its successors',
    parameters: {
      type: 'object',
      properties: {
        observation_id: { type: 'string', description: 'The revision to purge from' },
        confirm: { type: 'string', description: "Must be exactly 'PURGE'" },
      },
      required: ['observation_id', 'confirm'],
    },
  },
  description: purgeObservationDescription,
  schema: {
    observation_id: z.string().describe('The observation revision to purge from'),
    confirm: z.literal('PURGE').describe("Must be exactly 'PURGE' - this destroys history"),
  },
  annotations: { destructiveHint: true },
};

const getObservationHistoryDescription: ToolRegistrationDescription = () => `<description>
Return the full revision history of observations: every version, its status, its provenance, and
the events that changed it.
**Past versions come out here and nowhere else - ordinary search returns only 'active' revisions.**
</description>

<importantNotes>
- (!important!) The response is always \`{ roots: [...] }\` - one root per logical observation
- (!important!) Each root holds its revisions in order (revision_no ascending), oldest first
- (!important!) Use this to answer "was this ever different?" or "where did this come from?"
- (!important!) Exactly one selector is required
</importantNotes>

<whenToUseThisTool>
- When you need to know whether a fact was corrected, and what it used to say
- When you need the provenance (which document or decision) behind an observation
- Before trusting a surprising fact - check whether it was already retracted or superseded
- When auditing what changed in an entity's knowledge over time
</whenToUseThisTool>

<parameters>
- entity_name: All observations of this entity (string, optional)
- observation_id: The root that this revision belongs to (string, optional)
- root_id: One specific logical observation (string, optional)
</parameters>

<examples>
- {"entity_name": "claude-mem"}
- {"observation_id": "…"}
</examples>`;

export const getObservationHistoryTool: ToolDefinition = {
  capability: {
    description: 'Full revision history of observations - the only surface for non-active revisions',
    parameters: {
      type: 'object',
      properties: {
        entity_name: { type: 'string', description: 'All observations of this entity' },
        observation_id: { type: 'string', description: 'The root this revision belongs to' },
        root_id: { type: 'string', description: 'One specific logical observation' },
      },
      required: [],
    },
  },
  description: getObservationHistoryDescription,
  schema: {
    entity_name: z.string().optional().describe('All observations of this entity'),
    observation_id: z.string().optional().describe('The root that this revision belongs to'),
    root_id: z.string().optional().describe('One specific logical observation'),
  },
  annotations: { readOnlyHint: true },
};

// Export all knowledge graph tools
export const knowledgeGraphTools = {
  createEntities: createEntitiesTool,
  createRelations: createRelationsTool,
  addObservations: addObservationsTool,
  updateRelations: updateRelationsTool,
  hybridSearch: hybridSearchTool,
  embedAllEntities: embedAllEntitiesTool,
  getDetailedContext: getDetailedContextTool,
  // v13 observation lifecycle
  correctObservation: correctObservationTool,
  retractObservation: retractObservationTool,
  restoreObservation: restoreObservationTool,
  approveObservation: approveObservationTool,
  declineObservation: declineObservationTool,
  purgeObservation: purgeObservationTool,
  getObservationHistory: getObservationHistoryTool,
};