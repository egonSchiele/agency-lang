import { AgencyNode } from "./types.js";
import { z } from "zod";
import type { McpServerConfig } from "./runtime/mcp/types.js";

export const TYPES_THAT_DONT_TRIGGER_NEW_PART: AgencyNode["type"][] = [
  "typeAlias",
  "usesTool",
  "comment",
  "newLine",
  "importStatement",
  "importNodeStatement",
  "importToolStatement",
];

/**
 * Maps Agency built-in function names to TypeScript equivalents.
 * Most map to themselves; exceptions are names that shadow JS globals.
 */
export const BUILTIN_FUNCTIONS: Record<string, string> = {
};

export const BUILTIN_TOOLS = [
  "readSkill",
];

export const BUILTIN_VARIABLES = ["color"];

/**
 * Configuration options for the Agency compiler
 */
export interface AgencyConfig {
  verbose?: boolean;
  outDir?: string;

  /**
   * Array of AST node types to exclude from code generation
   * Example: ["comment", "typeAlias"]
   */
  excludeNodeTypes?: string[];

  /**
   * Array of built-in function names to exclude from code generation
   * Example: ["fetch", "write"]
   */
  excludeBuiltinFunctions?: string[];

  /**
   * Array of domains allowed for fetch operations
   * If specified, only these domains can be fetched
   * Example: ["api.example.com", "data.mysite.com"]
   */
  allowedFetchDomains?: string[];

  /**
   * Array of domains disallowed for fetch operations
   * These domains will throw an error if fetch is attempted
   * If both allowed and disallowed are set, takes the intersection
   * (only allowed domains, minus disallowed ones)
   * Example: ["malicious.com", "blocked.site.com"]
   */
  disallowedFetchDomains?: string[];

  /**
   * Optionally specify a custom host for tarsec trace collection
   */
  tarsecTraceHost?: string;

  /**
   * Number of times the LLM can go back and forth between calling tools
   * and responding to their outputs before halting execution to prevent infinite loops.
   * Default 10.
   */
  maxToolCallRounds?: number;

  /** Statelog config */
  log?: Partial<{
    host: string;
    projectId: string;
    debugMode: boolean;
    apiKey: string;
  }>;

  /** Smoltalk client config */
  client?: Partial<{
    logLevel: "error" | "warn" | "info" | "debug";
    defaultModel: string;
    openAiApiKey: string;
    googleApiKey: string;
    statelog?: Partial<{
      host: string;
      projectId: string;
      apiKey: string;
    }>;
  }>;

  /**
   * If true, untyped variables are errors.
   * If false (default), untyped variables are implicitly `any`.
   */
  strictTypes?: boolean;

  /**
   * If true, run type checking during compilation and print warnings.
   */
  typeCheck?: boolean;

  /**
   * If true, type errors are fatal during compilation (implies typeCheck: true).
   */
  typeCheckStrict?: boolean;


  /**
   * If true, validate that import paths resolve within the project directory.
   * Prevents path traversal attacks via imports like `../../etc/passwd`.
   */
  restrictImports?: boolean;

  /** Enable debugger mode — auto-inserts breakpoints before every step */
  debugger?: boolean;

  /** Whether to emit debugStep() instrumentation in compiled output (default: true).
   *  Set to false to eliminate per-step overhead when tracing/debugging is not needed. */
  instrument?: boolean;

  /** Checkpoint configuration */
  checkpoints?: {
    /** Maximum number of times a single checkpoint can be restored before throwing CheckpointError.
     * Prevents infinite restore loops. Default: 100. */
    maxRestores?: number;
  };

  /** Enable execution tracing — writes checkpoints to a .trace file */
  trace?: boolean;

  /** Custom path for the trace file (default: <program>.trace) */
  traceFile?: string;

  /** Directory for auto-generated trace files. Each execution creates a new file
   *  named <timestamp>_<id>.agencytrace. */
  traceDir?: string;

  /** Directory containing pre-compiled JS output (e.g., "dist").
   *  When set, the debugger imports compiled modules from this directory
   *  instead of compiling on the fly. Resolved relative to cwd. */
  distDir?: string;

  /** Test runner configuration */
  test?: {
    /** Number of test files to run in parallel. Default: 1 (sequential). */
    parallel?: number;
  };

  doc?: {
    /** Output directory for generated documentation (default: "docs") */
    outDir?: string;

    /** Base URL for source links in generated docs */
    baseUrl?: string;
  }

  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig>;
}

// --- Zod schema for runtime validation of agency.json ---

const McpStdioServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const McpHttpServerSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
});

const McpServerSchema = z.union([McpStdioServerSchema, McpHttpServerSchema]);

export const AgencyConfigSchema = z.object({
  verbose: z.boolean().optional(),
  outDir: z.string().optional(),
  excludeNodeTypes: z.array(z.string()).optional(),
  excludeBuiltinFunctions: z.array(z.string()).optional(),
  allowedFetchDomains: z.array(z.string()).optional(),
  disallowedFetchDomains: z.array(z.string()).optional(),
  tarsecTraceHost: z.string().optional(),
  maxToolCallRounds: z.number().optional(),
  log: z.object({
    host: z.string().optional(),
    projectId: z.string().optional(),
    debugMode: z.boolean().optional(),
    apiKey: z.string().optional(),
  }).optional(),
  client: z.object({
    logLevel: z.enum(["error", "warn", "info", "debug"]).optional(),
    defaultModel: z.string().optional(),
    openAiApiKey: z.string().optional(),
    googleApiKey: z.string().optional(),
    statelog: z.object({
      host: z.string().optional(),
      projectId: z.string().optional(),
      apiKey: z.string().optional(),
    }).optional(),
  }).optional(),
  strictTypes: z.boolean().optional(),
  typeCheck: z.boolean().optional(),
  typeCheckStrict: z.boolean().optional(),
  restrictImports: z.boolean().optional(),
  debugger: z.boolean().optional(),
  instrument: z.boolean().optional(),
  checkpoints: z.object({
    maxRestores: z.number().optional(),
  }).optional(),
  trace: z.boolean().optional(),
  traceFile: z.string().optional(),
  traceDir: z.string().optional(),
  distDir: z.string().optional(),
  test: z.object({
    parallel: z.number().optional(),
  }).optional(),
  doc: z.object({
    outDir: z.string().optional(),
    baseUrl: z.string().optional(),
  }).optional(),
  mcpServers: z.record(z.string(), McpServerSchema).optional(),
}).passthrough();
