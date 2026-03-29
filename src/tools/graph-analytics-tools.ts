import { z } from 'zod';
import { ToolDefinition, ToolCapabilityInfo, ToolRegistrationDescription } from './types.js';

// === GET GRAPH METRICS TOOL ===

const getGraphMetricsCapability: ToolCapabilityInfo = {
  description: 'Calculate centrality metrics for entities using graphology graph analysis',
  parameters: {
    type: 'object',
    properties: {
      entityNames: {
        type: 'array',
        description: 'Entity names to calculate metrics for. If empty, returns top entities by each metric.',
        items: { type: 'string' },
      },
      metrics: {
        type: 'array',
        description: 'Which metrics to compute: degree, betweenness, closeness, pagerank',
        items: { type: 'string' },
      },
      limit: {
        type: 'number',
        description: 'Max entities to return when entityNames is empty (default 10)',
        default: 10,
      },
    },
    required: [],
  },
};

const getGraphMetricsDescription: ToolRegistrationDescription = () => `<description>
Calculate centrality metrics for entities using graphology graph analysis algorithms.
**Identifies the most important, influential, and bridging entities in your knowledge graph.**
Supports degree, betweenness, closeness centrality and PageRank.
</description>

<importantNotes>
- (!important!) **Builds in-memory graph** from SQLite data — lightweight for typical knowledge graphs
- (!important!) Returns centrality scores normalized to 0-1 range
- (!important!) When no entityNames provided, returns top entities ranked by each metric
- (!important!) Useful for identifying knowledge hubs, bridges, and peripheral entities
</importantNotes>

<whenToUseThisTool>
- To find the most connected/important entities in your knowledge graph
- To identify bridge entities that connect different knowledge domains
- To discover peripheral entities that may need more connections
- For knowledge graph health analysis and optimization
- Before consolidation — to identify which entities are structurally important
</whenToUseThisTool>

<features>
- Degree centrality: most connected entities (hub detection)
- Betweenness centrality: entities bridging different clusters
- Closeness centrality: entities with shortest average distance to all others
- PageRank: recursive importance based on connections to important entities
- Supports both targeted (specific entities) and discovery (top-N) modes
</features>

<bestPractices>
- Use without entityNames first to discover important entities
- Combine with detectCommunities for deeper structural analysis
- High betweenness + low degree = critical bridge (fragile point)
- High degree + high PageRank = knowledge hub
- Run periodically to track how graph structure evolves
</bestPractices>

<parameters>
- entityNames: (optional) Specific entities to analyze. If omitted, returns top entities by each metric.
- metrics: (optional) Array of metrics to compute: "degree", "betweenness", "closeness", "pagerank". Default: all.
- limit: (optional) Max results per metric when entityNames is empty. Default: 10.
</parameters>

<examples>
- Top entities: {} (returns top 10 by all metrics)
- Specific entities: {"entityNames": ["Entity A", "Entity B"]}
- PageRank only: {"metrics": ["pagerank"], "limit": 20}
</examples>`;

const getGraphMetricsSchema: z.ZodRawShape = {
  entityNames: z.array(z.string().describe('Entity name')).optional().describe('Entity names to analyze'),
  metrics: z.array(z.string().describe('Metric name')).optional().describe('Metrics to compute: degree, betweenness, closeness, pagerank'),
  limit: z.number().optional().default(10).describe('Max results per metric'),
};

export const getGraphMetricsTool: ToolDefinition = {
  capability: getGraphMetricsCapability,
  description: getGraphMetricsDescription,
  schema: getGraphMetricsSchema,
  annotations: { readOnlyHint: true },
};

// === DETECT COMMUNITIES TOOL ===

const detectCommunitiesCapability: ToolCapabilityInfo = {
  description: 'Detect communities/clusters in the knowledge graph using Louvain algorithm',
  parameters: {
    type: 'object',
    properties: {
      resolution: {
        type: 'number',
        description: 'Resolution parameter for Louvain (higher = more communities). Default: 1.0',
        default: 1.0,
      },
    },
    required: [],
  },
};

const detectCommunitiesDescription: ToolRegistrationDescription = () => `<description>
Detect communities (clusters) in the knowledge graph using the Louvain modularity algorithm.
**Reveals natural groupings and topic clusters within your knowledge base.**
Automatically identifies which entities belong together based on connection patterns.
</description>

<importantNotes>
- (!important!) Uses Louvain algorithm — fast and effective for modularity optimization
- (!important!) Returns community assignments for every entity
- (!important!) Higher resolution parameter produces more, smaller communities
- (!important!) Modularity score indicates clustering quality (0-1, higher = better defined clusters)
</importantNotes>

<whenToUseThisTool>
- To discover natural topic clusters in your knowledge graph
- To understand how your knowledge is organized structurally
- Before reorganization — to see which entities naturally group together
- For identifying isolated clusters that may need cross-linking
- To validate that related entities are actually well-connected
</whenToUseThisTool>

<features>
- Louvain community detection with configurable resolution
- Returns named communities with member entities
- Modularity score for clustering quality assessment
- Community size distribution for balance analysis
- Cross-community relationship identification
</features>

<bestPractices>
- Start with default resolution (1.0), adjust if clusters are too large/small
- Resolution < 1.0 = fewer, larger communities; > 1.0 = more, smaller communities
- Single-entity communities may indicate orphaned or poorly connected entities
- Compare community structure over time to track knowledge evolution
- Use with getGraphMetrics to find important entities within each community
</bestPractices>

<parameters>
- resolution: (optional) Louvain resolution. Default: 1.0. Lower = fewer clusters, Higher = more clusters.
</parameters>

<examples>
- Default clustering: {}
- Fine-grained: {"resolution": 2.0}
- Coarse: {"resolution": 0.5}
</examples>`;

const detectCommunitiesSchema: z.ZodRawShape = {
  resolution: z.number().optional().default(1.0).describe('Louvain resolution parameter'),
};

export const detectCommunitiesTool: ToolDefinition = {
  capability: detectCommunitiesCapability,
  description: detectCommunitiesDescription,
  schema: detectCommunitiesSchema,
  annotations: { readOnlyHint: true },
};

// === ANALYZE GRAPH STRUCTURE TOOL ===

const analyzeGraphStructureCapability: ToolCapabilityInfo = {
  description: 'Analyze overall knowledge graph structure: density, components, diameter, clustering',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const analyzeGraphStructureDescription: ToolRegistrationDescription = () => `<description>
Analyze the overall structural properties of your knowledge graph.
**Provides a health dashboard for graph connectivity, density, and structure.**
Complements getKnowledgeGraphStats (which counts entities/relations) with structural analysis.
</description>

<importantNotes>
- (!important!) Returns graph-theoretic metrics: density, components, diameter, clustering coefficient
- (!important!) Identifies disconnected components (isolated subgraphs)
- (!important!) Detects structural issues: low density, fragmentation, bottlenecks
- (!important!) Computationally heavier than stats — use periodically, not every session
</importantNotes>

<whenToUseThisTool>
- For periodic graph health assessment (weekly or after major changes)
- To detect fragmentation — disconnected components that should be linked
- To measure graph density — is the knowledge well-interconnected?
- Before and after consolidation — to measure structural improvement
- When graph feels "sparse" and you want to quantify it
</whenToUseThisTool>

<features>
- Graph density (actual edges / possible edges)
- Connected component analysis with sizes
- Average clustering coefficient (local connectivity)
- Degree distribution statistics (min, max, avg, median)
- Isolated node detection
- Relationship type distribution
</features>

<bestPractices>
- Run after major entity additions to check integration
- Compare density over time — decreasing density may indicate growing but disconnected knowledge
- Multiple small components suggest domain silos that need cross-linking
- Use alongside detectCommunities for complete structural understanding
</bestPractices>

<parameters>
- None required — analyzes the entire graph structure
</parameters>

<examples>
- Full analysis: {} (no parameters needed)
</examples>`;

const analyzeGraphStructureSchema: z.ZodRawShape = {};

export const analyzeGraphStructureTool: ToolDefinition = {
  capability: analyzeGraphStructureCapability,
  description: analyzeGraphStructureDescription,
  schema: analyzeGraphStructureSchema,
  annotations: { readOnlyHint: true },
};

// === EXPORT ===

export const graphAnalyticsTools = {
  getGraphMetrics: getGraphMetricsTool,
  detectCommunities: detectCommunitiesTool,
  analyzeGraphStructure: analyzeGraphStructureTool,
};
