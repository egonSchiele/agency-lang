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
 * Maps Agency built-in function names to TypeScript equivalents
 */
export const BUILTIN_FUNCTIONS: Record<string, string> = {
  print: "_print",
  printJSON: "_printJSON",
  input: "_builtinInput",
  read: "_builtinRead",
  readImage: "_builtinReadImage",
  write: "_builtinWrite",
  fetch: "_builtinFetch",
  fetchJSON: "_builtinFetchJSON",
  fetchJson: "_builtinFetchJSON",
  sleep: "_builtinSleep",
  round: "_builtinRound",
};

export const BUILTIN_FUNCTIONS_TO_ASYNC: Record<string, boolean> = {
  print: false,
  input: false,
  read: true,
  readImage: true,
  write: false,
  fetch: true,
  fetchJSON: true,
  fetchJson: true,
  sleep: false,
};

export const BUILTIN_TOOLS = [
  "readSkill",
  "print",
  "printJSON",
  "input",
  "read",
  "readImage",
  "write",
  "fetch",
  "fetchJSON",
  "fetchJson",
  "sleep",
  "round",
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
  }>;

  /**
   * If true, untyped variables are errors.
   * If false (default), untyped variables are implicitly `any`.
   */
  strictTypes?: boolean;
}
