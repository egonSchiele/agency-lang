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

  /** Statelog config */
  log?: Partial<{
    host: string;
    projectId: string;
    debugMode: boolean;
  }>;

  client?: Partial<{
    logLevel: "error" | "warn" | "info" | "debug";
    defaultModel: string;
  }>;
}
