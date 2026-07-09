import { AgencyNode } from "./types.js";
import type { LogLevel } from "./logger.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

export const TYPES_THAT_DONT_TRIGGER_NEW_PART: AgencyNode["type"][] = [
  "typeAlias",
  "comment",
  "newLine",
  "importStatement",
  "importNodeStatement",
];

/**
 * Maps Agency built-in function names to TypeScript equivalents.
 * Most map to themselves; exceptions are names that shadow JS globals.
 */
export const BUILTIN_FUNCTIONS: Record<string, string> = {};

export const BUILTIN_TOOLS: string[] = [];

export const BUILTIN_VARIABLES = ["color"];

/** Reply-attachment caps (tools showing images to the model — see
 *  docs/dev/reply-attachments.md). The byte cap mirrors smoltalk's
 *  DEFAULT_MAX_ATTACHMENT_BYTES (20 MB, enforced again at send time);
 *  smoltalk does not currently export that constant from its index —
 *  keep in sync if that changes. The count cap is ours and matches the
 *  agent's user-attachment detection limit. */
export const MAX_REPLY_ATTACHMENTS_PER_CALL = 10;
export const MAX_REPLY_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Configuration options for the Agency compiler
 */
export interface AgencyConfig {
  verbose?: boolean;
  logLevel?: LogLevel;
  outDir?: string;

  /**
   * Number of times the LLM can go back and forth between calling tools
   * and responding to their outputs before halting execution to prevent infinite loops.
   * Default 10.
   */
  maxToolCallRounds?: number;

  /**
   * Enable observability. When false (default), the StatelogClient is a
   * complete no-op — no events are emitted and no network calls are made.
   * Set to true to activate structured event logging via the `log` config.
   */
  observability?: boolean;

  /** Statelog config */
  log?: Partial<{
    host: string;
    projectId: string;
    debugMode: boolean;
    apiKey: string;
    /**
     * Local file sink. When set, each statelog event is appended as a
     * single JSON object per line. Intended for local development and
     * tests. Can be combined with `host` — both sinks receive events.
     */
    logFile: string;
    /**
     * Per-event remote-send timeout in milliseconds. Bounds how long
     * `agency` can wait on a slow/unreachable statelog host before
     * giving up — prevents the http POST at end-of-run from delaying
     * process exit. Default: 1500ms.
     */
    requestTimeoutMs: number;
    metadata: {
      tags?: string[];
      environment?: string;
      userId?: string;
      agentVersion?: string;
      custom?: Record<string, string>;
    };
  }>;

  /** Eval command configuration */
  eval?: {
    runsDir?: string;
    optimizeRunsDir?: string;
    optimize?: {
      goal?: string;
      graders?: string;                              // path to a TS grading module
      optimizer?: string;                            // built-in name or path to a TS/JS optimizer module
      validation?: { inputs?: string; split?: number };
    };
  };

  /** Smoltalk client config */
  client?: Partial<{
    logLevel: "error" | "warn" | "info" | "debug";
    defaultModel: string;
    defaultProvider: string;
    apiKey: {
      openAi?: string;
      google?: string;
      anthropic?: string;
      ollama?: string;
      openRouter?: string;
      deepInfra?: string;
      liteLlm?: string;
      openAiCompat?: string;
    };
    baseUrl: {
      openRouter?: string;
      deepInfra?: string;
      liteLlm?: string;
      openAiCompat?: string;
    };
    /**
     * Max characters of a single tool result fed back to the LLM.
     * Results longer than this are truncated (with a marker) in what
     * the model sees — the full value is still returned to Agency code.
     * Prevents one tool (e.g. a recursive `ls`) from blowing the
     * context window. Default 100000; `0` disables the cap. Override
     * per call with `llm(..., { maxToolResultChars })`.
     */
    maxToolResultChars: number;
    /**
     * Paths to user-authored "provider module" ES files loaded at
     * startup. Each must export `register({ registerProvider })` and call
     * `registerProvider(name, ClientClass)` to register a custom smoltalk
     * provider (e.g. a local model via `smoltalk-llama-cpp`). Relative
     * paths resolve against the current working directory. Merged with
     * the `AGENCY_PROVIDER_MODULES` env var at runtime.
     */
    providerModules: string[];
    /** Short name → Hugging Face URI aliases for local models, used by
     *  `std::agency/local` and the `agency local` CLI. Read and written at
     *  runtime (not compile-time baked) so `agency local alias` edits take
     *  effect on the next run. */
    modelAliases: Record<string, string>;
    /** Directory downloaded local models are cached in. Overridden by the
     *  `AGENCY_MODELS_DIR` env var; defaults to `~/.agency-agent/models`. Read
     *  at runtime by `std::agency/local` and the `agency local` CLI. */
    modelsDir: string;
    statelog?: Partial<{
      host: string;
      projectId: string;
      apiKey: string;
    }>;
  }>;

  /**
   * Type checker configuration. Controls which checks run and their severity.
   */
  typechecker?: {
    /** If true, run type checking during compilation and print warnings. Default: false. */
    enabled?: boolean;
    /** If true, type errors are fatal during compilation (implies enabled: true). Default: false. */
    strict?: boolean;
    /** If true, untyped variables are errors. Default: false. */
    strictTypes?: boolean;
    /**
     * What to do when a function call cannot be resolved:
     * - "silent": ignore
     * - "warn": emit a warning (default)
     * - "error": emit an error
     */
    undefinedFunctions?: "silent" | "warn" | "error";
    /**
     * What to do when a variable reference cannot be resolved:
     * - "silent": ignore (default for the initial landing)
     * - "warn": emit a warning
     * - "error": emit an error
     */
    undefinedVariables?: "silent" | "warn" | "error";
    /**
     * Strictness of union member access. When a property exists on some but
     * not all members of an un-narrowed union (e.g. `r.value` on an
     * un-guarded `Result`), this governs the diagnostic:
     * - "silent": no diagnostic (lenient — such accesses type as `any`)
     * - "warn": emit a warning
     * - "error": emit an error (default)
     * Narrow first (guard / `catch` / `match`) to access branch-specific
     * members safely. Set to "silent" to opt out and restore the old lenient
     * behavior.
     */
    strictMemberAccess?: "silent" | "warn" | "error";
    /**
     * Whether a `match` over a closed value type (a Result, or a closed
     * literal/value union) that doesn't cover every case and has no `_` arm is
     * a diagnostic:
     * - "silent": no diagnostic (default)
     * - "warn": emit a warning
     * - "error": emit an error
     * Conservative: open types (string/number/any, effect sets) are never
     * required to be exhaustive; only a `_` arm satisfies them.
     */
    matchExhaustiveness?: "silent" | "warn" | "error";
    /**
     * What to do when a function that declares a non-void return type can reach
     * the end of its body without `return`ing a value (Agency has no implicit
     * returns). Default `"warn"`.
     */
    definiteReturns?: "silent" | "warn" | "error";
  };

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

  /** Maximum logical function-call nesting depth before the runaway-recursion
   * guard throws CallDepthExceededError. Catches unbounded recursion — most
   * importantly the async kind, which grows the promise chain until the process
   * OOMs with no useful diagnostic — before it exhausts memory. Raise this for
   * programs that legitimately recurse very deeply. Default: 2048. */
  maxCallDepth?: number;

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

  /**
   * Enables the memory layer for this project. When set, every agent run
   * receives a `MemoryManager` on its RuntimeContext, std::memory becomes
   * usable, and `llm({ memory: true })` injects relevant facts.
   */
  memory?: {
    /** Directory where per-memoryId subdirectories of JSON files are stored. */
    dir: string;
    /** Default model used for extraction / compaction / LLM-tier recall. */
    model?: string;
    autoExtract?: {
      /** Number of LLM turns between auto-extraction passes. Default: 5. */
      interval?: number;
    };
    compaction?: {
      /** Trigger metric: "token" estimates or raw "messages" count. */
      trigger?: "token" | "messages";
      /** Threshold above which compaction runs. */
      threshold?: number;
    };
    embeddings?: {
      /** Embedding model name (forwarded to smoltalk.embed). */
      model?: string;
    };
  };

  /**
   * Visual thresholds used by `agency logs view`. Durations at or
   * above `slowMs` (default 5000) render bright-red; durations below
   * `fastMs` (default 100) render gray. Costs at or above
   * `expensiveUsd` (default 0.01) render bright-red.
   */
  viewer?: {
    slowMs?: number;
    fastMs?: number;
    expensiveUsd?: number;
  };

  /*
   * Configuration for `agency pack`.
   */
  pack?: {
    /**
     * Output module format. Default: "esm". CJS output is useful when
     * embedding the bundle in a project whose package.json sets
     * `"type": "commonjs"` and the surrounding tooling expects CommonJS.
     */
    format?: "esm" | "cjs";
    /**
     * esbuild `target` string (e.g. "node20", "node22"). Default: "node20".
     */
    target?: string;
    /**
     * Additional bare specifiers to keep external (in addition to Node
     * built-ins). Use sparingly — anything listed here must already be
     * installed wherever the bundle runs.
     */
    external?: string[];
  };

  coverage?: {
    /** Output directory for collected coverage data (default: ".coverage") */
    outDir?: string;

    /**
     * Minimum acceptable total coverage percentage (0–100).
     * `agency coverage report` exits with code 1 when total coverage falls
     * below this value. Overridden by the CLI `--threshold` flag.
     */
    threshold?: number;

    /**
     * Per-file minimum coverage percentage (0–100). Each individual file
     * must be at or above this value, in addition to the overall threshold.
     */
    perFileThreshold?: number;

    /**
     * Glob patterns of source files to exclude from coverage reports
     * (relative to the project root, picomatch syntax). Useful for
     * generated code, examples, or files you intentionally do not test.
     *
     * Example: ["examples/**", "stdlib/legacy/**"]
     */
    exclude?: string[];
  };
}

// --- Zod schema for runtime validation of agency.json ---

export const AgencyConfigSchema = z
  .object({
    verbose: z.boolean(),
    logLevel: z.enum(["debug", "info", "warn", "error"]),
    outDir: z.string(),
    maxToolCallRounds: z.number(),
    observability: z.boolean(),
    log: z
      .object({
        host: z.string(),
        projectId: z.string(),
        debugMode: z.boolean(),
        apiKey: z.string(),
        logFile: z.string(),
        requestTimeoutMs: z.number().int().positive(),
        metadata: z
          .object({
            tags: z.array(z.string()),
            environment: z.string(),
            userId: z.string(),
            agentVersion: z.string(),
            custom: z.record(z.string(), z.string()),
          })
          .partial(),
      })
      .partial(),
    eval: z
      .object({
        runsDir: z.string(),
        optimizeRunsDir: z.string(),
        optimize: z
          .object({
            goal: z.string().optional(),
            graders: z.string().optional(),
            optimizer: z.string().optional(),
            validation: z.object({ inputs: z.string().optional(), split: z.number().optional() }).optional(),
          })
          .partial()
          .optional(),
      })
      .partial(),
    client: z
      .object({
        logLevel: z.enum(["error", "warn", "info", "debug"]),
        defaultModel: z.string(),
        defaultProvider: z.string(),
        apiKey: z
          .object({
            openAi: z.string(),
            google: z.string(),
            anthropic: z.string(),
            ollama: z.string(),
            openRouter: z.string(),
            deepInfra: z.string(),
            liteLlm: z.string(),
            openAiCompat: z.string(),
          })
          .partial(),
        baseUrl: z
          .object({
            openRouter: z.string(),
            deepInfra: z.string(),
            liteLlm: z.string(),
            openAiCompat: z.string(),
          })
          .partial(),
        maxToolResultChars: z.number(),
        providerModules: z.array(z.string()),
        modelAliases: z.record(z.string(), z.string()),
        modelsDir: z.string(),
        statelog: z
          .object({
            host: z.string(),
            projectId: z.string(),
            apiKey: z.string(),
          })
          .partial(),
      })
      .partial(),
    typechecker: z
      .object({
        enabled: z.boolean(),
        strict: z.boolean(),
        strictTypes: z.boolean(),
        undefinedFunctions: z.enum(["silent", "warn", "error"]),
        undefinedVariables: z.enum(["silent", "warn", "error"]),
        strictMemberAccess: z.enum(["silent", "warn", "error"]),
        matchExhaustiveness: z.enum(["silent", "warn", "error"]),
        definiteReturns: z.enum(["silent", "warn", "error"]),
      })
      .partial(),
    debugger: z.boolean(),
    instrument: z.boolean(),
    checkpoints: z.object({ maxRestores: z.number() }).partial(),
    // A positive integer. The guard trips when depth > limit and the first
    // call is depth 1, so a value < 1 (or a float/NaN) would make every call
    // throw — reject it at config-load rather than bricking the program.
    maxCallDepth: z.number().int().positive(),
    trace: z.boolean(),
    traceFile: z.string(),
    traceDir: z.string(),
    distDir: z.string(),
    test: z.object({ parallel: z.number() }).partial(),
    doc: z.object({ outDir: z.string(), baseUrl: z.string() }).partial(),
    viewer: z
      .object({
        slowMs: z.number(),
        fastMs: z.number(),
        expensiveUsd: z.number(),
      })
      .partial(),
    coverage: z
      .object({
        outDir: z.string(),
        threshold: z.number().min(0).max(100),
        perFileThreshold: z.number().min(0).max(100),
        exclude: z.array(z.string()),
      })
      .partial(),
    pack: z
      .object({
        format: z.enum(["esm", "cjs"]),
        target: z.string(),
        external: z.array(z.string()),
      })
      .partial(),
    memory: z.object({
      dir: z.string(),
      model: z.string().optional(),
      autoExtract: z
        .object({ interval: z.number().optional() })
        .optional(),
      compaction: z
        .object({
          trigger: z.enum(["token", "messages"]).optional(),
          threshold: z.number().optional(),
        })
        .optional(),
      embeddings: z
        .object({ model: z.string().optional() })
        .optional(),
    }),
  })
  .partial()
  .passthrough();

/**
 * Load agency.json at the given path without calling process.exit.
 * Returns the parsed config, or an error message if the file is invalid.
 * Returns an empty config if the file doesn't exist.
 */
export function loadConfigSafe(configPath: string): {
  config: AgencyConfig;
  error?: string;
} {
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
    if (result.data.verbose) {
      console.log(`Loaded config from ${configPath}:`);
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
  let current =
    fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
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

// ════════════════════════════════════════════════════════════════════════
// Config resolution — the single source of truth
//
// A program's effective AgencyConfig is assembled from three sources, listed
// here in increasing precedence:
//
//   1. agency.json           — the file, found by walking up from cwd
//                              (loadConfigSafe / findProjectRoot). The base.
//   2. CLI flags             — per-invocation flags (--trace, --log-file,
//                              --strict, ...) mapped onto config by
//                              applyCliFlags(). This is the ONLY place that
//                              defines what each flag means in config terms.
//   3. AGENCY_CONFIG_OVERRIDES — a JSON Partial<AgencyConfig> in the
//                              environment (readConfigOverrides). Used to push
//                              config INTO a process whose config was baked at
//                              compile time and can't be re-derived from source
//                              (the precompiled built-in agents; `agency pack`
//                              bundles). The env-transport twin of the
//                              subprocess IPC `configOverrides` message.
//
// WHERE each source is applied:
//   • CLI (scripts/agency.ts): sources 1 ⊕ 2. The result is baked into the
//     generated program at compile time.
//   • Runtime (RuntimeContext constructor): the baked config ⊕ source 3, via
//     applyRuntimeConfigOverridesToContextArgs(). Env overrides are applied
//     HERE, not at CLI time, precisely because their job is to reach a process
//     that has already been compiled.
// ════════════════════════════════════════════════════════════════════════

/** Per-invocation flags accepted by `agency run`/`compile` and forwarded to the
 *  bundled agents. Mapped onto AgencyConfig by applyCliFlags. `trace` is
 *  `string` for `--trace <file>`, `true` for a bare `--trace`. */
export type CliFlags = {
  trace?: string | true;
  logFile?: string;
  observability?: boolean;
  strict?: boolean;
};

/**
 * Fold per-invocation CLI flags onto a config COPY (never mutates the input).
 * The single definition of what each debug flag means:
 *   --trace <file>   → trace + traceFile=<file>
 *   --trace (bare)   → trace + traceFile=<input>.trace when an input path is
 *                      known (agency run), else traceDir="." (a bundled agent
 *                      with no input file → a per-run file in cwd)
 *   --log-file <p>   → log.logFile=<p> and observability=true
 *   --observability  → observability=true
 *   --strict         → typechecker.strict + strictTypes (the compile-path gate
 *                      never runs the checker on strictTypes alone)
 */
export function applyCliFlags(
  config: AgencyConfig,
  flags: CliFlags,
  input?: string,
): AgencyConfig {
  const next: AgencyConfig = { ...config };
  if (flags.trace !== undefined) {
    next.trace = true;
    const explicitFile = typeof flags.trace === "string" && flags.trace !== "";
    if (explicitFile) {
      next.traceFile = flags.trace as string;
    } else if (input) {
      next.traceFile = input.replace(/\.agency$/, ".trace");
    } else {
      next.traceDir = ".";
    }
  }
  if (flags.logFile) {
    next.log = { ...next.log, logFile: flags.logFile };
    next.observability = true;
  }
  if (flags.observability) {
    next.observability = true;
  }
  if (flags.strict) {
    next.typechecker = { ...next.typechecker, strict: true, strictTypes: true };
  }
  return next;
}

/** The one env var carrying a JSON Partial<AgencyConfig> into an already-compiled
 *  process (see the source-of-truth note above, source 3). */
export const CONFIG_OVERRIDES_ENV = "AGENCY_CONFIG_OVERRIDES";

/** Serialize config overrides for a child process's AGENCY_CONFIG_OVERRIDES. */
export function serializeConfigOverrides(
  overrides: Partial<AgencyConfig>,
): string {
  return JSON.stringify(overrides);
}

/** Read + validate AGENCY_CONFIG_OVERRIDES. Returns {} when the var is absent,
 *  unparseable, or fails schema validation, so a malformed value can never
 *  brick startup. */
export function readConfigOverrides(
  env: NodeJS.ProcessEnv = process.env,
): Partial<AgencyConfig> {
  const raw = env[CONFIG_OVERRIDES_ENV];
  if (!raw) return {};
  try {
    const result = AgencyConfigSchema.safeParse(JSON.parse(raw));
    return result.success ? (result.data as Partial<AgencyConfig>) : {};
  } catch {
    return {};
  }
}

/** Return a deep copy of `config` with secret-bearing fields masked, for
 *  human-facing output (`agency config show`). Masks every `apiKey` — the
 *  top-level `log.apiKey` string and each key under `client.apiKey` /
 *  `client.statelog.apiKey` — to `•••<last4>`. */
export function redactConfigSecrets(config: AgencyConfig): AgencyConfig {
  const mask = (value: string): string =>
    value.length <= 4 ? "•••" : `•••${value.slice(-4)}`;
  const clone = JSON.parse(JSON.stringify(config)) as AgencyConfig;
  const redactKeyMap = (obj: Record<string, unknown> | undefined): void => {
    if (!obj) return;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "string") obj[key] = mask(obj[key] as string);
    }
  };
  if (clone.log && typeof clone.log.apiKey === "string") {
    clone.log.apiKey = mask(clone.log.apiKey);
  }
  redactKeyMap(clone.client?.apiKey as Record<string, unknown> | undefined);
  if (clone.client?.statelog && typeof clone.client.statelog.apiKey === "string") {
    clone.client.statelog.apiKey = mask(clone.client.statelog.apiKey);
  }
  return clone;
}
