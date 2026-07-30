import { z } from 'zod';

// Tool capability information (corresponds to MCP tool schema)
export interface ToolCapabilityInfo {
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      optional?: boolean;
      items?: { type: string };
      additionalProperties?: boolean;
      default?: any;
    }>;
    required: string[];
  };
}

// Tool registration description (rich documentation)
export type ToolRegistrationDescription = (globalSettings?: any) => string;

// Tool annotations (MCP SDK 1.11.0+)
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// Combined tool definition
export interface ToolDefinition {
  capability: ToolCapabilityInfo;
  description: ToolRegistrationDescription;
  schema: z.ZodRawShape;
  annotations?: ToolAnnotations;
}

// MCP Tool for registration
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
    // validateToolArgs 가 최상위를 strict 로 검증하므로 광고 스키마도 그렇게 말한다.
    additionalProperties?: boolean;
  };
  annotations?: ToolAnnotations;
}