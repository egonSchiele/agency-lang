#!/usr/bin/env node
import { compile } from "@/compiler/defaultSession.js";
import {
  compileWarning,
  forEachSource,
  format,
  formatFile,
  loadConfig,
  parse,
  readSource,
  readStdin,
  resolveInputSources,
  run,
} from "@/cli/commands.js";
import { classifyInstall, installDirFromUrl } from "@/cli/installLocation.js";
import { pack } from "@/cli/pack.js";
import { resolveModelFlag } from "@/cli/modelFlag.js";
import { resolveLocalRunFlag } from "@/cli/localFlag.js";
import { warnMisplacedAgencyFlags } from "@/cli/commandLine.js";
import { runLink } from "@/cli/remote/commands/link.js";
import { runDeploy } from "@/cli/remote/commands/deploy.js";
import { runLs } from "@/cli/remote/commands/ls.js";
import { runCall } from "@/cli/remote/commands/call.js";
import { runOpen } from "@/cli/remote/commands/open.js";
import { runWhoami } from "@/cli/remote/commands/whoami.js";
import { runProjectsList, runProjectsCreate } from "@/cli/remote/commands/projects.js";
import type { CreateProjectOptions } from "@/cli/remote/commands/projects.js";
import { runKeysList, runKeysCreate } from "@/cli/remote/commands/keys.js";
import type { CreateKeyOptions } from "@/cli/remote/commands/keys.js";
import { runSpend } from "@/cli/remote/commands/spend.js";
import type { SpendOptions } from "@/cli/remote/commands/spend.js";
import { runPull } from "@/cli/remote/commands/pull.js";
import {
  runSecretsSet,
  runSecretsList,
  runSecretsRm,
  runSecretsImport,
} from "@/cli/remote/commands/secrets.js";
import { confirmQuestion, promptSecretValue } from "@/cli/remote/confirmation.js";
import type { PullOptions } from "@/cli/remote/commands/pull.js";
import { runLogs } from "@/cli/remote/commands/logs.js";
import {
  resolveRemoteLogsMode,
  requireRemoteLogsEnvironment,
} from "@/cli/remote/commands/logsMode.js";
import type { RemoteLogsMode } from "@/cli/remote/commands/logsMode.js";
import { failProjectCommand } from "@/cli/remote/commands/util.js";
import type { AccountCommandOptions, ProjectCommandOptions } from "@/cli/remote/commands/util.js";
import type { RemoteCommandContext } from "@/cli/remote/commands/util.js";
import { lintSource } from "@/linter/registry.js";
import { formatFindings } from "@/cli/lint.js";
import { resolveBudget } from "@/cli/budget.js";
import { fixtures, test, testTs, SlowTest, parseShardSpec } from "@/cli/test.js";
import { generateReport, cleanCoverage } from "@/cli/coverage.js";
import { createBundle, extractBundle } from "@/cli/bundle.js";
import { traceLog } from "@/cli/events.js";
import { logsView, type LogsViewOpts } from "@/cli/logsView.js";
import { evalJudge } from "@/cli/evalJudge.js";
import { addLabelCommand, labelCommandDependencies } from "@/cli/eval/labelCommand.js";
import {
  addLogsExtractCommand,
  addRunDirectoryCommands,
  runDirectoryCommandDependencies,
} from "@/cli/runDirectory/commands.js";
import { evalGrade } from "@/cli/eval/grade.js";
import { resolveRunStatelog } from "@/cli/eval/logs.js";
import { evalLs } from "@/cli/eval/ls.js";
import { evalRun, totalRunCostUsd } from "@/cli/eval/run.js";
import { formatGradeResult } from "@/cli/eval/formatGrade.js";
import { ttyColor } from "@/utils/termcolors.js";
import { evalOptimize } from "@/cli/eval/optimize.js";
import { renderDiagnosticText, renderDiagnosticList } from "@/cli/explain.js";
import { AgencyConfig, applyCliFlags, type CliFlags, redactConfigSecrets } from "@/config.js";
import * as path from "path";
import { parseAgency } from "@/parser.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { expandSplices } from "@/preprocessors/expandSplices.js";
import { formatSpliceDiagnostic } from "@/compiler/splice/report.js";
import { SymbolTable } from "@/symbolTable.js";
import { formatErrors, formatDiagnosticsHint, typeCheck } from "@/typeChecker/index.js";
import { Command, InvalidArgumentError } from "@/vendor/commander/index.js";
import * as fs from "fs";
import { color } from "@/utils/termcolors.js";
import process from "process";
import { agent } from "@/cli/agent.js";
import { mcpAdd, mcpRemove, mcpList, type McpAddOptions } from "@/cli/mcp.js";
import {
  runList as localList,
  runDownload as localDownload,
  runRemove as localRemove,
  runResolve as localResolve,
  runRefresh as localRefresh,
  runAliasList as localAliasList,
  runAliasAdd as localAliasAdd,
  runAliasRemove as localAliasRemove,
} from "@/cli/local.js";
import { modelsList, modelsRefresh } from "@/cli/hostedModels.js";
import { doctor } from "@/cli/doctor.js";
import { review } from "@/cli/review.js";
import { policyGen } from "@/cli/policy.js";
import { resolveRunPolicy } from "@/cli/runPolicy.js";
import { interruptsCmd } from "@/cli/interrupts.js";
import {
  scheduleAdd,
  scheduleList,
  scheduleRemove,
  scheduleEdit,
  ScheduleExistsError,
  promptScheduleOverwrite,
  formatListTable,
} from "@/cli/schedule/index.js";
import { scheduleTest } from "@/cli/schedule/test.js";
import { addRemote, listRemote, removeRemote, editRemote } from "@/cli/schedule/remote.js";
import { loadEnv } from "@/utils/envfile.js";
import { debug } from "@/cli/debug.js";
import { generateDoc } from "@/cli/doc.js";
import { generateLiterate } from "@/cli/literate.js";
import { watchAndCompile } from "@/cli/watch.js";
import { setupAgentLsp, SUPPORTED_AGENT_LSP_TARGETS, type AgentLspTarget } from "@/lsp/setup.js";
import { setupCodexMcp, codexConfigPath } from "@/mcp/setup.js";
import { startServer } from "@/lsp/index.js";
import { startMcpServer } from "@/mcp/server.js";
import { pathToFileURL } from "url";
import { serveMcp, serveHttp } from "@/cli/serve.js";

// Per-run flags for `agency run` / the hidden default command: the shared
// CliFlags (mapped onto config by applyCliFlags in config.ts) plus --resume,
// which is a run-only concern, not a config field.
type RunOptions = Omit<CliFlags, "trace"> & {
  trace?: boolean;
  traceFile?: string;
  resume?: string;
  policy?: string;
  approve?: string;
  reject?: string;
  interactive?: boolean;
  maxCost?: string;
  maxTime?: string;
  local?: string;
  captureWorkdir?: string;
};

// commander option parsers. Match the WHOLE string against digits so
// `parseInt`'s silent truncation ("1.5"→1, "3abc"→3, "0x10"→16) can't sneak an
// invalid value through as a usable number.
function parseBoundedInt(value: string, min: number, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(label);
  }
  const n = parseInt(value, 10);
  if (n < min) {
    throw new InvalidArgumentError(label);
  }
  return n;
}

export function parsePositiveInt(value: string): number {
  return parseBoundedInt(value, 1, "must be a positive integer");
}

// 0 allowed (e.g. to disable a cap).
export function parseNonNegativeInt(value: string): number {
  return parseBoundedInt(value, 0, "must be a non-negative integer");
}

// Repeatable-flag accumulators (commander calls the parser with (value, previous)).
function collectRepeats(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectCommaSeparated(value: string, previous: string[]): string[] {
  return [
    ...previous,
    ...value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== ""),
  ];
}

type CliDependencies = {
  loadLspStartServer?: () => Promise<() => void>;
  loadMcpStartServer?: () => Promise<() => void>;
  resolveMcpCommand?: () => string[];
  launchAgent?: typeof agent;
};

function defaultResolveMcpCommand(): string[] {
  return ["agency", "mcp"];
}

async function defaultLoadLspStartServer(): Promise<() => void> {
  return startServer;
}

async function defaultLoadMcpStartServer(): Promise<() => void> {
  return startMcpServer;
}

/**
 * Print AST/preprocess results as ONE valid JSON document.
 *
 * A single input prints the bare AST (backward compatible with the
 * one-file/stdin case). Multiple inputs — e.g. a directory — print a JSON
 * array of `{ file, program }` so the output is a single parseable document
 * instead of concatenated top-level objects. Zero inputs print nothing (the
 * "no .agency files found" notice already went to stderr).
 */
function printAstResults(results: { file: string; program: unknown }[]): void {
  if (results.length === 0) return;
  if (results.length === 1) {
    console.log(JSON.stringify(results[0].program, null, 2));
    return;
  }
  console.log(JSON.stringify(results, null, 2));
}

export function createProgram(deps: CliDependencies = {}): Command {
  const loadLspStartServer = deps.loadLspStartServer ?? defaultLoadLspStartServer;
  const loadMcpStartServer = deps.loadMcpStartServer ?? defaultLoadMcpStartServer;
  const resolveMcpCommand = deps.resolveMcpCommand ?? defaultResolveMcpCommand;
  const program = new Command();

  program
    .name("agency")
    .description("Agency Language CLI")
    .version("0.0.105")
    .option("-v, --verbose", "Enable verbose logging during parsing")
    .option("-c, --config <path>", "Path to agency.json config file");

  function getConfig(): AgencyConfig {
    const opts = program.opts();
    const config = loadConfig(opts.config, opts.verbose);
    if (opts.verbose) {
      config.verbose = true;
    }
    return config;
  }

  // Config plus the exact path it loaded from, so a remote binding writes back
  // to that file rather than a re-derived one.
  function getConfigContext(): RemoteCommandContext {
    const opts = program.opts();
    const configPath = opts.config ?? path.resolve(process.cwd(), "agency.json");
    return { config: getConfig(), configPath };
  }

  async function runWithOptions(input: string, options: RunOptions, nodeArgs: string[] = []) {
    if (options.local !== undefined && options.model !== undefined) {
      console.error("Error: Pass either --model (hosted) or --local (local), not both.");
      process.exit(2);
    }
    if (options.local !== undefined) {
      // Resolve + download in the parent, before compiling, so progress and
      // SHA-256 verification happen in the terminal; the result rides the
      // ordinary --model pathway (applyCliFlags) into baked config.
      try {
        options = { ...options, model: await resolveLocalRunFlag(options.local) };
      } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        process.exit(1);
      }
    }
    // applyCliFlags takes one field: a path, or `true` for the default path.
    // The CLI splits that across two flags so neither swallows the filename.
    const config = applyCliFlags(
      getConfig(),
      { ...options, trace: options.traceFile ?? (options.trace ? true : undefined) },
      input,
    );
    let runPolicy;
    try {
      runPolicy =
        resolveRunPolicy({
          policy: options.policy,
          approve: options.approve,
          reject: options.reject,
          interactive: options.interactive,
          cwd: process.cwd(),
        }) ?? undefined;
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(2);
    }
    let budget;
    try {
      budget = resolveBudget({
        maxCost: options.maxCost,
        maxTime: options.maxTime,
      });
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(2);
    }
    run(
      config,
      input,
      undefined,
      options.resume,
      runPolicy,
      budget,
      nodeArgs,
      options.captureWorkdir === undefined ? undefined : { runDir: options.captureWorkdir },
    );
  }

  program
    .command("compile")
    .alias("build")
    .description("Compile .agency file(s) or directory(s) to JavaScript")
    .argument("<inputs...>", "Paths to .agency input files or directories")
    .option("--ts", "Output .ts files with // @no-check header")
    .option("--force", "Recompile everything, ignoring the incremental-build manifest")
    .option("-w, --watch", "Watch for changes and recompile")
    .option("--strict", "Fail on any fatal type error (typechecker.strict)")
    .option(
      "--max-tool-call-rounds <n>",
      "Max LLM tool-call rounds before halting a tool loop (default 10; overrides agency.json)",
      parsePositiveInt,
    )
    .option(
      "--max-tool-result-chars <n>",
      "Max chars of a single tool result fed back to the model (0 disables; default 100000; overrides agency.json)",
      parseNonNegativeInt,
    )
    .action(
      async (
        inputs: string[],
        opts: {
          ts?: boolean;
          force?: boolean;
          watch?: boolean;
          strict?: boolean;
          maxToolCallRounds?: number;
          maxToolResultChars?: number;
        },
      ) => {
        const config = applyCliFlags(getConfig(), {
          strict: opts.strict,
          maxToolCallRounds: opts.maxToolCallRounds,
          maxToolResultChars: opts.maxToolResultChars,
        });
        if (opts.watch) {
          const close = await watchAndCompile(config, inputs, { ts: opts.ts });
          process.once("SIGINT", async () => {
            await close();
            process.exit(0);
          });
        } else {
          // Test-harness only, mirroring the option every other test-runner
          // compile passes (lib/cli/util.ts). Set by lib/cli/test.ts on the
          // child it spawns for `expectedCompileError` files; nothing else
          // sets it, so the default stays deny.
          const allowTestImports = process.env.AGENCY_ALLOW_TEST_IMPORTS === "1";
          for (const input of inputs) {
            compile(config, input, undefined, {
              ts: opts.ts,
              freshness: opts.force ? "force" : undefined,
              allowTestImports,
            });
          }
          // If installed globally, the user will hit ERR_MODULE_NOT_FOUND
          // if they try to `node` the output directly. Steer them toward
          // `agency run` or `agency pack`. Gated on:
          //   - JS output only — `--ts` produces a .ts the user isn't
          //     going to run directly with node anyway.
          //   - The output directory doesn't already have a resolvable
          //     `agency-lang` (the warning helper does that check).
          // Uses the first input's directory as the resolution context;
          // directory inputs use the directory itself.
          if (!opts.ts && inputs.length > 0) {
            const ctx = path.resolve(inputs[0]);
            const warning = compileWarning(
              classifyInstall(installDirFromUrl(import.meta.url)),
              ctx,
            );
            if (warning) console.error(warning);
          }
        }
      },
    );

  function addRunOptions(cmd: Command) {
    return (
      cmd
        .option("--resume <statefile>", "Resume execution from a saved state file")
        // Two flags rather than `--trace [file]`: an optional-valued option
        // swallows the next word, so `agency run --trace greet.agency` reads the
        // filename as the trace path and then reports the input missing. That was
        // broken before the position rule too; splitting it makes both spellings
        // work.
        .option("--trace", "Write an execution trace to <input>.trace")
        .option("--trace-file <path>", "Write an execution trace to this path")
        .option(
          "--log-file <path>",
          "Append statelog events (one JSON object per line) to this file for this run",
        )
        .option(
          "--observability",
          "Enable statelog observability for this run (use with a configured host, or --log-file)",
        )
        .option("--strict", "Fail the run on any fatal type error (typechecker.strict)")
        .option(
          "--max-tool-call-rounds <n>",
          "Max LLM tool-call rounds before halting a tool loop (default 10; overrides agency.json)",
          parsePositiveInt,
        )
        .option(
          "--max-tool-result-chars <n>",
          "Max chars of a single tool result fed back to the model (0 disables; default 100000; overrides agency.json)",
          parseNonNegativeInt,
        )
        .option(
          "--model <name>",
          "Model for this run's LLM calls, as `model` or `provider/model` (e.g. gpt-4o-mini, openrouter/anthropic/claude-sonnet-4)",
          // Adapter, not decoration: commander calls a parser with
          // (value, previous), and `previous` would land in the resolver's
          // catalogNames parameter when --model is repeated.
          (value: string) => resolveModelFlag(value),
        )
        .option(
          "--local <model>",
          "Run every LLM call on a local model: a curated name, an alias, an hf: URI, or a .gguf path (see: agency local list)",
        )
        .option(
          "--policy <name|path>",
          "Interrupt policy: a built-in (recommended|minimal|with-writes|approve-all) or a policy JSON file",
        )
        .option("--approve <effects>", "Comma-separated interrupt effects to auto-approve")
        .option("--reject <effects>", "Comma-separated interrupt effects to auto-reject")
        .option(
          "-i, --interactive",
          "Prompt on interrupts that surface unhandled (default: reject them)",
        )
        .option(
          "--max-cost <dollars>",
          "Abort if the run's LLM spend exceeds this many dollars (e.g. 0.50). 0 = no paid spend (local models only); negative = no limit",
        )
        .option(
          "--max-time <duration>",
          "Abort if the run's working time exceeds this duration (e.g. 30s, 5m, 1h, 2d). Waiting on a human is not counted; zero/negative = no limit",
        )
        .option(
          "--capture-workdir <dir>",
          "After the run, write its trace, code and a snapshot of the working directory as the run directory <dir>/<traceId>/ (see: agency runs list)",
        )
    );
  }

  addRunOptions(
    program
      .command("run")
      // The program boundary: agency's flags before the filename, the
      // program's after. The fallback (`agency greet.agency`) dispatches this
      // same command object, so both spellings share options, action, help.
      .passThroughOptions()
      .description("Compile and run .agency file(s)")
      .argument("<input>", "Path to .agency input file")
      .argument(
        "[nodeArgs...]",
        "Arguments after the filename go to the program; read them with std::args",
      ),
  ).action(async (input: string, nodeArgs: string[], options: RunOptions, command: Command) => {
    const warning = warnMisplacedAgencyFlags(command, input);
    if (warning !== undefined) console.warn(warning);
    if (command.invokedAsFallback() && !input.endsWith(".agency") && !fs.existsSync(input)) {
      // `agency typo` may be a mistyped command, which plain run can never
      // be; the diagnostic suggests near-miss command names.
      command.unknownFallbackOperand(input);
    }
    await runWithOptions(input, options, nodeArgs);
  });

  program
    .command("pack")
    .description(
      "Bundle a .agency program into a single portable .mjs (no agency install needed at runtime)",
    )
    .argument("<input>", "Path to .agency input file")
    // Default to .mjs so the output is unambiguously ESM regardless of
    // any surrounding package.json `"type"`. Users may pass `-o foo.js`
    // explicitly if they prefer that extension.
    .option("-o, --output <file>", "Output file path", "agent.mjs")
    .option("--target <target>", "Output target (currently only 'node')", "node")
    .action(async (input: string, opts: { output: string; target: string }) => {
      if (opts.target !== "node") {
        console.error(`Unsupported pack target: ${opts.target} (supported: node)`);
        process.exit(1);
      }
      const config = getConfig();
      await pack({
        config,
        inputFile: input,
        outputFile: opts.output,
        target: "node",
      });
      console.log(`Packed ${input} -> ${opts.output}`);
    });

  // Hidden while the hosted feature matures. Every "how" (HTTP, interrupts,
  // binding, arg coercion, prompts, browser launch) sits behind the modules in
  // lib/cli/remote/; these actions are thin delegations.
  const remoteCmd = program
    .command("remote", { hidden: true })
    .description("Interact with a hosted statelog agent");

  remoteCmd
    .command("link")
    .description("Show, or set with --url, this directory's linked hosted agent")
    .option("--url <serveBase>", "serve base URL to link (…/serve/:user/:project/:file)")
    .action((opts: { url?: string }) => runLink(opts, getConfigContext()));

  remoteCmd
    .command("deploy")
    .description("Upload an agent and link this directory to it")
    .argument("<file>", "Agency entrypoint file to deploy")
    .option("--host <url>", "statelog host (overrides agency.json log.host)")
    .option("--project <slug>", "project slug (overrides agency.json log.projectId)")
    .option("--api-key-env <name>", "env var to read the API key from (default: STATELOG_API_KEY)")
    .option("--dry-run", "preview the deploy without uploading")
    .action(
      async (
        file: string,
        opts: { host?: string; project?: string; apiKeyEnv?: string; dryRun?: boolean },
      ) => {
        await runDeploy(file, opts, getConfigContext());
      },
    );

  remoteCmd
    .command("ls")
    .description("List the linked agent's callable nodes and functions, and its deployed files")
    .option("--api-key-env <name>", "env var to read the API key from (default: STATELOG_API_KEY)")
    .action((opts: { apiKeyEnv?: string }) => runLs(opts, getConfigContext()));

  remoteCmd
    .command("call")
    .description("Call a node (or --function) and drive the interrupt cycle")
    .argument("<name>", "node or function name")
    .option(
      "--arg <name=value>",
      "an argument as name=value (repeatable); values parse as JSON when they can",
      (pair: string, prev: string[]) => [...prev, pair],
      [] as string[],
    )
    .option("--data <json>", "all named arguments as one JSON object (alternative to --arg)")
    .option("--function", "call a function instead of a node")
    .option("-i, --interactive", "prompt on surfaced interrupts (else report and exit)")
    .option("--policy <name|path>", "interrupt policy: a built-in or a policy JSON file")
    .option("--approve <effects>", "comma-separated interrupt effects to auto-approve")
    .option("--reject <effects>", "comma-separated interrupt effects to auto-reject")
    .option("--api-key-env <name>", "env var to read the API key from (default: STATELOG_API_KEY)")
    .action(
      (
        name: string,
        opts: {
          arg?: string[];
          data?: string;
          function?: boolean;
          interactive?: boolean;
          policy?: string;
          approve?: string;
          reject?: string;
          apiKeyEnv?: string;
        },
      ) => runCall(name, opts, getConfigContext()),
    );

  remoteCmd
    .command("open")
    .description("Open the linked agent's project page in a browser")
    .action(() => runOpen(getConfigContext()));

  const HOST_OPTION = "--host <origin>";
  const HOST_DESC = "statelog host (overrides agency.json log.host)";
  const API_KEY_ENV_OPTION = "--api-key-env <name>";
  const API_KEY_ENV_DESC = "env var to read the API key from (default: STATELOG_API_KEY)";

  remoteCmd
    .command("whoami")
    .description("Show the authenticated statelog user")
    .option(HOST_OPTION, HOST_DESC)
    .option(API_KEY_ENV_OPTION, API_KEY_ENV_DESC)
    .action((opts: AccountCommandOptions) => runWhoami(opts, getConfigContext()));

  const projectsCmd = remoteCmd
    .command("projects")
    .description("List or create statelog projects (account-scoped key)");
  projectsCmd
    .command("list", { isDefault: true })
    .description("List the account's projects")
    .option(HOST_OPTION, HOST_DESC)
    .option(API_KEY_ENV_OPTION, API_KEY_ENV_DESC)
    .action((opts: AccountCommandOptions) => runProjectsList(opts, getConfigContext()));
  projectsCmd
    .command("create <project_id>")
    .description("Create a project")
    .requiredOption("--name <name>", "human-readable project name")
    .option("--description <text>", "optional project description")
    .option(HOST_OPTION, HOST_DESC)
    .option(API_KEY_ENV_OPTION, API_KEY_ENV_DESC)
    .action((projectId: string, opts: CreateProjectOptions) =>
      runProjectsCreate(projectId, opts, getConfigContext()),
    );

  const keysCmd = remoteCmd
    .command("keys")
    .description("List or create statelog API keys (account-scoped key)");
  keysCmd
    .command("list", { isDefault: true })
    .description("List the account's API keys")
    .option(HOST_OPTION, HOST_DESC)
    .option(API_KEY_ENV_OPTION, API_KEY_ENV_DESC)
    .action((opts: AccountCommandOptions) => runKeysList(opts, getConfigContext()));
  keysCmd
    .command("create <name>")
    .description("Create a project-scoped API key")
    .requiredOption("--project <slug>", "project slug the key is scoped to")
    .option(HOST_OPTION, HOST_DESC)
    .option(API_KEY_ENV_OPTION, API_KEY_ENV_DESC)
    .action((name: string, opts: CreateKeyOptions) =>
      runKeysCreate(name, opts, getConfigContext()),
    );

  remoteCmd
    .command("spend")
    .description("Show hosted spend for a project (or the whole account)")
    .argument("[project]", "project slug (omit for the account-wide rollup)")
    .option("--since <duration>", "window ending now, e.g. 24h, 7d, 2w")
    .option("--from <when>", "window start — ISO-8601 (UTC/offset) or epoch-ms")
    .option("--to <when>", "window end — ISO-8601 (UTC/offset) or epoch-ms")
    .option("--json", "emit JSON for machine use")
    .option("--by-model", "group the breakdown by model")
    .option("--by-kind", "group the breakdown by operation kind")
    .option(HOST_OPTION, HOST_DESC)
    .option(API_KEY_ENV_OPTION, API_KEY_ENV_DESC)
    .action((project: string | undefined, opts: SpendOptions) =>
      runSpend(project, opts, getConfigContext()),
    );

  const PROJECT_OPTION = "--project <slug>";
  const PROJECT_DESC = "project slug (default: the linked project)";

  remoteCmd
    .command("pull")
    .description("Download the deployed source to disk")
    .option("--out <dir>", "output directory (default: current directory)")
    .option("--force", "overwrite existing files")
    .option(PROJECT_OPTION, PROJECT_DESC)
    .option(HOST_OPTION, HOST_DESC)
    .option(API_KEY_ENV_OPTION, API_KEY_ENV_DESC)
    .action((opts: PullOptions) => runPull(opts, getConfigContext()));

  const secretsCmd = remoteCmd
    .command("secrets")
    .description("Manage the project's hosted environment secrets (write-only store)");

  secretsCmd
    .command("set")
    .description("Set a secret's value (hidden prompt, piped stdin, or --from-env; never argv)")
    .argument("<NAME>", 'Environment variable name the hosted agent reads with env("NAME")')
    .option("--from-env <VAR>", "copy the value of a local environment variable")
    .option(PROJECT_OPTION, PROJECT_DESC)
    .option(HOST_OPTION, HOST_DESC)
    .option(API_KEY_ENV_OPTION, API_KEY_ENV_DESC)
    .action(async (name: string, opts: ProjectCommandOptions & { fromEnv?: string }) => {
      const result = await runSecretsSet(name, opts, getConfigContext(), {
        stdinIsTty: process.stdin.isTTY === true,
        readStdin,
        promptHidden: promptSecretValue,
        env: process.env,
      });
      if (result.kind === "canceled") {
        process.exitCode = 1;
      }
    });

  secretsCmd
    .command("list")
    .alias("ls")
    .description("List secret names and timestamps (values are never returned)")
    .option(PROJECT_OPTION, PROJECT_DESC)
    .option(HOST_OPTION, HOST_DESC)
    .option(API_KEY_ENV_OPTION, API_KEY_ENV_DESC)
    .action((opts: ProjectCommandOptions) => runSecretsList(opts, getConfigContext()));

  secretsCmd
    .command("rm")
    .description("Delete a secret")
    .argument("<NAME>", "Name of the secret to delete")
    .option(PROJECT_OPTION, PROJECT_DESC)
    .option(HOST_OPTION, HOST_DESC)
    .option(API_KEY_ENV_OPTION, API_KEY_ENV_DESC)
    .action((name: string, opts: ProjectCommandOptions) =>
      runSecretsRm(name, opts, getConfigContext()),
    );

  secretsCmd
    .command("import")
    .description("Bulk-import secrets from a dotenv file (default .env; '-' reads stdin)")
    .argument("[file]", "dotenv file to import (default: .env; '-' for stdin)")
    .option(PROJECT_OPTION, PROJECT_DESC)
    .option(HOST_OPTION, HOST_DESC)
    .option(API_KEY_ENV_OPTION, API_KEY_ENV_DESC)
    .action(async (file: string | undefined, opts: ProjectCommandOptions) => {
      const result = await runSecretsImport(file, opts, getConfigContext(), {
        stdinIsTty: process.stdin.isTTY === true,
        readStdin,
        confirm: confirmQuestion,
      });
      if (result.kind !== "succeeded") {
        process.exitCode = 1;
      }
    });

  remoteCmd
    .command("logs")
    .description("Open a trace's logs in the viewer (or --json), or --list recent traces")
    .argument("[traceId]", "trace id (default: the most recent)")
    .option("--json", "print raw JSON to stdout instead of opening the viewer")
    .option("--list", "list recent traces instead of opening one")
    .option(PROJECT_OPTION, PROJECT_DESC)
    .option(HOST_OPTION, HOST_DESC)
    .option(API_KEY_ENV_OPTION, API_KEY_ENV_DESC)
    .action(
      (
        traceId: string | undefined,
        opts: ProjectCommandOptions & { json?: boolean; list?: boolean },
      ) => {
        // Resolve and TTY-validate the mode BEFORE any config/credential/effect,
        // so a bad invocation touches nothing. This is the only TTY-policy site.
        let mode: RemoteLogsMode;
        try {
          mode = resolveRemoteLogsMode(traceId, opts);
          requireRemoteLogsEnvironment(mode, {
            stdinIsTTY: process.stdin.isTTY === true,
            stdoutIsTTY: process.stdout.isTTY === true,
          });
        } catch (error) {
          failProjectCommand(error);
        }
        return runLogs(mode, opts, getConfigContext());
      },
    );

  const traceCmd = program.command("trace").description("Trace-related commands");

  traceCmd
    .command("run", { isDefault: true })
    .description("Compile and run .agency file, generating a trace")
    .argument("<input>", "Path to .agency input file")
    .option("-o, --output <file>", "Output trace file path (default: <input>.trace)")
    .option("--resume <statefile>", "Resume execution from a saved state file")
    .action(async (input: string, options: { output?: string; resume?: string }) => {
      const traceFile = options.output || input.replace(/\.agency$/, ".trace");
      await runWithOptions(input, { traceFile, resume: options.resume });
    });

  traceCmd
    .command("log")
    .description("Generate a JSON event log from a trace file")
    .argument("<file>", "Path to .trace, .agencytrace, or .agencybundle file")
    .option("-o, --output <file>", "Output JSON file path (default: stdout)")
    .action((file: string, options: { output?: string }) => {
      traceLog(file, options.output);
    });

  type LogsCliOptions = {
    follow?: boolean;
    csv?: boolean;
  };
  const logsViewOptsFrom = (options: LogsCliOptions): LogsViewOpts => ({
    follow: options.follow,
    csv: options.csv,
    config: getConfig(),
  });

  const logsCmd = program
    .command("logs")
    .description("Inspect StateLog output")
    // `view` is the default for a single statelog file: `agency logs
    // <file>` behaves like `agency logs view <file>`. Run directories,
    // directories of run directories, or several paths open the
    // cross-run explorer instead. The argument is optional so bare
    // `agency logs` (no subcommand, no paths) falls through to help.
    .argument(
      "[files...]",
      "Statelog files ('-' for stdin), run directories, or directories of runs",
    )
    .option("-f, --follow", "Tail the file — re-read and re-render as new events are appended")
    .option("--csv", "Print the runs table as CSV to stdout instead of opening the explorer")
    .action(async (files: string[], options: LogsCliOptions) => {
      if (files.length === 0) {
        logsCmd.help();
        return;
      }
      await logsView(files, logsViewOptsFrom(options));
    });

  logsCmd
    .command("view")
    .description("Open an interactive TUI viewer for a statelog JSONL file")
    .argument("<file>", "Path to a .statelog.jsonl file, or '-' for stdin")
    // -f/--follow is declared once, on `logs`. Commander gives the parent priority wherever the flag sits, so a
    // second declaration here would silently receive undefined (the vendored
    // fork now rejects that shape at registration). The action reads the
    // parent's parsed values.
    .action(async (file: string, _options: Record<string, never>, command: Command) => {
      await logsView(file, logsViewOptsFrom((command.parent?.opts() ?? {}) as LogsCliOptions));
    });

  const runDirectoryDeps = runDirectoryCommandDependencies();
  addLogsExtractCommand(logsCmd, runDirectoryDeps);
  addRunDirectoryCommands(program, runDirectoryDeps);

  const evalCmd = program.command("eval").description("Evaluate agent runs against task fixtures");

  evalCmd
    .command("run")
    .description("Run an Agency agent against an eval task suite")
    .argument(
      "[agent]",
      "Agent .agency file or directory, optionally suffixed with :node (or use --agent-cmd)",
    )
    .option(
      "--agent-cmd <command>",
      "Run this command as the agent instead of an agent file; {input} is replaced with each test's input. " +
        "Agency CLIs only — the command's process must write the statelog the harness points it at, " +
        "and it must run headless and one-shot (e.g. agency agent --policy approve-all -p -- {input})",
    )
    .option(
      "--suite <source>",
      "Test suite: a JSON file, a directory, or a git source (URL[//subdir][?ref=...])",
    )
    .option("--input <text>", "Run one inline test whose input is this text (no suite file needed)")
    .option(
      "--test <pattern>",
      "Run only tests whose id matches this glob (repeatable; any match selects). Preview with: agency eval ls",
      collectRepeats,
      [] as string[],
    )
    .option(
      "--tags <tags>",
      "Run only tests carrying every one of these comma-separated tags (repeatable). Preview with: agency eval ls",
      collectCommaSeparated,
      [] as string[],
    )
    .option(
      "-o, --out <dir>",
      "Directory to write the run into; must not exist yet (default: runs/<timestamp>-<random suffix>, or under eval.runsDir from agency.json)",
    )
    .option(
      "-n, --parallel <count>",
      "Run up to this many inputs at once (default 1). Above 1, per-agent output is replaced by a status board (name, state, elapsed, cost so far)",
      parsePositiveInt,
    )
    .action(
      async (
        agent: string | undefined,
        opts: {
          agentCmd?: string;
          suite?: string;
          input?: string;
          test?: string[];
          tags?: string[];
          out?: string;
          parallel?: number;
        },
      ) => {
        // Every test in the suite always runs, whatever the others did: an
        // errored test is a `run` row that grades 0, not a reason to stop.
        // Agent config (strict types, tool-loop caps) comes from agency.json
        // beside the agent, not from eval flags.
        const result = await evalRun({ agent, ...opts, config: getConfig() });
        console.log(`Run completed: ${result.okCount}/${result.tests.length} tests ok`);
        for (const test of result.tests) {
          if (test.status === "error") {
            console.log(`  ${ttyColor.red(`${test.testId} error:`)} ${test.errorMessage ?? ""}`);
          }
        }
        const costUsd = totalRunCostUsd(result.runDir);
        if (costUsd !== undefined) {
          console.log(`total LLM cost: $${costUsd.toFixed(2)}`);
        }
        console.log(`runs written under ${result.runDir}`);
        console.log(`grade it with: agency eval grade ${result.runDir}`);
      },
    );

  evalCmd
    .command("ls")
    .description(
      "List a suite's tests; with --test/--tags, exactly what eval run with the same flags would run",
    )
    .option(
      "--suite <source>",
      "Test suite: a JSON file, a directory, or a git source (URL[//subdir][?ref=...])",
    )
    .option(
      "--test <pattern>",
      "Only tests whose id matches this glob (repeatable; any match selects)",
      collectRepeats,
      [] as string[],
    )
    .option(
      "--tags <tags>",
      "Only tests carrying every one of these comma-separated tags (repeatable)",
      collectCommaSeparated,
      [] as string[],
    )
    .action((opts: { suite?: string; test?: string[]; tags?: string[] }) => {
      let lines: string[];
      try {
        lines = evalLs({ ...opts, config: getConfig() });
      } catch (error) {
        failProjectCommand(error);
      }
      for (const line of lines) console.log(line);
    });

  evalCmd
    .command("logs")
    .description("Open a run's statelog in the interactive logs viewer")
    .argument("<runDir>", "A run directory, one input's directory, or a statelog file")
    .option("--input <id>", "Which input's statelog, when the run has several")
    .option("-f, --follow", "Tail the file — re-read and re-render as new events are appended")
    .action(async (runDir: string, opts: { input?: string; follow?: boolean }) => {
      // A run directory opens the viewer on its statelog with each trace's
      // annotations summarised; --input (or a statelog file) keeps the
      // plain viewer path.
      if (
        opts.input === undefined &&
        fs.existsSync(path.join(path.resolve(runDir), "statelog.jsonl"))
      ) {
        await logsView([runDir], { follow: opts.follow });
        return;
      }
      let statelogPath: string;
      try {
        statelogPath = resolveRunStatelog(runDir, opts.input);
      } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        process.exit(2);
      }
      await logsView(statelogPath, { follow: opts.follow });
    });

  evalCmd
    .command("grade")
    .description("Score finished runs without re-running the agent")
    .argument("<paths...>", "Run directories, or directories of run directories")
    .option("--graders <file>", "TypeScript grading module (default-exports graders)")
    .option(
      "--goal <text>",
      "Judge every trace against this goal with the built-in LLM judge (traces whose test recorded its own goal keep it; not with --graders)",
    )
    .option("-o, --out <path>", "Also write the grading summary here as JSON")
    .action(async (paths: string[], opts: { graders?: string; goal?: string; out?: string }) => {
      const result = await evalGrade(paths, { ...opts, config: getConfig() }).catch(
        failProjectCommand,
      );
      for (const line of formatGradeResult(result)) console.log(line);
      if (!result.gatesPassed) {
        process.exit(2);
      }
    });

  addLabelCommand(evalCmd, labelCommandDependencies());
  addLabelCommand(program, labelCommandDependencies());

  evalCmd
    .command("judge")
    .description("Compare two single-trace statelogs, or two run directories test by test")
    .argument("<inputA>", "A single-trace statelog file, or a run directory")
    .argument("<inputB>", "A single-trace statelog file, or a run directory")
    .option(
      "--goal <text>",
      "Goal used to judge responses (statelog files only; run directories carry their own goals)",
    )
    .option("--samples <n>", "Judge samples per input", parseInt)
    .option("--confidence-threshold <n>", "Minimum confidence counted as a win", parseInt)
    .option("--margin-threshold <n>", "Suite win margin required", parseInt)
    .option("--position-bias <mode>", "Position bias control: swap or none", "swap")
    .option("-o, --out <path>", "Output verdict JSON path")
    .action(
      async (
        inputA: string,
        inputB: string,
        opts: {
          goal?: string;
          out?: string;
          samples?: number;
          confidenceThreshold?: number;
          marginThreshold?: number;
          positionBias?: "swap" | "none";
        },
      ) => {
        await evalJudge(inputA, inputB, opts);
      },
    );

  // Registered as the top-level `agency optimize`.
  const addOptimizeCommand = (parent: Command): void => {
    parent
      .command("optimize")
      .description(
        "Optimize marked Agency declarations against an eval goal or input suite (file agents only — the optimizer mutates agent files, so there is no --agent-cmd here)",
      )
      .argument("<agent>", "Agency file target: file.agency[:node]")
      .option("--goal <text>", "Goal to optimize for")
      .option("--suite <fileOrDir>", "Test suite JSON file or directory")
      .option("--graders <file>", "TypeScript grading module (default-exports graders)")
      .option("--validation-suite <fileOrDir>", "Held-out validation test suite")
      .option(
        "--validation-split <ratio>",
        "Hold out this fraction of inputs for validation",
        (v) => parseFloat(v),
      )
      .option("--iterations <n>", "Maximum candidate iterations", (v) => parseInt(v, 10))
      .option("--run-id <id>", "Run id / output subdirectory")
      .option("--runs-dir <path>", "Optimizer runs output directory")
      .option("--no-writeback", "Do not write the champion back to source files")
      .option("--mutator-model <model>", "Model to use for proposing mutations")
      .option(
        "--optimizer <nameOrPath>",
        "Optimization strategy: a built-in name (greedy, gepa, example) or a path to an optimizer module (.ts/.js/.mjs, or any path containing /)",
      )
      .option("--minibatch <n>", "GEPA minibatch size (gepa optimizer only)", (v) =>
        parseInt(v, 10),
      )
      .option("--seed <n>", "RNG seed for reproducible search (gepa optimizer)", (v) =>
        parseInt(v, 10),
      )
      .option("--silent", "Print nothing; artifacts are still written")
      .action(
        async (
          agent: string,
          opts: {
            goal?: string;
            suite?: string;
            graders?: string;
            validationSuite?: string;
            validationSplit?: number;
            iterations?: number;
            runId?: string;
            runsDir?: string;
            writeback: boolean;
            mutatorModel?: string;
            optimizer?: string;
            minibatch?: number;
            seed?: number;
            silent?: boolean;
          },
        ) => {
          const result = await evalOptimize({ ...opts, agent, config: getConfig() });
          if (!opts.silent) {
            console.log(
              `Optimize ${result.runId} completed: ${result.acceptedCount} accepted, ${result.rejectedCount} rejected`,
            );
            console.log(path.join(result.runDir, "summary.json"));
          }
        },
      );
  };
  addOptimizeCommand(program);

  program
    .command("format")
    .alias("fmt")
    .description("Format .agency file(s) or directory(s) (reads from stdin if no input)")
    .argument("[inputs...]", "Paths to .agency input files or directories")
    .option("-i, --in-place", "Format file(s) in-place")
    .action(async (inputs: string[], opts: { inPlace?: boolean }) => {
      const config = getConfig();
      if (inputs.length === 0) {
        const contents = await readStdin();
        const formatted = await format(contents, config);
        console.log(formatted);
      } else {
        for (const input of inputs) {
          formatFile(input, opts.inPlace ?? false, config);
        }
      }
    });

  program
    .command("ast")
    .alias("parse")
    .description("Parse .agency file(s) and show AST (reads from stdin if no input)")
    .argument("[inputs...]", "Paths to .agency input files")
    .action(async (inputs: string[]) => {
      const config = getConfig();
      const results: { file: string; program: unknown }[] = [];
      await forEachSource(inputs, (contents, src) => {
        results.push({
          file: src.kind === "file" ? src.path : "<stdin>",
          program: parse(contents, config),
        });
      });
      printAstResults(results);
    });

  program
    .command("preprocess")
    .description(
      "Parse .agency file(s) and show AST after preprocessing (reads from stdin if no input)",
    )
    .argument("[inputs...]", "Paths to .agency input files")
    .action(async (inputs: string[]) => {
      const config = getConfig();

      const preprocessInput = (contents: string): unknown => {
        const parsedProgram = parse(contents, config);
        const info = buildCompilationUnit(parsedProgram);
        const preprocessor = new TypescriptPreprocessor(parsedProgram, config, info);
        preprocessor.preprocess();
        return preprocessor.program;
      };

      const results: { file: string; program: unknown }[] = [];
      await forEachSource(inputs, (contents, src) => {
        results.push({
          file: src.kind === "file" ? src.path : "<stdin>",
          program: preprocessInput(contents),
        });
      });
      printAstResults(results);
    });

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  function printSlowestTests(slowTests: SlowTest[], count: number = 10): void {
    if (slowTests.length === 0) return;
    const sorted = [...slowTests].sort((a, b) => b.durationMs - a.durationMs);
    const top = sorted.slice(0, count);
    console.log(color.yellow(`\n Slowest ${Math.min(count, top.length)} tests:`));
    for (const t of top) {
      console.log(`   ${color.yellow(formatDuration(t.durationMs))}  ${t.name}`);
    }
  }

  const testCmd = program
    .command("test")
    .description("Run tests (default), or use subcommands: js, fixtures");

  testCmd
    .command("run", { isDefault: true })
    .description("Run Agency test files")
    .argument("[inputs...]", "Paths to .test.json files or directories")
    .option("-p, --parallel <number>", "Number of test files to run in parallel", parseInt)
    .option("--coverage", "Enable coverage collection and report")
    .option("--accumulate", "Preserve existing coverage data (use with --coverage)")
    .option(
      "--shard <i/N>",
      "Run only shard i of N (1-based), e.g. --shard 2/4. Splits the collected test files across N runs.",
    )
    .option(
      "--collect-only",
      "With --coverage, write the raw coverage data but skip the report. Used by sharded CI runs, which merge the shards and report once elsewhere; generating a per-shard report would wastefully recompile every source file for its source map.",
    )
    .action(
      async (
        testFile: string[],
        opts: {
          parallel?: number;
          coverage?: boolean;
          accumulate?: boolean;
          shard?: string;
          collectOnly?: boolean;
        },
      ) => {
        const config = getConfig();
        if (opts.coverage) {
          process.env.AGENCY_COVERAGE = "1";
          // Resolve to an absolute path so subprocesses spawned with a different
          // cwd (e.g., `test js` uses execFileAsync({ cwd: dir })) all write to
          // the same `.coverage/` directory.
          process.env.AGENCY_COVERAGE_OUTDIR = path.resolve(config.coverage?.outDir ?? ".coverage");
          if (!opts.accumulate) {
            cleanCoverage(config);
          }
        }
        const shard = opts.shard ? parseShardSpec(opts.shard) : undefined;
        const parallel = opts.parallel ?? config.test?.parallel ?? 1;
        const totals = await test(config, testFile, parallel, shard);
        const totalFiles = totals.filesPassed + totals.filesFailed;
        const totalTests = totals.passed + totals.failed;
        if (totalFiles > 0) {
          const filesStatus = [
            totals.filesFailed > 0 ? `${totals.filesFailed} failed` : "",
            `${totals.filesPassed} passed`,
          ]
            .filter(Boolean)
            .join(" | ");
          const testsStatus = [
            totals.failed > 0 ? `${totals.failed} failed` : "",
            `${totals.passed} passed`,
          ]
            .filter(Boolean)
            .join(" | ");
          if (totals.failedFiles.length > 0) {
            console.log("");
            for (const file of totals.failedFiles) {
              console.log(color.red(` FAIL  ${file}`));
            }
          }
          const colorFn = totals.failed > 0 ? color.red : color.green;
          console.log(colorFn(`\n Test Files  ${filesStatus} (${totalFiles})`));
          console.log(colorFn(`      Tests  ${testsStatus} (${totalTests})`));
        }
        printSlowestTests(totals.slowTests);
        if (opts.coverage && !opts.collectOnly) {
          const reportTargets = testFile.length > 0 ? testFile : ["."];
          await generateReport(config, reportTargets);
        }
        if (totals.failed > 0) {
          process.exit(1);
        }
      },
    );

  testCmd
    .command("js")
    .description("Run JavaScript integration tests")
    .argument("[inputs...]", "Paths to test directories")
    .option("-p, --parallel <number>", "Number of test dirs to run in parallel", parseInt)
    .option("--coverage", "Enable coverage collection and report")
    .option("--accumulate", "Preserve existing coverage data (use with --coverage)")
    .option(
      "--shard <i/N>",
      "Run only shard i of N (1-based), e.g. --shard 2/4. Splits the collected test dirs across N runs.",
    )
    .option(
      "--collect-only",
      "With --coverage, write the raw coverage data but skip the report. Used by sharded CI runs, which merge the shards and report once elsewhere; generating a per-shard report would wastefully recompile every source file for its source map.",
    )
    .action(
      async (
        testFile: string[],
        opts: {
          parallel?: number;
          coverage?: boolean;
          accumulate?: boolean;
          shard?: string;
          collectOnly?: boolean;
        },
      ) => {
        const config = getConfig();
        if (opts.coverage) {
          process.env.AGENCY_COVERAGE = "1";
          process.env.AGENCY_COVERAGE_OUTDIR = path.resolve(config.coverage?.outDir ?? ".coverage");
          if (!opts.accumulate) {
            cleanCoverage(config);
          }
        }
        const shard = opts.shard ? parseShardSpec(opts.shard) : undefined;
        const parallel = opts.parallel ?? config.test?.parallel ?? 1;
        await testTs(config, testFile, parallel, shard);
        if (opts.coverage && !opts.collectOnly) {
          const reportTargets = testFile.length > 0 ? testFile : ["."];
          await generateReport(config, reportTargets);
        }
      },
    );

  testCmd
    .command("fixtures")
    .description("Generate test fixtures")
    .argument("[target]", "Target in file.agency:nodeName format")
    .action(async (target: string | undefined) => {
      await fixtures(getConfig(), target);
    });

  const coverageCmd = program.command("coverage").description("View test coverage reports");

  coverageCmd
    .command("report")
    .description("Generate coverage report from collected data")
    .argument("<target>", "Directory or .agency file to report on")
    .option("--html", "Generate HTML report")
    .option("--detail", "List uncovered line ranges per file")
    .option(
      "--threshold <percent>",
      "Fail (exit 1) when total coverage falls below this percent (0–100)",
      (v) => parseFloat(v),
    )
    .option(
      "--per-file-threshold <percent>",
      "Fail (exit 1) when any file falls below this percent (0–100)",
      (v) => parseFloat(v),
    )
    .action(
      async (
        target: string,
        opts: {
          detail?: boolean;
          html?: boolean;
          threshold?: number;
          perFileThreshold?: number;
        },
      ) => {
        const result = await generateReport(getConfig(), target, {
          detail: opts.detail,
          html: opts.html,
          threshold: opts.threshold,
          perFileThreshold: opts.perFileThreshold,
        });
        if (!result.passed) process.exit(1);
      },
    );

  coverageCmd
    .command("clean")
    .description("Delete collected coverage data")
    .action(() => {
      cleanCoverage(getConfig());
    });

  program
    .command("definition")
    .description("Find the definition of the symbol at the given cursor position")
    .requiredOption("--line <line>", "0-indexed line number of the cursor")
    .requiredOption("--column <column>", "0-indexed column number of the cursor")
    .option("--file <file>", "Filename to report in output", "")
    .action(async (opts: { line: string; column: string; file: string }) => {
      const { findDefinition } = await import("@/cli/definition.js");
      const contents = await readStdin();
      const result = findDefinition(
        contents,
        parseInt(opts.line, 10),
        parseInt(opts.column, 10),
        opts.file,
      );
      console.log(JSON.stringify(result));
    });

  program
    .command("diagnostics")
    .description("Run diagnostics for VSCode")
    .argument("[inputs...]", "Paths to .agency input files")
    .action(async (inputs: string[]) => {
      // Route through parseAgency so the payload is the normalized
      // ParseAgencyErrorData (zero-indexed user-source coordinates), covering
      // both committed and recoverable parse failures. Parsing does not depend
      // on config, so pass {} rather than getConfig(): a broken agency.json
      // must not take editor diagnostics down with it. applyTemplate:false keeps
      // coordinates in the exact source the editor supplied; lower:false keeps
      // this to syntax diagnostics.
      await forEachSource(inputs, (contents) => {
        const result = parseAgency(contents, {}, false, false);
        if (result.success) return;
        // Always emit a payload for a failure. A rare failure path returns no
        // errorData; fall back to a minimal one. `result.message` is optional,
        // so normalize it to a non-empty string for both required message
        // fields of ParseAgencyErrorData.
        const message = result.message ?? "Parse error";
        const errorData = result.errorData ?? {
          line: 0,
          column: 0,
          length: 1,
          message,
          prettyMessage: message,
        };
        console.log(JSON.stringify(errorData, null, 2));
      });
    });

  program
    .command("typecheck")
    .alias("tc")
    .alias("check")
    .description("Type check .agency file(s) (reads from stdin if no input)")
    .argument("[inputs...]", "Paths to .agency input files")
    .option("--strict", "Enable strict types (untyped variables are errors)")
    .action(async (inputs: string[], opts: { strict?: boolean }) => {
      const config = getConfig();
      let hasErrors = false;
      const runTypeCheck = (contents: string, filePath?: string, symbolTable?: SymbolTable) => {
        const parsed = parse(contents, config);
        const absPath = filePath ? path.resolve(filePath) : undefined;
        // Expand `$( ... )` first, or every name a splice generates checks
        // as undefined. This command has its own pipeline and does not go
        // through runCheckerPipeline. Stdin has no path to resolve a
        // generator against, so splices are left alone there.
        const expanded = absPath === undefined ? null : expandSplices(parsed, absPath, config);
        if (expanded !== null && !expanded.ok) {
          console.error(formatSpliceDiagnostic(expanded.diagnostic, absPath));
          hasErrors = true;
          return;
        }
        const parsedProgram = expanded?.ok ? expanded.value : parsed;
        const info = buildCompilationUnit(parsedProgram, symbolTable, absPath, contents);
        const { errors } = typeCheck(parsedProgram, config, info);
        if (errors.length > 0) {
          console.error(formatErrors(errors));
          const hint = formatDiagnosticsHint(errors);
          if (hint) console.error(hint);
          if (errors.some((e) => e.severity === "error")) {
            hasErrors = true;
          }
        } else {
          console.log("No type errors found.");
        }
      };
      if (opts.strict) {
        config.typechecker = { ...config.typechecker, strictTypes: true };
      }
      const sources = resolveInputSources(inputs);
      if (sources === null) {
        return;
      }
      // Build one SymbolTable seeded from EVERY file source, not just the
      // first. `SymbolTable.build` accepts an array of entrypoints and crawls
      // reachable files (imports + stdlib) from each, deduping via its visited
      // set. Seeding from only the first file leaves files whose imports are
      // unreachable from it unable to resolve those imports: the imported
      // functions/types become `any` (unresolved agency imports are fail-open),
      // so real cross-file type errors are SILENTLY MISSED, and interrupt-effect
      // metadata is dropped. Seeding from every file makes typechecking of the
      // whole directory complete. The symbol table stays file-keyed, so adding
      // more entrypoints never merges or pollutes across files.
      const filePaths = sources.filter((s) => s.kind === "file").map((s) => path.resolve(s.path));
      const symbolTable = filePaths.length ? SymbolTable.build(filePaths, config) : undefined;
      for (const src of sources) {
        const contents = await readSource(src);
        if (src.kind === "stdin") {
          runTypeCheck(contents);
        } else {
          runTypeCheck(contents, src.path, symbolTable);
        }
      }
      if (hasErrors) process.exit(1);
    });

  program
    .command("explain")
    .description("Explain a type-checker diagnostic code (e.g. AG2005)")
    .argument("[code]", "An AG#### code or registry name; omit to list all")
    .option("--list", "List every diagnostic code")
    .action((code: string | undefined, opts: { list?: boolean }) => {
      if (!code || opts.list) {
        console.log(renderDiagnosticList());
        return;
      }
      const { text, found } = renderDiagnosticText(code);
      if (found) {
        console.log(text);
      } else {
        console.error(text);
        process.exit(1);
      }
    });

  program
    .command("lint")
    .description("Lint .agency file(s) for style issues (reads from stdin if no input)")
    .argument("[inputs...]", "Paths to .agency input files")
    .action(async (inputs: string[]) => {
      const config = getConfig();
      let anyFindings = false;
      await forEachSource(inputs, (contents, src) => {
        const filePath = src.kind === "file" ? src.path : "<stdin>";
        const findings = lintSource(contents, filePath, config);
        if (findings.length > 0) {
          anyFindings = true;
          console.log(formatFindings(filePath, findings));
          console.log("");
        }
      });
      if (!anyFindings) {
        console.log("No lint findings.");
      } else {
        console.log("Run `agency explain <code>` for details.");
      }
      // All v1 findings are hints; hints never fail CI, so the exit code
      // stays 0. The PR that adds the first warning-severity rule adds the
      // non-zero path.
    });

  program
    .command("debug", { hidden: true })
    .description("Debug an Agency file interactively")
    .argument("<file>", "Agency file to debug")
    .option("--node <name>", "Node to execute")
    .option("--rewind-size <n>", "Rolling checkpoint window size", "30")
    .option("--trace <file>", "Load and inspect a trace file")
    .option("--checkpoint <file>", "Load and inspect a checkpoint file")
    .option(
      "--dist-dir <dir>",
      "Import pre-compiled JS from this directory instead of compiling on the fly",
    )
    .action(
      async (
        file: string,
        options: {
          node?: string;
          rewindSize: string;
          trace?: string;
          checkpoint?: string;
          distDir?: string;
        },
      ) => {
        const config = getConfig();
        await debug(config, file, {
          node: options.node,
          rewindSize: parseInt(options.rewindSize, 10),
          trace: options.trace,
          checkpoint: options.checkpoint,
          distDir: options.distDir,
        });
      },
    );

  program
    .command("bundle")
    .description("Create a bundle from a source file and trace")
    .argument("<source>", "Path to main .agency source file")
    .argument("<trace>", "Path to .trace file")
    .option("-o, --output <file>", "Output bundle file path")
    .action((source: string, trace: string, options: { output?: string }) => {
      const parsed = path.parse(source);
      const output = options.output || path.join(parsed.dir, parsed.name + ".bundle");
      createBundle(source, trace, output);
      console.log(`Bundle created: ${output}`);
    });

  program
    .command("unbundle")
    .description("Extract source files and trace from a bundle")
    .argument("<bundle>", "Path to .bundle file")
    .requiredOption("-o, --output <dir>", "Output directory")
    .action((bundle: string, options: { output: string }) => {
      console.log(`Extracting ${bundle} to ${options.output}/`);
      extractBundle(bundle, options.output);
      console.log("Done.");
    });

  program
    .command("doc")
    .description("Generate Markdown documentation for .agency file(s)")
    .argument("<input>", "Path to .agency file or directory")
    .option("-o, --output <dir>", "Output directory for generated docs")
    .option("--ignore <dirs...>", "Directory names to ignore when scanning recursively")
    .option("--base-url <url>", "Base URL for source links")
    .action((input: string, opts: { output?: string; ignore?: string[]; baseUrl?: string }) => {
      const config = getConfig();
      const outputDir = opts.output || config.doc?.outDir || "docs";
      generateDoc(config, input, outputDir, opts.ignore || [], opts.baseUrl);
    });

  const literate = program
    .command("literate")
    .description("Render Agency code as literate-programming markdown");

  literate
    .command("weave")
    .description("Render .agency file(s) as markdown")
    .argument("<input>", "Path to .agency file or directory")
    .option("-o, --output <dir>", "Output directory", "literate")
    .option("--ignore <dirs...>", "Directory names to ignore when scanning recursively")
    .option("--lang <name>", "Code-fence language tag", "agency")
    .option("--base-url <url>", "Base URL for a 'View source' link at the top")
    .action(
      (
        input: string,
        opts: {
          output: string;
          ignore?: string[];
          lang: string;
          baseUrl?: string;
        },
      ) => {
        const config = getConfig();
        generateLiterate(config, input, opts.output, opts.ignore || [], opts.lang, opts.baseUrl);
      },
    );

  const localCmd = program.command("local").description("Manage and run local models");
  localCmd
    .command("list")
    .description("List local models: the full catalog, with downloaded models marked")
    .option("-l, --long", "Show each model's description on its own line")
    .action((opts: { long?: boolean }) => localList(opts.long === true));
  localCmd
    .command("download")
    .description("Download a model (curated name, alias, or hf: URI); no argument opens a picker")
    .argument("[value]")
    .action(localDownload);
  localCmd
    .command("remove")
    .description("Delete a downloaded model")
    .argument("<name>")
    .action(localRemove);
  localCmd
    .command("resolve")
    .description("Show what a name/alias resolves to")
    .argument("<value>")
    .action(localResolve);
  localCmd
    .command("refresh")
    .description("Refresh the model catalog from the remote source")
    .argument("[url]", "Override the catalog URL (else env/config/default)")
    .action(localRefresh);
  const aliasCmd = localCmd.command("alias").description("Manage model name aliases");
  aliasCmd
    .command("list")
    .description("List usable short names (curated + aliases)")
    .action(localAliasList);
  aliasCmd
    .command("add")
    .description("Add a short-name alias")
    .argument("<name>")
    .argument("<uri>")
    .action(localAliasAdd);
  aliasCmd
    .command("remove")
    .description("Remove a short-name alias")
    .argument("<name>")
    .action(localAliasRemove);

  const modelsCmd = program.command("models").description("Browse the hosted model catalog");
  modelsCmd
    .command("list")
    .description("List hosted models (filterable)")
    .argument(
      "[files...]",
      "Model-data JSON files to also load and include (as printed by `agency models refresh`)",
    )
    .option("--provider <name>", "Only this provider")
    .option("--max-price <usd>", "Max input $/1M tokens", parseFloat)
    .option("--min-context <tokens>", "Min context window", parseInt)
    .action(
      (files: string[], opts: { provider?: string; maxPrice?: number; minContext?: number }) =>
        modelsList(opts, files),
    );
  modelsCmd
    .command("refresh")
    .description(
      "Fetch the latest model data and print it as JSON (redirect to a file, then load with std::llm.loadModelData)",
    )
    .argument("[url]", "Optional URL to fetch model data from (defaults to the built-in source)")
    .action((url?: string) => modelsRefresh(url));

  // Full delegation: the agent command owns ZERO flags and its whole tail is
  // the agent's. The agent's own parseArgs schema is the single source of
  // help and flag errors; --max-cost/--max-time live there too, extracted by
  // the launcher pre-scan (resolveAgentLaunchArgs) before spawn.
  program
    .command("agent")
    .passThroughOptions({ boundary: "immediate" })
    .description(
      "Launch the Agency language assistant agent (run `agency agent --help` for agent flags)",
    )
    .argument("[args...]", "Arguments forwarded to the agent")
    .helpOption(false)
    .action((args: string[]) => {
      const launchAgent = deps.launchAgent ?? agent;
      launchAgent(getConfig(), args, {
        // Present only when the user explicitly wrote -c; cwd config
        // discovery never sets this option — the provenance the staged
        // configured compile needs.
        explicitConfigPath: program.opts().config as string | undefined,
      });
    });

  program
    .command("doctor")
    .description("Diagnose problems with an Agency file using the agency agent")
    .argument("<file>", "Path to the .agency file to diagnose")
    .option("--symptom <text>", "Optional description of the problem you are seeing")
    .option("--trace [file]", "Write an execution trace of the diagnosis to this file")
    .option("--log-file <path>", "Append statelog events from the diagnosis to this file")
    .action(
      (file: string, opts: { symptom?: string; trace?: string | boolean; logFile?: string }) => {
        const config = getConfig();
        doctor(config, file, {
          symptom: opts.symptom,
          trace: opts.trace as string | true | undefined,
          logFile: opts.logFile,
        });
      },
    );

  const configCmd = program.command("config").description("Inspect Agency configuration");

  configCmd
    .command("show")
    .description("Print the resolved, merged agency.json config as JSON")
    .option(
      "--show-secrets",
      "Print API keys verbatim instead of masking them (avoid in shared logs / bug reports)",
    )
    .action((opts: { showSecrets?: boolean }) => {
      const config = getConfig();
      console.log(JSON.stringify(opts.showSecrets ? config : redactConfigSecrets(config), null, 2));
    });

  program
    .command("review", { hidden: true })
    .description("Review an Agency file for type errors and code quality")
    .argument("<file>", "The .agency file to review")
    .action((file: string) => {
      const config = getConfig();
      review(config, file);
    });

  const scheduleCmd = program.command("schedule").description("Manage scheduled agent runs");

  // A flag the selected backend cannot honor must fail loudly, not be
  // silently ignored — in BOTH directions (remote-only flags on the
  // local/github paths, local/github-only flags on the remote path).
  function rejectRemoteOnlyFlags(used: string[]): void {
    if (used.length > 0) {
      console.error(
        color.red(`${used.join(", ")} require${used.length === 1 ? "s" : ""} --backend remote.`),
      );
      process.exit(1);
    }
  }

  function rejectFlagsUnsupportedByRemote(used: string[]): void {
    if (used.length > 0) {
      console.error(
        color.red(
          `${used.join(", ")} ${used.length === 1 ? "is" : "are"} not supported with --backend remote.`,
        ),
      );
      process.exit(1);
    }
  }

  function rejectUnknownScheduleBackend(backend: string | undefined, allowed: string[]): void {
    if (backend !== undefined && !allowed.includes(backend)) {
      console.error(
        color.red(
          `Unknown --backend value: "${backend}". Accepted here: ${allowed.join(", ")}. Local backends (launchd, systemd, crontab) are auto-detected.`,
        ),
      );
      process.exit(1);
    }
  }

  scheduleCmd
    .command("add")
    .description("Schedule an agent to run on a recurring basis")
    .argument("<file>", "Path to .agency file")
    .option(
      "--every <preset>",
      "Schedule preset: minute, hourly, daily, weekdays, weekends (Sat+Sun), weekly, monthly — singular forms (hour, day, weekday, weekend, week, month) also accepted",
    )
    .option("--cron <expression>", "Cron expression (5 fields)")
    .option("--name <name>", "Schedule name (default: derived from filename)")
    .option("--env-file <path>", "Path to .env file")
    .option(
      "--backend <type>",
      "Force a non-default backend: 'github' or 'remote' (hosted statelog). Local backends (launchd, systemd, crontab) are auto-detected.",
    )
    .option(
      "--secret <name>",
      "github backend: add a GitHub Actions secret to the workflow env (repeatable)",
      (value: string, prev: string[] = []) => [...prev, value],
      [] as string[],
    )
    .option("--write", "github backend: grant contents: write + pull-requests: write permissions")
    .option("--no-pin", "github backend: emit @<tag> instead of @<sha> for action references")
    .option("--node <name>", "remote backend: the exported node to schedule")
    .option("--function <name>", "remote backend: the exported function to schedule")
    .option(
      "--arg <name=value>",
      "remote backend: a named argument for the target (repeatable)",
      (value: string, prev: string[] = []) => [...prev, value],
      [] as string[],
    )
    .option("--data <json>", "remote backend: a JSON object of arguments for the target")
    .option(
      "--timezone <iana>",
      "remote backend: IANA timezone for the cron (default: this machine's zone)",
    )
    .option("--redeploy", "remote backend: deploy the agent before scheduling, even if present")
    .option("--no-deploy", "remote backend: never deploy; fail if the agent is not on the server")
    .option("--host <url>", "remote backend: statelog host (default: agency.json log.host)")
    .option("--project <slug>", "remote backend: statelog project (default: the linked project)")
    .option("--api-key-env <NAME>", "remote backend: env var holding the API key")
    .action(
      async (
        file: string,
        opts: {
          every?: string;
          cron?: string;
          name?: string;
          envFile?: string;
          backend?: string;
          secret?: string[];
          write?: boolean;
          // commander exposes `--no-pin` as `pin: false` (defaults to true).
          pin?: boolean;
          node?: string;
          function?: string;
          arg?: string[];
          data?: string;
          timezone?: string;
          redeploy?: boolean;
          // commander exposes `--no-deploy` as `deploy: false` (defaults to true).
          deploy?: boolean;
          host?: string;
          project?: string;
          apiKeyEnv?: string;
        },
      ) => {
        rejectUnknownScheduleBackend(opts.backend, ["github", "remote"]);
        if (opts.backend === "remote") {
          const unsupported: string[] = [];
          if (opts.envFile !== undefined) unsupported.push("--env-file");
          if (opts.secret !== undefined && opts.secret.length > 0) unsupported.push("--secret");
          if (opts.write) unsupported.push("--write");
          if (opts.pin === false) unsupported.push("--no-pin");
          rejectFlagsUnsupportedByRemote(unsupported);
          await addRemote(file, opts, getConfigContext());
          return;
        }
        const usedRemoteFlags: string[] = [];
        if (opts.node !== undefined) usedRemoteFlags.push("--node");
        if (opts.function !== undefined) usedRemoteFlags.push("--function");
        if (opts.arg !== undefined && opts.arg.length > 0) usedRemoteFlags.push("--arg");
        if (opts.data !== undefined) usedRemoteFlags.push("--data");
        if (opts.timezone !== undefined) usedRemoteFlags.push("--timezone");
        if (opts.redeploy) usedRemoteFlags.push("--redeploy");
        if (opts.deploy === false) usedRemoteFlags.push("--no-deploy");
        if (opts.host !== undefined) usedRemoteFlags.push("--host");
        if (opts.project !== undefined) usedRemoteFlags.push("--project");
        if (opts.apiKeyEnv !== undefined) usedRemoteFlags.push("--api-key-env");
        rejectRemoteOnlyFlags(usedRemoteFlags);
        const addOpts = {
          ...opts,
          file,
          backend: opts.backend as "github" | undefined,
          secrets: opts.secret,
          noPin: opts.pin === false,
        };
        try {
          scheduleAdd(addOpts);
          const name = opts.name || path.basename(file, ".agency");
          console.log(color.green(`Schedule "${name}" added successfully.`));
        } catch (err: any) {
          if (err instanceof ScheduleExistsError && process.stdin.isTTY) {
            const confirmed = await promptScheduleOverwrite(err.scheduleName);
            if (confirmed) {
              try {
                scheduleAdd({ ...addOpts, force: true });
                console.log(color.green("Schedule overwritten successfully."));
              } catch (overwriteErr: any) {
                console.error(color.red(overwriteErr.message));
                process.exit(1);
              }
            } else {
              console.log("Aborted.");
            }
          } else {
            console.error(color.red(err.message));
            process.exit(1);
          }
        }
      },
    );

  type RemoteTargetFlags = { host?: string; project?: string; apiKeyEnv?: string };

  function usedRemoteTargetFlags(opts: RemoteTargetFlags): string[] {
    const used: string[] = [];
    if (opts.host !== undefined) used.push("--host");
    if (opts.project !== undefined) used.push("--project");
    if (opts.apiKeyEnv !== undefined) used.push("--api-key-env");
    return used;
  }

  scheduleCmd
    .command("list")
    .alias("ls")
    .description("List all scheduled agents")
    .option("--backend <type>", "'remote' lists schedules on the hosted statelog server")
    .option("--host <url>", "remote backend: statelog host (default: agency.json log.host)")
    .option("--project <slug>", "remote backend: statelog project (default: the linked project)")
    .option("--api-key-env <NAME>", "remote backend: env var holding the API key")
    .action(async (opts: RemoteTargetFlags & { backend?: string }) => {
      rejectUnknownScheduleBackend(opts.backend, ["remote"]);
      if (opts.backend === "remote") {
        await listRemote(opts, getConfigContext());
        return;
      }
      rejectRemoteOnlyFlags(usedRemoteTargetFlags(opts));
      console.log(formatListTable(scheduleList({})));
    });

  scheduleCmd
    .command("remove")
    .alias("rm")
    .description("Remove a scheduled agent")
    .argument("<name>", "Name of the schedule to remove (remote backend: the schedule id)")
    .option("--backend <type>", "'remote' removes a schedule on the hosted statelog server")
    .option("--host <url>", "remote backend: statelog host (default: agency.json log.host)")
    .option("--project <slug>", "remote backend: statelog project (default: the linked project)")
    .option("--api-key-env <NAME>", "remote backend: env var holding the API key")
    .action(async (name: string, opts: RemoteTargetFlags & { backend?: string }) => {
      rejectUnknownScheduleBackend(opts.backend, ["remote"]);
      if (opts.backend === "remote") {
        await removeRemote(name, opts, getConfigContext());
        return;
      }
      rejectRemoteOnlyFlags(usedRemoteTargetFlags(opts));
      try {
        scheduleRemove({ name });
        console.log(color.green(`Schedule "${name}" removed.`));
      } catch (err: any) {
        console.error(color.red(err.message));
        process.exit(1);
      }
    });

  scheduleCmd
    .command("edit")
    .description("Edit an existing scheduled agent")
    .argument("<name>", "Name of the schedule to edit (remote backend: the schedule id)")
    .option(
      "--every <preset>",
      "Schedule preset: minute, hourly, daily, weekdays, weekends (Sat+Sun), weekly, monthly — singular forms (hour, day, weekday, weekend, week, month) also accepted",
    )
    .option("--cron <expression>", "Cron expression (5 fields)")
    .option("--env-file <path>", "Path to .env file")
    .option("--backend <type>", "'remote' edits a schedule on the hosted statelog server")
    .option("--timezone <iana>", "remote backend: IANA timezone for the cron")
    .option("--enabled", "remote backend: enable the schedule")
    .option("--disabled", "remote backend: disable the schedule")
    .option("--host <url>", "remote backend: statelog host (default: agency.json log.host)")
    .option("--project <slug>", "remote backend: statelog project (default: the linked project)")
    .option("--api-key-env <NAME>", "remote backend: env var holding the API key")
    .action(
      async (
        name: string,
        opts: RemoteTargetFlags & {
          every?: string;
          cron?: string;
          envFile?: string;
          backend?: string;
          timezone?: string;
          enabled?: boolean;
          disabled?: boolean;
        },
      ) => {
        rejectUnknownScheduleBackend(opts.backend, ["remote"]);
        if (opts.backend === "remote") {
          const unsupported: string[] = [];
          if (opts.envFile !== undefined) unsupported.push("--env-file");
          rejectFlagsUnsupportedByRemote(unsupported);
          await editRemote(name, opts, getConfigContext());
          return;
        }
        const usedFlags = usedRemoteTargetFlags(opts);
        if (opts.timezone !== undefined) usedFlags.push("--timezone");
        if (opts.enabled) usedFlags.push("--enabled");
        if (opts.disabled) usedFlags.push("--disabled");
        rejectRemoteOnlyFlags(usedFlags);
        try {
          scheduleEdit({ name, ...opts });
          console.log(color.green(`Schedule "${name}" updated.`));
        } catch (err: any) {
          console.error(color.red(err.message));
          process.exit(1);
        }
      },
    );

  scheduleCmd
    .command("test")
    .description("Verify cron functionality by scheduling a test agent that runs every minute")
    .action(() => {
      try {
        const result = scheduleTest();
        console.log(color.green(`Schedule "${result.name}" added successfully.`));
        console.log("");
        console.log(`Wrote test agent: ${result.agentFile}`);
        console.log(`It will run every minute and write the current time to:`);
        console.log(`  ${result.outputFile}`);
        console.log("");
        console.log("Wait at least one minute, then check that file. If it contains a");
        console.log("recent timestamp, cron is working.");
        console.log("");
        console.log("If the file is missing, check the run logs for errors:");
        console.log(`  ${result.logDir}`);
        if (process.platform === "darwin") {
          console.log("");
          console.log("On macOS, scheduled jobs may need Full Disk Access. If logs show");
          console.log("permission errors, grant access to /bin/bash in System Settings →");
          console.log("Privacy & Security → Full Disk Access.");
        }
        console.log("");
        console.log("To remove the test schedule when you're done, run:");
        console.log(color.cyan(`  agency schedule remove ${result.name}`));
      } catch (err: any) {
        console.error(color.red(err.message));
        process.exit(1);
      }
    });

  const lspCmd = program
    .command("lsp")
    .description("Start the Agency Language Server (LSP) over stdio")
    .action(async () => {
      const startServer = await loadLspStartServer();
      startServer();
    });

  lspCmd
    .command("setup")
    .description("Scaffold coding-agent LSP configuration for this project")
    .argument("<targets...>", `One or more targets: ${SUPPORTED_AGENT_LSP_TARGETS.join(", ")}`)
    .action((targets: string[]) => {
      let failed = false;
      for (const rawTarget of targets) {
        if (!SUPPORTED_AGENT_LSP_TARGETS.includes(rawTarget as AgentLspTarget)) {
          console.error(
            `Unsupported target '${rawTarget}'. Expected one of: ${SUPPORTED_AGENT_LSP_TARGETS.join(", ")}`,
          );
          failed = true;
          continue;
        }
        const result = setupAgentLsp(rawTarget as AgentLspTarget);
        const stream = result.ok ? console.log : console.error;
        stream(result.message);
        for (const filePath of result.files) {
          stream(`  wrote ${filePath}`);
        }
        if (!result.ok) {
          failed = true;
        }
      }
      if (failed) {
        process.exitCode = 1;
      }
    });

  const mcpCmd = program
    .command("mcp")
    .description("Start the Agency MCP server over stdio")
    .action(async () => {
      const startMcpServer = await loadMcpStartServer();
      startMcpServer();
    });

  // Manage the MCP servers the agency AGENT connects to (grouped under `mcp`
  // alongside serving, like `claude mcp serve` vs `claude mcp add`).
  mcpCmd
    .command("list")
    .description("List the Agency agent's configured MCP servers")
    .action(() => {
      process.exitCode = mcpList();
    });
  mcpCmd
    .command("add <name>")
    .description("Add an MCP server the Agency agent connects to")
    .option("--command <cmd>", "stdio server command (e.g. npx)")
    .option("--args <list>", "comma-separated stdio args")
    .option("--url <url>", "HTTP server URL")
    .option("--oauth", "authenticate the HTTP server with OAuth")
    .option("--project", "write the project agency.json (default)")
    .option("--global", "write the agent-home settings.json instead")
    .action(async (name: string, opts: McpAddOptions) => {
      process.exitCode = await mcpAdd(name, opts);
    });
  mcpCmd
    .command("remove <name>")
    .description("Remove an MCP server the Agency agent connects to")
    .option("--project", "remove from the project agency.json (default)")
    .option("--global", "remove from the agent-home settings.json instead")
    .action(async (name: string, opts: { global?: boolean }) => {
      process.exitCode = await mcpRemove(name, opts);
    });

  const mcpSetupCmd = mcpCmd
    .command("setup")
    .description("Configure coding agents to use the Agency MCP server");

  mcpSetupCmd
    .command("codex")
    .description("Configure Codex to use the Agency MCP server")
    .option("--codex-config <path>", "Path to the Codex config file")
    .option("--server-name <name>", "MCP server name", "agency")
    .action(function (this: Command) {
      const opts = this.opts<{ codexConfig?: string; serverName: string }>();
      const result = setupCodexMcp(
        opts.codexConfig ?? codexConfigPath(),
        resolveMcpCommand(),
        opts.serverName,
      );
      console.log(result.message);
      console.log(`  command: ${resolveMcpCommand().join(" ")}`);
    });

  const serveCmd = program.command("serve").description("Serve Agency code over MCP or HTTP");

  serveCmd
    .command("mcp")
    .description("Start an MCP server (stdio by default; --transport http for Streamable HTTP)")
    .argument("<file>", "Agency file to serve")
    .option("--name <name>", "Server name (defaults to filename)")
    .option("--transport <transport>", "Transport: 'stdio' (default) or 'http' (Streamable HTTP)")
    .option("--port <port>", "HTTP port (http transport only, default: 3545)")
    .option(
      "--host <host>",
      "Interface to bind to (http transport only, default: 127.0.0.1, loopback only). Use 0.0.0.0 to expose externally — requires --api-key/--api-key-env.",
    )
    .option(
      "--path <path>",
      "Endpoint path the MCP server is mounted at (http transport only, default: /mcp)",
    )
    .option(
      "--api-key <key>",
      "API key for authentication (http transport only). NOT recommended: visible in process listings. Prefer --api-key-env.",
    )
    .option(
      "--api-key-env <name>",
      "Name of the environment variable to read the API key from (http transport only). For --standalone, the bundle reads this env var at runtime (default: API_KEY).",
    )
    .option("--standalone", "Generate a standalone server.js file")
    .action(
      async (
        file: string,
        options: {
          name?: string;
          standalone?: boolean;
          transport?: string;
          port?: string;
          host?: string;
          path?: string;
          apiKey?: string;
          apiKeyEnv?: string;
        },
      ) => {
        await serveMcp(file, options);
      },
    );

  serveCmd
    .command("http")
    .description("Start an HTTP REST server")
    .argument("<file>", "Agency file to serve")
    .option("--port <port>", "HTTP port (default: 3545)", "3545")
    .option(
      "--host <host>",
      "Interface to bind to (default: 127.0.0.1, loopback only). Use 0.0.0.0 to expose externally — requires --api-key/--api-key-env.",
    )
    .option(
      "--api-key <key>",
      "API key for authentication. NOT recommended: visible in process listings. Prefer --api-key-env.",
    )
    .option(
      "--api-key-env <name>",
      "Name of the environment variable to read the API key from. For --standalone, the bundle reads this env var at runtime (default: API_KEY). Without --standalone, the key is read from the env var at serve time.",
    )
    .option("--standalone", "Generate a standalone server.js file")
    .action(
      async (
        file: string,
        options: {
          port?: string;
          host?: string;
          apiKey?: string;
          apiKeyEnv?: string;
          standalone?: boolean;
        },
      ) => {
        await serveHttp(file, options);
      },
    );

  const policyCmd = program
    .command("policy", { hidden: true })
    .description("Policy management tools");

  policyCmd
    .command("gen")
    .description("Generate an interrupt policy for an Agency agent")
    .argument("<file>", "The .agency file to analyze")
    .option("-o, --output <path>", "Output path for the policy file (default: policy.json)")
    .option("-p, --existing <path>", "Existing policy file to modify")
    .action((file: string, options: { output?: string; existing?: string }) => {
      const config = getConfig();
      policyGen(config, file, options);
    });

  program
    .command("interrupts", { hidden: true })
    .description("Print every interrupt site and the handle blocks that could enclose it")
    .argument("<file>", "The .agency file to analyze")
    .action((file: string) => {
      const config = getConfig();
      interruptsCmd(config, file);
    });

  // `agency greet.agency` is `agency run greet.agency` with the word left
  // out. The fallback dispatches the REAL run command object — one options
  // list, one action, one help — with invokedAsFallback() provenance for the
  // typo-vs-missing-file diagnosis in run's action.
  program.fallbackCommand("run");
  return program;
}

export async function runCli(
  argv: string[] = process.argv,
  deps: CliDependencies = {},
): Promise<void> {
  loadEnv();
  const program = createProgram(deps);
  // No argv rewriting: the program boundary and flag ownership live inside
  // the vendored commander fork (passThroughOptions, fallbackCommand).
  await program.parseAsync(argv);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;

if (isMain) {
  await runCli();
} else {
  console.warn("Not executing Agency CLI because it was imported as a module.");
}
