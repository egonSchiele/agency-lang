import { AgencyNode } from "./types.js";
import { z } from "zod";
import type { McpServerConfig } from "./runtime/mcp/types.js";
import * as fs from "fs";
import * as path from "path";

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
  };

  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig>;
}

// --- Zod schema for runtime validation of agency.json ---

const McpStdioServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict();

const McpHttpServerSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
}).strict();

const McpServerSchema = z.union([McpStdioServerSchema, McpHttpServerSchema]);

export const AgencyConfigSchema = z.object({
  verbose: z.boolean(),
  outDir: z.string(),
  excludeNodeTypes: z.array(z.string()),
  excludeBuiltinFunctions: z.array(z.string()),
  allowedFetchDomains: z.array(z.string()),
  disallowedFetchDomains: z.array(z.string()),
  tarsecTraceHost: z.string(),
  maxToolCallRounds: z.number(),
  log: z.object({ host: z.string(), projectId: z.string(), debugMode: z.boolean(), apiKey: z.string() }).partial(),
  client: z.object({
    logLevel: z.enum(["error", "warn", "info", "debug"]),
    defaultModel: z.string(),
    openAiApiKey: z.string(),
    googleApiKey: z.string(),
    statelog: z.object({ host: z.string(), projectId: z.string(), apiKey: z.string() }).partial(),
  }).partial(),
  strictTypes: z.boolean(),
  typeCheck: z.boolean(),
  typeCheckStrict: z.boolean(),
  restrictImports: z.boolean(),
  debugger: z.boolean(),
  instrument: z.boolean(),
  checkpoints: z.object({ maxRestores: z.number() }).partial(),
  trace: z.boolean(),
  traceFile: z.string(),
  traceDir: z.string(),
  distDir: z.string(),
  test: z.object({ parallel: z.number() }).partial(),
  doc: z.object({ outDir: z.string(), baseUrl: z.string() }).partial(),
  mcpServers: z.record(z.string(), McpServerSchema),
}).partial().passthrough();

/**
 * Load agency.json at the given path without calling process.exit.
 * Returns the parsed config, or an error message if the file is invalid.
 * Returns an empty config if the file doesn't exist.
 */
export function loadConfigSafe(
  configPath: string,
): { config: AgencyConfig; error?: string } {
  if (!fs.existsSync(configPath)) {
    return { config: {} };
  }
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    const result = AgencyConfigSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
        .join("\n");
      return {
        config: {},
        error: `Invalid agency.json config:\n${issues}`,
      };
    }
    return { config: result.data as AgencyConfig };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      config: {},
      error: `Error loading config from ${configPath}: ${message}`,
    };
  }
}

/**
 * Find the agency.json for a given file path by searching upward.
 * Returns the directory containing agency.json, or null if not found.
 */
export function findProjectRoot(startPath: string): string | null {
  let current = fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(startPath);

  while (true) {
    if (fs.existsSync(path.join(current, "agency.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
