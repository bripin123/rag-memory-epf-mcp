import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { ToolDefinition, MCPTool } from './types.js';
import { knowledgeGraphTools } from './knowledge-graph-tools.js';
import { ragTools } from './rag-tools.js';
import { graphQueryTools } from './graph-query-tools.js';
import { graphAnalyticsTools } from './graph-analytics-tools.js';
import { migrationTools } from './migration-tools.js';

// Central registry of all tools
export const allTools = {
  ...knowledgeGraphTools,
  ...ragTools,
  ...graphQueryTools,
  ...graphAnalyticsTools,
  ...migrationTools,
};

// Global settings for tool descriptions.
// version 은 package.json 이 정본이다. 하드코딩하면 릴리스마다 이 값만 옛 버전으로
// 남아 도구 문서가 거짓을 말한다(실제로 3.1.0 에 멈춰 있었다 — advisor beta r3 남은 P2).
const PKG = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string };

export const globalSettings = {
  version: PKG.version,
  systemName: 'RAG Knowledge Graph MCP Server',
  defaultTimeout: 60,
};

/**
 * Convert a structured ToolDefinition to MCP tool format
 */
export function convertToMCPTool(name: string, toolDef: ToolDefinition): MCPTool {
  // Convert Zod schema to JSON schema properties
  const properties: Record<string, any> = {};
  const required: string[] = [];
  
  for (const [key, zodType] of Object.entries(toolDef.schema)) {
    // Extract the JSON schema representation from Zod
    const jsonSchema = zodTypeToJsonSchema(zodType, key);
    properties[key] = jsonSchema;
    
    // Check if required (not optional)
    if (!zodType.isOptional?.()) {
      required.push(key);
    }
  }
  
  return {
    name,
    description: toolDef.description(globalSettings),
    inputSchema: {
      type: 'object',
      properties,
      required,
      // validateToolArgs 가 최상위를 strict 로 검증한다. 광고 스키마가 그걸 말하지
      // 않으면 클라이언트는 여분 필드가 허용된다고 읽고 서버에서 거부당한다
      // (advisor beta r3: 계약 표현 불일치).
      additionalProperties: false,
    },
    ...(toolDef.annotations && { annotations: toolDef.annotations }),
  };
}

/**
 * Convert Zod type to JSON schema (simplified)
 */
function zodTypeToJsonSchema(zodType: any, fieldName: string): any {
  // Handle common Zod types
  if (zodType._def) {
    const def = zodType._def;
    
    switch (def.typeName) {
      case 'ZodString':
        return {
          type: 'string',
          description: def.description || `${fieldName} parameter`,
        };
      
      case 'ZodNumber':
        return {
          type: 'number',
          description: def.description || `${fieldName} parameter`,
          ...(def.default !== undefined && { default: def.default }),
        };
      
      case 'ZodBoolean':
        return {
          type: 'boolean',
          description: def.description || `${fieldName} parameter`,
          ...(def.default !== undefined && { default: def.default }),
        };
      
      case 'ZodArray':
        return {
          type: 'array',
          description: def.description || `Array of ${fieldName}`,
          items: zodTypeToJsonSchema(def.type, `${fieldName} item`),
        };
      
      case 'ZodObject':
        const objectProperties: Record<string, any> = {};
        const objectRequired: string[] = [];
        
        for (const [key, value] of Object.entries(def.shape())) {
          objectProperties[key] = zodTypeToJsonSchema(value, key);
          if (!(value as any).isOptional?.()) {
            objectRequired.push(key);
          }
        }
        
        return {
          type: 'object',
          description: def.description || `${fieldName} object`,
          properties: objectProperties,
          required: objectRequired,
        };
      
      case 'ZodRecord':
        return {
          type: 'object',
          description: def.description || `${fieldName} record`,
          additionalProperties: true,
        };

      // Enums and literals used to fall through to the string fallback, which dropped the
      // allowed values from the advertised schema even though parse() still enforced them.
      // A client that cannot see the values guesses, and the guess is rejected server-side.
      case 'ZodEnum':
        return {
          type: 'string',
          description: def.description || `${fieldName} parameter`,
          enum: [...def.values],
        };

      case 'ZodLiteral':
        return {
          type: typeof def.value === 'number' ? 'number'
            : typeof def.value === 'boolean' ? 'boolean' : 'string',
          description: def.description || `${fieldName} parameter`,
          enum: [def.value],
        };
      
      // union 도 같은 fallback 함정이었다: deleteDocuments 의 documentIds 는
      // string | string[] 인데 광고 스키마에 type:'string' 으로 나가 배열을 보내면
      // 클라이언트가 계약 위반이라고 읽는다. anyOf 로 정직하게 노출한다.
      case 'ZodUnion':
        return {
          description: def.description || `${fieldName} parameter`,
          anyOf: (def.options as any[]).map((o, i) => zodTypeToJsonSchema(o, `${fieldName} option ${i}`)),
        };

      case 'ZodOptional':
        const innerSchema = zodTypeToJsonSchema(def.innerType, fieldName);
        return {
          ...innerSchema,
          optional: true,
        };
      
      case 'ZodDefault':
        const defaultSchema = zodTypeToJsonSchema(def.innerType, fieldName);
        return {
          ...defaultSchema,
          default: def.defaultValue(),
        };
      
      default:
        console.warn(`Unknown Zod type: ${def.typeName} for field ${fieldName}`);
        return {
          type: 'string',
          description: `${fieldName} parameter (fallback)`,
        };
    }
  }
  
  // Fallback for unknown types
  return {
    type: 'string',
    description: `${fieldName} parameter`,
  };
}

/**
 * Get all tools in MCP format
 */
export function getAllMCPTools(): MCPTool[] {
  return Object.entries(allTools).map(([name, toolDef]) => 
    convertToMCPTool(name, toolDef)
  );
}

/**
 * Get a specific tool definition by name
 */
export function getToolDefinition(name: string): ToolDefinition | undefined {
  return (allTools as any)[name];
}

/**
 * Validate tool arguments using Zod schema
 */
export function validateToolArgs<T>(toolName: string, args: any): T {
  const toolDef = getToolDefinition(toolName);
  if (!toolDef) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  
  // strict: 알 수 없는 최상위 인자는 거부한다. 기본 strip 은 오래된 호출자를
  // **조용히** 통과시킨다 — v3.6 의 index 기반 관찰 지정(`{observation_id, index}`,
  // `{observation_index}`)이 아무 오류 없이 무시되고, 호출자는 자기가 지정한
  // revision 이 아닌 다른 것이 처리됐다는 사실을 모른다(spec T6, advisor beta 발견 4-1).
  const schema = z.object(toolDef.schema).strict();
  return schema.parse(args) as T;
}

/**
 * Get tool names organized by category
 */
export function getToolsByCategory() {
  return {
    knowledgeGraph: Object.keys(knowledgeGraphTools),
    rag: Object.keys(ragTools),
    graphQuery: Object.keys(graphQueryTools),
    graphAnalytics: Object.keys(graphAnalyticsTools),
    migration: Object.keys(migrationTools),
    all: Object.keys(allTools),
  };
}

/**
 * Get comprehensive tool documentation
 */
export function getToolDocumentation(toolName: string): string {
  const toolDef = getToolDefinition(toolName);
  if (!toolDef) {
    return `Tool '${toolName}' not found`;
  }
  
  return toolDef.description(globalSettings);
}

/**
 * Get system information and tool summary
 */
export function getSystemInfo() {
  const categories = getToolsByCategory();
  return {
    system: globalSettings,
    toolCounts: {
      knowledgeGraph: categories.knowledgeGraph.length,
      rag: categories.rag.length,
      graphQuery: categories.graphQuery.length,
      graphAnalytics: categories.graphAnalytics.length,
      total: categories.all.length,
    },
    availableTools: categories,
  };
} 