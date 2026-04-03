import { AgencyNode } from "./types.js";

export const TYPES_THAT_DONT_TRIGGER_NEW_PART: AgencyNode["type"][] = [
  "typeHint",
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
   * Example: ["comment", "typeHint"]
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

  /** Audit logging config */
  audit?: {
    logFile?: string;
  };

  /** Checkpoint configuration */
  checkpoints?: {
    /** Maximum number of times a single checkpoint can be restored before throwing CheckpointError.
     * Prevents infinite restore loops. Default: 100. */
    maxRestores?: number;
  };

  /** Enable execution tracing — writes checkpoints to a .agencytrace file */
  trace?: boolean;

  /** Custom path for the trace file (default: <program>.agencytrace) */
  traceFile?: string;

  /** Test runner configuration */
  test?: {
    /** Number of test files to run in parallel. Default: 1 (sequential). */
    parallel?: number;
  };
}
