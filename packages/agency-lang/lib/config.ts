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

export const BUILTIN_VARIABLES = ["color", "__dirname"];

/** Reply-attachment caps (tools showing images to the model — see
 *  docs/dev/agents/reply-attachments.md). The byte cap mirrors smoltalk's
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

  /**
   * Let a compile-time splice run a generator that imports JavaScript.
   *
   * By default a generator may import only `std::` modules and other
   * `.agency` files in your project. That restriction is what makes the
   * safety story work: dangerous operations in Agency ask permission, and
   * compilation answers nothing, so they cannot complete. JavaScript asks
   * nothing, so a generator that reaches an npm package is unchecked.
   *
   * Turn this on if a generator genuinely needs a JavaScript library, and
   * know that the generator can then do anything that library can.
   */
  allowNonAgencyGenerators?: boolean;

  /**
   * Refuse to compile a file containing a compile-time splice, instead of
   * running the generator.
   *
   * Compiling a `$( ... )` runs the generator during compilation, so
   * compiling a file you have not read executes code you have not read.
   * The bound on that is real but indirect: a generator may import only
   * `std::` modules and other `.agency` files, and compilation installs no
   * interrupt handlers, so anything dangerous cannot complete. This setting
   * is for callers who would rather decline than rely on that argument —
   * someone inspecting a freshly cloned repository, say.
   *
   * The refusal names the file and the generator, so you can decide whether
   * to compile again without it. Off by default; sandboxed compilation
   * (`compileSandboxed`) refuses splices unconditionally and does not need
   * it.
   */
  refuseSplices?: boolean;
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
    /** Which code this run is: entry file, closure file hashes, one closure
     *  hash. Set by launchers (agency run, eval, agency agent) and recorded on
     *  the statelog's agentStart event. */
    code: {
      entry: string;
      closureHash: string;
      closure: { file: string; sha256: string }[];
    };
  }>;

  /** Eval command configuration */
  eval?: {
    runsDir?: string;
    optimizeRunsDir?: string;
    sourceCacheRoot?: string; // git-source clone cache override

    /** Per-run resource limits for the agent subprocess. Unset fields keep the
     *  built-in defaults (lib/eval/run/subprocess.ts). */
    limits?: {
      wallClockSec?: number; // max seconds per agent run (default 60)
      maxCostUsd?: number; // max LLM spend per agent run (default 50)
      maxBatchCostUsd?: number; // max LLM spend per `eval run` invocation, all tests × trials (no default)
    };

    optimize?: {
      goal?: string;
      graders?: string; // path to a TS grading module
      optimizer?: string; // built-in name or path to a TS/JS optimizer module
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
     * Warn when one tool's JSON schema serializes to more characters than
     * this. A tool's schema is re-sent on every request in the run, so a
     * single oversized one is a standing cost: `std::syntax::highlight`
     * once carried a nested color-scheme object worth ~17,000 characters
     * against a ~1,000-character norm for the rest of the stdlib. The
     * warning goes to the state log and changes nothing else. Default
     * 2000; `0` disables the check.
     */
    maxToolSchemaChars: number;
    /**
     * Paths to user-authored "provider module" ES files loaded at
     * startup. Each must export `register({ registerProvider })` and call
     * `registerProvider(name, ClientClass)` to register a custom smoltalk
     * provider (e.g. a local model via `smoltalk-llama-cpp`). Relative
     * paths resolve against the current working directory. Merged with
     * the `AGENCY_PROVIDER_MODULES` env var at runtime.
     */
    providerModules: string[];
    /** Short name → local-model alias, used by `std::agency/local` and the
     *  `agency local` CLI. A value is either a bare Hugging Face URI or an
     *  object carrying that URI plus display metadata (what `agency local
     *  refresh` writes) — see `ModelAliasSchema`. Read and written at runtime
     *  (not compile-time baked) so `agency local alias` edits take effect on
     *  the next run. */
    modelAliases: Record<string, ModelAlias>;
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
     * Which JavaScript globals an unqualified name may refer to.
     * - "all" (default): the interop registry (JS_GLOBALS), so `process`,
     *   `console`, etc. resolve — ordinary compilation.
     * - "sandbox": the reviewed allowlist (SANDBOX_JS_GLOBALS) of globals
     *   that cannot reach the host. Set by `--agency-only`; a name outside
     *   the allowlist becomes an error.
     */
    jsGlobals?: "all" | "sandbox";
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

  /** Failure-propagation mode. "on" (default): a failure value passed to a
   * parameter not typed to accept Results skips the call and propagates the
   * original failure; failures into plain TS functions and method calls on
   * Results throw. "warn": warnings only, legacy behavior otherwise.
   * "off": no checks. */
  failurePropagation?: "off" | "warn" | "on";

  /** Root spend/time budget for each run — the same ceiling as `agency run
   * --max-cost` / `--max-time`, but declarative and honored when the agent is
   * served remotely (a CLI flag, when given, wins). `maxCost` is dollars of LLM
   * spend; `< 0` disables, `0` is a real limit (no paid spend). `maxTime` is a
   * duration string like `30s`, `5m`, `1h`; `<= 0` disables. */
  budget?: {
    maxCost?: number;
    maxTime?: string;
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

/** One `client.modelAliases` value. Two forms are on disk:
 *
 *  - a bare URI string, the shape `agency local alias add` writes; and
 *  - an object carrying the URI plus display metadata, the shape
 *    `agency local refresh` writes for catalog-managed entries (tagged
 *    `source: "remote"` so a refresh can tell its own entries from yours).
 *
 *  Both must validate here or a refresh leaves agency.json unloadable. The
 *  object mirrors `AliasObject` in `lib/stdlib/localModels.ts`, which is the
 *  type side of the same contract; `lib/config.modelAliases.test.ts` round-trips
 *  a fully-populated entry so the two cannot drift apart. Unknown metadata keys
 *  are allowed through so an older agency can load a config written by a newer
 *  one (forward compatibility) rather than erroring on a field it lacks. */
export const ModelAliasSchema = z.union([
  z.string(),
  z
    .object({
      uri: z.string(),
      source: z.literal("remote").optional(),
      params: z.string().optional(),
      sizeBytes: z.number().optional(),
      category: z.string().optional(),
      contextWindow: z.number().optional(),
      license: z.string().optional(),
      description: z.string().optional(),
      sha256: z.string().optional(),
    })
    .loose(),
]);

/** A `client.modelAliases` value: a bare URI or the rich object form. */
export type ModelAlias = z.infer<typeof ModelAliasSchema>;

export const AgencyConfigSchema = z
  .object({
    verbose: z.boolean(),
    allowNonAgencyGenerators: z.boolean(),
    refuseSplices: z.boolean(),
    logLevel: z.enum(["debug", "info", "warn", "error"]),
    outDir: z.string(),
    // Positive integer: the generated code does `maxToolCallRounds || 10`, so a
    // 0 would silently mean 10 and a float/negative is meaningless — reject at
    // load rather than surprise. Mirrors maxCallDepth.
    maxToolCallRounds: z.number().int().positive(),
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
        code: z.object({
          entry: z.string(),
          closureHash: z.string(),
          closure: z.array(z.object({ file: z.string(), sha256: z.string() })),
        }),
      })
      .partial(),
    eval: z
      .object({
        runsDir: z.string(),
        optimizeRunsDir: z.string(),
        sourceCacheRoot: z.string().optional(),
        // Positive int only: the value feeds setTimeout (×1000), where 0 and
        // negatives don't mean "no limit" — they fire immediately and fail
        // every run with a wall_clock limit error.
        limits: z
          .object({
            wallClockSec: z.number().int().positive(),
            maxCostUsd: z.number().positive(),
            maxBatchCostUsd: z.number().positive(),
          })
          .partial()
          .optional(),
        optimize: z
          .object({
            goal: z.string().optional(),
            graders: z.string().optional(),
            optimizer: z.string().optional(),
            validation: z
              .object({
                inputs: z.string().optional(),
                split: z.number().optional(),
              })
              .optional(),
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
        maxToolSchemaChars: z.number(),
        providerModules: z.array(z.string()),
        modelAliases: z.record(z.string(), ModelAliasSchema),
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
        jsGlobals: z.enum(["all", "sandbox"]),
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
    failurePropagation: z.enum(["off", "warn", "on"]),
    // maxCost is dollars: negatives (disable) and 0 (no paid spend) are both
    // meaningful, so it is a plain number, not positive-only — but it MUST be
    // finite. A non-finite cap (e.g. a JSON `1e309` parsing to Infinity) would
    // silently uncap spend, the wrong failure for a budget; reject it at load.
    // maxTime is a duration string validated when parsed (parseDurationMs).
    budget: z
      .object({
        maxCost: z
          .number()
          .refine((n) => Number.isFinite(n), "budget.maxCost must be a finite number"),
        maxTime: z.string(),
      })
      .partial(),
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
      autoExtract: z.object({ interval: z.number().optional() }).optional(),
      compaction: z
        .object({
          trigger: z.enum(["token", "messages"]).optional(),
          threshold: z.number().optional(),
        })
        .optional(),
      embeddings: z.object({ model: z.string().optional() }).optional(),
    }),
  })
  .partial()
  .loose();

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
      // stderr, not stdout: this fires under `config.verbose` and must not
      // corrupt a command's machine-consumed output.
      console.error(`Loaded config from ${configPath}:`);
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
//   2. CLI flags             — per-invocation flags (--trace, --log,
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

/** A `--model` value after parsing. `explicitProvider` is set only when the
 *  user wrote `provider/model`; a bare model leaves it undefined so smoltalk
 *  infers the provider from the model name.
 *
 *  Declared here rather than in the CLI so `CliFlags` stays self-contained:
 *  `lib/config.ts` must not depend on `lib/cli/`, which would pull the CLI and
 *  the runtime graph behind it into every consumer of the config module. */
export type ResolvedModelFlag = {
  model: string;
  explicitProvider?: string;
};

/** Per-invocation flags accepted by `agency run`/`compile` and forwarded to the
 *  bundled agents. Mapped onto AgencyConfig by applyCliFlags. `trace` is
 *  `string` for `--trace <file>`, `true` for a bare `--trace`. */
export type CliFlags = {
  trace?: string | true;
  logFile?: string;
  logStdout?: boolean;
  observability?: boolean;
  /** `--strict` on `run`/`compile`: fail the run on any fatal type error. */
  strict?: boolean;
  /** `--strict` on `typecheck`: untyped variables are errors, nothing else.
   *  Same spelling as `strict`, deliberately narrower. `typechecker.strict`
   *  has one reader — the compile-path gate at compiler/compile.ts — and
   *  `typecheck` never reaches it, so setting `strict` here would be inert
   *  rather than harmful. An inert setting that reads as meaningful is still
   *  a trap: it would quietly start mattering the day this command grows a
   *  compile path. */
  strictTypes?: boolean;
  /** `--refuse-splices`: decline compile-time generator execution. */
  refuseSplices?: boolean;
  maxToolCallRounds?: number;
  maxToolResultChars?: number;
  model?: ResolvedModelFlag;
};

/**
 * Fold per-invocation CLI flags onto a config COPY (never mutates the input).
 * The single definition of what each debug flag means:
 *   --trace <file>   → trace + traceFile=<file>
 *   --trace (bare)   → trace + traceFile=<input>.trace when an input path is
 *                      known (agency run), else traceDir="." (a bundled agent
 *                      with no input file → a per-run file in cwd)
 *   --log <p>        → log.logFile=<p> and observability=true (bare → log.jsonl,
 *                      resolved in the caller that reads the flag value)
 *   --log stdout     → log.host="stdout" and observability=true (stream to stdout)
 *   --observability  → observability=true
 *   --strict         → typechecker.strict + strictTypes (the compile-path gate
 *                      never runs the checker on strictTypes alone). This is
 *                      the `run`/`compile` meaning.
 *   --strict (tc)    → typechecker.strictTypes ONLY. `agency typecheck` calls
 *                      the checker unconditionally and computes its own exit
 *                      code, so it never reaches that gate; `strict` would be
 *                      inert there, and an inert-but-meaningful-looking
 *                      setting is a trap. Same flag name, narrower meaning,
 *                      which is why it is a separate field, not a branch.
 *   --refuse-splices → refuseSplices=true (refuse to compile a file with a
 *                      splice rather than running its generator)
 *   --model <m>      → client.defaultModel=<m> and client.defaultProvider
 *                      DELETED, so smoltalk infers the provider
 *   --model <p>/<m>  → client.defaultModel=<m> + client.defaultProvider=<p>
 *   --max-tool-call-rounds <n> → maxToolCallRounds=<n> (baked into runPrompt at
 *                      compile time; overrides agency.json for this run)
 *   --max-tool-result-chars <n> → client.maxToolResultChars=<n> (0 disables the
 *                      cap; overrides agency.json for this run)
 */
export function applyCliFlags(config: AgencyConfig, flags: CliFlags, input?: string): AgencyConfig {
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
  if (flags.logStdout) {
    // Stream statelog events to stdout ONLY. stdout is a REPLACEMENT sink, not
    // additive: explicitly blank out the file sink so `--log stdout` behaves
    // identically with or without a config file — CLI flags override config.
    // Setting logFile to "" (rather than dropping the key) is deliberate: this
    // override is deep-merged ONTO the resolved config later, so an empty
    // string is needed to overwrite an agency.json `logFile`; a missing key
    // would let the config value show through. The statelog client treats an
    // empty logFile as "no file" and host "stdout" as its stdout sink (see
    // StatelogClient.post).
    next.log = { ...next.log, host: "stdout", logFile: "" };
    next.observability = true;
  }
  if (flags.observability) {
    next.observability = true;
  }
  if (flags.strict) {
    next.typechecker = { ...next.typechecker, strict: true, strictTypes: true };
  }
  if (flags.strictTypes) {
    next.typechecker = { ...next.typechecker, strictTypes: true };
  }
  if (flags.refuseSplices) {
    next.refuseSplices = true;
  }
  if (flags.maxToolCallRounds !== undefined) {
    next.maxToolCallRounds = flags.maxToolCallRounds;
  }
  if (flags.maxToolResultChars !== undefined) {
    next.client = {
      ...next.client,
      maxToolResultChars: flags.maxToolResultChars,
    };
  }
  if (flags.model !== undefined) {
    // A bare model drops an inherited provider so smoltalk can infer one from
    // the model name; a stated provider replaces it. The key is removed rather
    // than set to undefined so the resulting config carries no dangling field.
    // Destructuring is how that happens without mutating `next.client`.
    const { defaultProvider: _dropped, ...client } = next.client ?? {};
    next.client =
      flags.model.explicitProvider === undefined
        ? { ...client, defaultModel: flags.model.model }
        : {
            ...client,
            defaultModel: flags.model.model,
            defaultProvider: flags.model.explicitProvider,
          };
  }
  return next;
}

/** The model every LLM call uses when neither agency.json nor the call names
 *  one, and the provider it routes through. The provider is named rather than
 *  inferred because the inferred route for an OpenAI model is the base "openai"
 *  client, which has no hosted web search; "openai-responses" does. */
export const DEFAULT_MODEL = "gpt-5-mini";
export const DEFAULT_PROVIDER = "openai-responses";

/** The one env var carrying a JSON Partial<AgencyConfig> into an already-compiled
 *  process (see the source-of-truth note above, source 3). */
export const CONFIG_OVERRIDES_ENV = "AGENCY_CONFIG_OVERRIDES";

/** Seeds the trace id of every RuntimeContext in a process tree (explicit
 *  statelogConfig.traceId still wins). Set PER-RUN by harnesses — eval
 *  command targets use it so descendants started without IPC (a bash
 *  `agency run ...`) land in the same trace as their parent. Do not export
 *  it from a shell: every subsequent run would merge into one trace. */
export const TRACE_ID_ENV = "AGENCY_TRACE_ID";

/** Serialize config overrides for a child process's AGENCY_CONFIG_OVERRIDES. */
export function serializeConfigOverrides(overrides: Partial<AgencyConfig>): string {
  return JSON.stringify(overrides);
}

/** Read + validate AGENCY_CONFIG_OVERRIDES. Returns {} when the var is absent,
 *  unparseable, or fails schema validation, so a malformed value can never
 *  brick startup. */
export function readConfigOverrides(env: NodeJS.ProcessEnv = process.env): Partial<AgencyConfig> {
  const raw = env[CONFIG_OVERRIDES_ENV];
  if (!raw) return {};
  try {
    const result = AgencyConfigSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      // Don't brick startup, but never fail silently — a typo'd override that
      // makes --trace/--log quietly do nothing is the worst failure mode.
      console.error(
        `Ignoring invalid ${CONFIG_OVERRIDES_ENV}: ${result.error.issues
          .map((i) => i.path.join("."))
          .join(", ")}`,
      );
      return {};
    }
    return result.data as Partial<AgencyConfig>;
  } catch (err) {
    console.error(
      `Ignoring unparseable ${CONFIG_OVERRIDES_ENV}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {};
  }
}

/** Combine inherited env overrides with flag-derived ones: flags win
 *  key-by-key, and `log` (the only nested override flag parsing writes)
 *  merges one level deep — so a --trace flag cannot destroy an inherited
 *  logFile, while an explicit --log still wins that key. */
export function mergeConfigOverrides(
  inherited: Partial<AgencyConfig>,
  flags: Partial<AgencyConfig>,
): Partial<AgencyConfig> {
  const merged: Partial<AgencyConfig> = { ...inherited, ...flags };
  if (inherited.log || flags.log) {
    merged.log = { ...inherited.log, ...flags.log };
  }
  return merged;
}

/** Return a deep copy of `config` with secret-bearing fields masked, for
 *  human-facing output (`agency config show`). Masks every `apiKey` — the
 *  top-level `log.apiKey` string and each key under `client.apiKey` /
 *  `client.statelog.apiKey` — to `•••<last4>`. */
export function redactConfigSecrets(config: AgencyConfig): AgencyConfig {
  const mask = (value: string): string => (value.length <= 4 ? "•••" : `•••${value.slice(-4)}`);
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
