#!/usr/bin/env node
import {
  compile,
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
import {
  classifyInstall,
  installDirFromUrl,
} from "@/cli/installLocation.js";
import { pack } from "@/cli/pack.js";
import { resolveBudget } from "@/cli/budget.js";
import { fixtures, test, testTs, SlowTest } from "@/cli/test.js";
import { generateReport, cleanCoverage } from "@/cli/coverage.js";
import { createBundle, extractBundle } from "@/cli/bundle.js";
import { traceLog } from "@/cli/events.js";
import { logsView } from "@/cli/logsView.js";
import { evalExtract } from "@/cli/evalExtract.js";
import { evalJudge } from "@/cli/evalJudge.js";
import { evalRun } from "@/cli/eval/run.js";
import { evalOptimize } from "@/cli/eval/optimize.js";
import { renderDiagnosticText, renderDiagnosticList } from "@/cli/explain.js";
import {
  AgencyConfig,
  applyCliFlags,
  type CliFlags,
  redactConfigSecrets,
} from "@/config.js";
import * as path from "path";
import { _parseAgency } from "@/parser.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { SymbolTable } from "@/symbolTable.js";
import { formatErrors, formatDiagnosticsHint, typeCheck } from "@/typeChecker/index.js";
import { Command, InvalidArgumentError } from "commander";
import * as fs from "fs";
import { color } from "@/utils/termcolors.js";
import { TarsecError } from "tarsec";
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
import { loadEnv } from "@/utils/envfile.js";
import { debug } from "@/cli/debug.js";
import { generateDoc } from "@/cli/doc.js";
import { generateLiterate } from "@/cli/literate.js";
import { watchAndCompile } from "@/cli/watch.js";
import {
  setupAgentLsp,
  SUPPORTED_AGENT_LSP_TARGETS,
  type AgentLspTarget,
} from "@/lsp/setup.js";
import { setupCodexMcp, codexConfigPath } from "@/mcp/setup.js";
import { startServer } from "@/lsp/index.js";
import { startMcpServer } from "@/mcp/server.js";
import { pathToFileURL } from "url";
import { serveMcp, serveHttp } from "@/cli/serve.js";

// Per-run flags for `agency run` / the hidden default command: the shared
// CliFlags (mapped onto config by applyCliFlags in config.ts) plus --resume,
// which is a run-only concern, not a config field.
type RunOptions = CliFlags & {
  resume?: string;
  policy?: string;
  approve?: string;
  reject?: string;
  interactive?: boolean;
  maxCost?: string;
  maxTime?: string;
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

type CliDependencies = {
  loadLspStartServer?: () => Promise<() => void>;
  loadMcpStartServer?: () => Promise<() => void>;
  resolveMcpCommand?: () => string[];
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
  const loadLspStartServer =
    deps.loadLspStartServer ?? defaultLoadLspStartServer;
  const loadMcpStartServer =
    deps.loadMcpStartServer ?? defaultLoadMcpStartServer;
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

  function runWithOptions(input: string, options: RunOptions) {
    const config = applyCliFlags(getConfig(), options, input);
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
    run(config, input, undefined, options.resume, runPolicy, budget);
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
          for (const input of inputs) {
            compile(config, input, undefined, {
              ts: opts.ts,
              freshness: opts.force ? "force" : undefined,
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
    return cmd
      .option(
        "--resume <statefile>",
        "Resume execution from a saved state file",
      )
      .option(
        "--trace [file]",
        "Write execution trace to file (default: <input>.trace)",
      )
      .option(
        "--log-file <path>",
        "Append statelog events (one JSON object per line) to this file for this run",
      )
      .option(
        "--observability",
        "Enable statelog observability for this run (use with a configured host, or --log-file)",
      )
      .option(
        "--strict",
        "Fail the run on any fatal type error (typechecker.strict)",
      )
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
        "--policy <name|path>",
        "Interrupt policy: a built-in (recommended|minimal|with-writes|approve-all) or a policy JSON file",
      )
      .option(
        "--approve <effects>",
        "Comma-separated interrupt effects to auto-approve",
      )
      .option(
        "--reject <effects>",
        "Comma-separated interrupt effects to auto-reject",
      )
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
      );
  }

  addRunOptions(
    program
      .command("run")
      .description("Compile and run .agency file(s)")
      .argument("<input>", "Path to .agency input file"),
  ).action((input: string, options: RunOptions) => {
    runWithOptions(input, options);
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
    .action(
      async (input: string, opts: { output: string; target: string }) => {
        if (opts.target !== "node") {
          console.error(
            `Unsupported pack target: ${opts.target} (supported: node)`,
          );
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
      },
    );

  const traceCmd = program
    .command("trace")
    .description("Trace-related commands");

  traceCmd
    .command("run", { isDefault: true })
    .description("Compile and run .agency file, generating a trace")
    .argument("<input>", "Path to .agency input file")
    .option(
      "-o, --output <file>",
      "Output trace file path (default: <input>.trace)",
    )
    .option("--resume <statefile>", "Resume execution from a saved state file")
    .action((input: string, options: { output?: string; resume?: string }) => {
      const traceFile = options.output || input.replace(/\.agency$/, ".trace");
      runWithOptions(input, { trace: traceFile, resume: options.resume });
    });

  traceCmd
    .command("log")
    .description("Generate a JSON event log from a trace file")
    .argument("<file>", "Path to .trace, .agencytrace, or .agencybundle file")
    .option("-o, --output <file>", "Output JSON file path (default: stdout)")
    .action((file: string, options: { output?: string }) => {
      traceLog(file, options.output);
    });

  const logsCmd = program
    .command("logs")
    .description("Inspect StateLog output")
    // `view` is the default: `agency logs <file>` behaves like
    // `agency logs view <file>`. The argument is optional so bare
    // `agency logs` (no subcommand, no file) falls through to help.
    .argument("[file]", "Path to a .statelog.jsonl file, or '-' for stdin")
    .option("-f, --follow", "Tail the file — re-read and re-render as new events are appended")
    .action(async (file: string | undefined, options: { follow?: boolean }) => {
      if (!file) {
        logsCmd.help();
        return;
      }
      await logsView(file, { follow: options.follow });
    });

  logsCmd
    .command("view")
    .description("Open an interactive TUI viewer for a statelog JSONL file")
    .argument("<file>", "Path to a .statelog.jsonl file, or '-' for stdin")
    .option("-f, --follow", "Tail the file — re-read and re-render as new events are appended")
    .action(async (file: string, options: { follow?: boolean }) => {
      await logsView(file, { follow: options.follow });
    });

  const evalCmd = program
    .command("eval")
    .description("Evaluate agent runs against task fixtures");

  evalCmd
    .command("run")
    .description("Run an Agency agent against an eval task suite")
    .requiredOption("--agent <target>", "Agent .agency file or directory, optionally suffixed with :node")
    .option("--inputs <fileOrDir>", "Input suite JSON file or directory")
    .option("--goal <text>", "Run one inline input with this goal")
    .option("--run-id <id>", "Run id / output subdirectory")
    .option("--runs-dir <path>", "Runs output directory")
    .option("--continue-on-error", "Continue after task failures", true)
    .option("--no-continue-on-error", "Stop after first input failure")
    .option("-v, --verbose", "Log per-input progress to stderr")
    .action(async (opts: {
      agent: string;
      inputs?: string;
      goal?: string;
      runId?: string;
      runsDir?: string;
      continueOnError?: boolean;
      verbose?: boolean;
    }) => {
      const result = await evalRun({ ...opts, config: getConfig() });
      console.log(`Run ${result.runId} completed: ${result.okCount}/${result.inputs.length} inputs ok`);
      console.log(path.join(result.runDir, "summary.json"));
      if (result.errorCount > 0 && opts.continueOnError === false) {
        process.exit(2);
      }
    });

  evalCmd
    .command("extract")
    .description(
      "Extract a structured eval record from a statelog file. " +
      "Use this on the trace of one agent run to produce a JSON " +
      "artifact you can grade with an LLM judge or compare against " +
      "another run.",
    )
    .argument("<file>", "Path to a .statelog.jsonl file")
    .option(
      "-o, --out <path>",
      "Output JSON path (default: <file>.eval.json)",
    )
    .option(
      "--preview-chars <n>",
      "Max chars for tool args/output previews (default: 200, 0 for full)",
      (v) => parseInt(v, 10),
    )
    .option(
      "--compact",
      "Emit compact JSON instead of pretty-printed (pipelines / diffs)",
    )
    .action(
      async (
        file: string,
        opts: { out?: string; previewChars?: number; compact?: boolean },
      ) => {
        await evalExtract(file, {
          out: opts.out,
          previewChars: opts.previewChars,
          pretty: !opts.compact,
        });
      },
    );

  evalCmd
    .command("judge")
    .description("Compare two eval records or eval run directories")
    .argument("<inputA>", "Path to first eval record (.eval.json) or run directory")
    .argument("<inputB>", "Path to second eval record (.eval.json) or run directory")
    .option("--goal <text>", "Goal used to judge responses")
    .option("--inputs <fileOrDir>", "Eval input suite for run-directory comparison")
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
          inputs?: string;
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

  // Registered under both `agency eval optimize` and the top-level `agency optimize`.
  const addOptimizeCommand = (parent: Command): void => {
    parent
      .command("optimize")
      .description("Optimize marked Agency declarations against an eval goal or input suite")
      .argument("<agent>", "Agency file target: file.agency[:node]")
      .option("--goal <text>", "Goal to optimize for")
      .option("--inputs <fileOrDir>", "Input suite JSON file or directory")
      .option("--graders <file>", "TypeScript grading module (default-exports graders)")
      .option("--validation-inputs <fileOrDir>", "Held-out validation input suite")
      .option("--validation-split <ratio>", "Hold out this fraction of inputs for validation", (v) => parseFloat(v))
      .option("--iterations <n>", "Maximum candidate iterations", (v) => parseInt(v, 10))
      .option("--run-id <id>", "Run id / output subdirectory")
      .option("--runs-dir <path>", "Optimizer runs output directory")
      .option("--no-writeback", "Do not write the champion back to source files")
      .option("--mutator-model <model>", "Model to use for proposing mutations")
      .option("--optimizer <nameOrPath>", "Optimization strategy: a built-in name (greedy, gepa, example) or a path to an optimizer module (.ts/.js/.mjs, or any path containing /)")
      .option("--minibatch <n>", "GEPA minibatch size (gepa optimizer only)", (v) => parseInt(v, 10))
      .option("--seed <n>", "RNG seed for reproducible search (gepa optimizer)", (v) => parseInt(v, 10))
      .option("--samples <n>", "Judge samples per input", parseInt)
      .option("--confidence-threshold <n>", "Minimum confidence counted as a win", parseInt)
      .option("--margin-threshold <n>", "Suite win margin required", parseInt)
      .option("--silent", "Print nothing; artifacts are still written")
      .action(async (agent: string, opts: {
        goal?: string;
        inputs?: string;
        graders?: string;
        validationInputs?: string;
        validationSplit?: number;
        iterations?: number;
        runId?: string;
        runsDir?: string;
        writeback: boolean;
        mutatorModel?: string;
        optimizer?: string;
        minibatch?: number;
        seed?: number;
        samples?: number;
        confidenceThreshold?: number;
        marginThreshold?: number;
        silent?: boolean;
      }) => {
        const result = await evalOptimize({ ...opts, agent, config: getConfig() });
        if (!opts.silent) {
          console.log(`Optimize ${result.runId} completed: ${result.acceptedCount} accepted, ${result.rejectedCount} rejected`);
          console.log(path.join(result.runDir, "summary.json"));
        }
      });
  };
  addOptimizeCommand(evalCmd);
  addOptimizeCommand(program);

  program
    .command("format")
    .alias("fmt")
    .description(
      "Format .agency file(s) or directory(s) (reads from stdin if no input)",
    )
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
    .description(
      "Parse .agency file(s) and show AST (reads from stdin if no input)",
    )
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
        const preprocessor = new TypescriptPreprocessor(
          parsedProgram,
          config,
          info,
        );
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
    console.log(
      color.yellow(`\n Slowest ${Math.min(count, top.length)} tests:`),
    );
    for (const t of top) {
      console.log(
        `   ${color.yellow(formatDuration(t.durationMs))}  ${t.name}`,
      );
    }
  }

  const testCmd = program
    .command("test")
    .description("Run tests (default), or use subcommands: js, fixtures");

  testCmd
    .command("run", { isDefault: true })
    .description("Run Agency test files")
    .argument("[inputs...]", "Paths to .test.json files or directories")
    .option(
      "-p, --parallel <number>",
      "Number of test files to run in parallel",
      parseInt,
    )
    .option("--coverage", "Enable coverage collection and report")
    .option("--accumulate", "Preserve existing coverage data (use with --coverage)")
    .action(async (testFile: string[], opts: { parallel?: number; coverage?: boolean; accumulate?: boolean }) => {
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
      const parallel = opts.parallel ?? config.test?.parallel ?? 1;
      const totals = await test(config, testFile, parallel);
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
      if (opts.coverage) {
        const reportTargets = testFile.length > 0 ? testFile : ["."];
        await generateReport(config, reportTargets);
      }
      if (totals.failed > 0) {
        process.exit(1);
      }
    });

  testCmd
    .command("js")
    .description("Run JavaScript integration tests")
    .argument("[inputs...]", "Paths to test directories")
    .option(
      "-p, --parallel <number>",
      "Number of test dirs to run in parallel",
      parseInt,
    )
    .option("--coverage", "Enable coverage collection and report")
    .option("--accumulate", "Preserve existing coverage data (use with --coverage)")
    .action(async (testFile: string[], opts: { parallel?: number; coverage?: boolean; accumulate?: boolean }) => {
      const config = getConfig();
      if (opts.coverage) {
        process.env.AGENCY_COVERAGE = "1";
        process.env.AGENCY_COVERAGE_OUTDIR = path.resolve(config.coverage?.outDir ?? ".coverage");
        if (!opts.accumulate) {
          cleanCoverage(config);
        }
      }
      const parallel = opts.parallel ?? config.test?.parallel ?? 1;
      await testTs(config, testFile, parallel);
      if (opts.coverage) {
        const reportTargets = testFile.length > 0 ? testFile : ["."];
        await generateReport(config, reportTargets);
      }
    });

  testCmd
    .command("fixtures")
    .description("Generate test fixtures")
    .argument("[target]", "Target in file.agency:nodeName format")
    .action(async (target: string | undefined) => {
      await fixtures(getConfig(), target);
    });

  const coverageCmd = program
    .command("coverage")
    .description("View test coverage reports");

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
    .description(
      "Find the definition of the symbol at the given cursor position",
    )
    .requiredOption("--line <line>", "0-indexed line number of the cursor")
    .requiredOption(
      "--column <column>",
      "0-indexed column number of the cursor",
    )
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
      await forEachSource(inputs, (contents) => {
        try {
          _parseAgency(contents);
        } catch (error) {
          if (error instanceof TarsecError) {
            console.log(JSON.stringify(error.data, null, 2));
          } else {
            throw error;
          }
        }
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
      const runTypeCheck = (
        contents: string,
        filePath?: string,
        symbolTable?: SymbolTable,
      ) => {
        const parsedProgram = parse(contents, config);
        const absPath = filePath ? path.resolve(filePath) : undefined;
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
      const filePaths = sources
        .filter((s) => s.kind === "file")
        .map((s) => path.resolve(s.path));
      const symbolTable = filePaths.length
        ? SymbolTable.build(filePaths, config)
        : undefined;
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
      const output =
        options.output || path.join(parsed.dir, parsed.name + ".bundle");
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
    .option(
      "--ignore <dirs...>",
      "Directory names to ignore when scanning recursively",
    )
    .option("--lang <name>", "Code-fence language tag", "agency")
    .action(
      (
        input: string,
        opts: { output: string; ignore?: string[]; lang: string },
      ) => {
        const config = getConfig();
        generateLiterate(
          config,
          input,
          opts.output,
          opts.ignore || [],
          opts.lang,
        );
      },
    );

  const localCmd = program.command("local").description("Manage and run local models");
  localCmd.command("list").description("List downloaded models").action(localList);
  localCmd.command("download").description("Download a model (curated name, alias, or hf: URI)")
    .argument("<value>").action(localDownload);
  localCmd.command("remove").description("Delete a downloaded model").argument("<name>")
    .action(localRemove);
  localCmd.command("resolve").description("Show what a name/alias resolves to").argument("<value>")
    .action(localResolve);
  localCmd.command("refresh").description("Refresh the model catalog from the remote source")
    .argument("[url]", "Override the catalog URL (else env/config/default)").action(localRefresh);
  const aliasCmd = localCmd.command("alias").description("Manage model name aliases");
  aliasCmd.command("list").description("List usable short names (curated + aliases)").action(localAliasList);
  aliasCmd.command("add").description("Add a short-name alias").argument("<name>").argument("<uri>")
    .action(localAliasAdd);
  aliasCmd.command("remove").description("Remove a short-name alias").argument("<name>")
    .action(localAliasRemove);

  const modelsCmd = program.command("models").description("Browse the hosted model catalog");
  modelsCmd.command("list").description("List hosted models (filterable)")
    .argument("[files...]", "Model-data JSON files to also load and include (as printed by `agency models refresh`)")
    .option("--provider <name>", "Only this provider")
    .option("--max-price <usd>", "Max input $/1M tokens", parseFloat)
    .option("--min-context <tokens>", "Min context window", parseInt)
    .action((files: string[], opts: { provider?: string; maxPrice?: number; minContext?: number }) => modelsList(opts, files));
  modelsCmd.command("refresh").description("Fetch the latest model data and print it as JSON (redirect to a file, then load with std::llm.loadModelData)")
    .argument("[url]", "Optional URL to fetch model data from (defaults to the built-in source)").action((url?: string) => modelsRefresh(url));

  program
    .command("agent")
    .description("Launch the Agency language assistant agent (run `agency agent --help` for agent flags)")
    .argument("[args...]", "Arguments forwarded to the agent")
    .option(
      "--max-cost <dollars>",
      "Abort if the agent's LLM spend exceeds this many dollars (0 = local models only; negative = no limit)",
    )
    .option(
      "--max-time <duration>",
      "Abort if the agent's working time exceeds this duration (e.g. 30m or 2d); waiting on a human is not counted; zero/negative = no limit",
    )
    .helpOption(false)
    .action((args: string[], opts: { maxCost?: string; maxTime?: string }) => {
      const config = getConfig();
      let budget;
      try {
        budget = resolveBudget({ maxCost: opts.maxCost, maxTime: opts.maxTime });
      } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        process.exit(2);
      }
      agent(config, args, budget);
    });

  program
    .command("doctor")
    .description("Diagnose problems with an Agency file using the agency agent")
    .argument("<file>", "Path to the .agency file to diagnose")
    .option("--symptom <text>", "Optional description of the problem you are seeing")
    .option("--trace [file]", "Write an execution trace of the diagnosis to this file")
    .option("--log-file <path>", "Append statelog events from the diagnosis to this file")
    .action(
      (
        file: string,
        opts: { symptom?: string; trace?: string | boolean; logFile?: string },
      ) => {
        const config = getConfig();
        doctor(config, file, {
          symptom: opts.symptom,
          trace: opts.trace as string | true | undefined,
          logFile: opts.logFile,
        });
      },
    );

  const configCmd = program
    .command("config")
    .description("Inspect Agency configuration");

  configCmd
    .command("show")
    .description("Print the resolved, merged agency.json config as JSON")
    .option(
      "--show-secrets",
      "Print API keys verbatim instead of masking them (avoid in shared logs / bug reports)",
    )
    .action((opts: { showSecrets?: boolean }) => {
      const config = getConfig();
      console.log(
        JSON.stringify(
          opts.showSecrets ? config : redactConfigSecrets(config),
          null,
          2,
        ),
      );
    });

  program
    .command("review", { hidden: true })
    .description("Review an Agency file for type errors and code quality")
    .argument("<file>", "The .agency file to review")
    .action((file: string) => {
      const config = getConfig();
      review(config, file);
    });

  const scheduleCmd = program
    .command("schedule")
    .description("Manage scheduled agent runs");

  scheduleCmd
    .command("add")
    .description("Schedule an agent to run on a recurring basis")
    .argument("<file>", "Path to .agency file")
    .option(
      "--every <preset>",
      "Schedule preset: minute, hourly, daily, weekdays, weekends, weekly, monthly",
    )
    .option("--cron <expression>", "Cron expression (5 fields)")
    .option(
      "--name <name>",
      "Schedule name (default: derived from filename)",
    )
    .option("--env-file <path>", "Path to .env file")
    .option(
      "--backend <type>",
      "Force a non-default backend. Currently only 'github' is supported; local backends (launchd, systemd, crontab) are auto-detected.",
    )
    .option(
      "--secret <name>",
      "github backend: add a GitHub Actions secret to the workflow env (repeatable)",
      (value: string, prev: string[] = []) => [...prev, value],
      [] as string[],
    )
    .option(
      "--write",
      "github backend: grant contents: write + pull-requests: write permissions",
    )
    .option(
      "--no-pin",
      "github backend: emit @<tag> instead of @<sha> for action references",
    )
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
        },
      ) => {
        // Only `--backend github` is supported today; local backends are
        // auto-detected. Reject any other value with a clear error rather
        // than silently routing to auto-detect.
        if (opts.backend !== undefined && opts.backend !== "github") {
          console.error(
            color.red(
              `Unknown --backend value: "${opts.backend}". The only value accepted today is "github". Local backends (launchd, systemd, crontab) are auto-detected.`,
            ),
          );
          process.exit(1);
        }
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
          console.log(
            color.green(`Schedule "${name}" added successfully.`),
          );
        } catch (err: any) {
          if (err instanceof ScheduleExistsError && process.stdin.isTTY) {
            const confirmed = await promptScheduleOverwrite(err.scheduleName);
            if (confirmed) {
              try {
                scheduleAdd({ ...addOpts, force: true });
                console.log(
                  color.green("Schedule overwritten successfully."),
                );
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

  scheduleCmd
    .command("list")
    .alias("ls")
    .description("List all scheduled agents")
    .action(() => {
      console.log(formatListTable(scheduleList({})));
    });

  scheduleCmd
    .command("remove")
    .alias("rm")
    .description("Remove a scheduled agent")
    .argument("<name>", "Name of the schedule to remove")
    .action((name: string) => {
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
    .argument("<name>", "Name of the schedule to edit")
    .option(
      "--every <preset>",
      "Schedule preset: minute, hourly, daily, weekdays, weekends, weekly, monthly",
    )
    .option("--cron <expression>", "Cron expression (5 fields)")
    .option("--env-file <path>", "Path to .env file")
    .action(
      (
        name: string,
        opts: {
          every?: string;
          cron?: string;
          envFile?: string;
        },
      ) => {
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
    .description(
      "Verify cron functionality by scheduling a test agent that runs every minute",
    )
    .action(() => {
      try {
        const result = scheduleTest();
        console.log(
          color.green(`Schedule "${result.name}" added successfully.`),
        );
        console.log("");
        console.log(`Wrote test agent: ${result.agentFile}`);
        console.log(
          `It will run every minute and write the current time to:`,
        );
        console.log(`  ${result.outputFile}`);
        console.log("");
        console.log(
          "Wait at least one minute, then check that file. If it contains a",
        );
        console.log("recent timestamp, cron is working.");
        console.log("");
        console.log(
          "If the file is missing, check the run logs for errors:",
        );
        console.log(`  ${result.logDir}`);
        if (process.platform === "darwin") {
          console.log("");
          console.log(
            "On macOS, scheduled jobs may need Full Disk Access. If logs show",
          );
          console.log(
            "permission errors, grant access to /bin/bash in System Settings →",
          );
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
    .argument(
      "<targets...>",
      `One or more targets: ${SUPPORTED_AGENT_LSP_TARGETS.join(", ")}`,
    )
    .action((targets: string[]) => {
      let failed = false;
      for (const rawTarget of targets) {
        if (
          !SUPPORTED_AGENT_LSP_TARGETS.includes(rawTarget as AgentLspTarget)
        ) {
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

  const serveCmd = program
    .command("serve")
    .description("Serve Agency code over MCP or HTTP");

  serveCmd
    .command("mcp")
    .description("Start an MCP server (stdio by default; --transport http for Streamable HTTP)")
    .argument("<file>", "Agency file to serve")
    .option("--name <name>", "Server name (defaults to filename)")
    .option(
      "--transport <transport>",
      "Transport: 'stdio' (default) or 'http' (Streamable HTTP)",
    )
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

  addRunOptions(
    program
      .command("default", { isDefault: true, hidden: true })
      .argument("[file]"),
  ).action((file: string | undefined, options: RunOptions) => {
    if (!file) {
      program.help();
      return;
    }
    if (file.endsWith(".agency") || fs.existsSync(file)) {
      runWithOptions(file, options);
    } else {
      console.error(`Error: Unknown command '${file}'`);
      console.error("Run 'agency help' for usage information");
      process.exit(1);
    }
  });
  return program;
}

export async function runCli(
  argv: string[] = process.argv,
  deps: CliDependencies = {},
): Promise<void> {
  loadEnv();
  const program = createProgram(deps);
  await program.parseAsync(injectAgentSeparator(argv));
}

// `agency agent` forwards every remaining argv token to the agent program
// (which has its own std::args-based flag parser). Insert `--` right after
// `agent` so commander does not try to interpret the user's agent flags
// (e.g. `agency agent --foo bar` becomes `agency agent -- --foo bar`).
// No-op when the user already wrote `--`, or when `agent` is not the
// subcommand being invoked.
export function injectAgentSeparator(argv: string[]): string[] {
  const subcommandIdx = findSubcommandIndex(argv);
  if (subcommandIdx === -1) return argv;
  if (argv[subcommandIdx] !== "agent") return argv;
  if (argv[subcommandIdx + 1] === "--") return argv;
  return [
    ...argv.slice(0, subcommandIdx + 1),
    "--",
    ...argv.slice(subcommandIdx + 1),
  ];
}

// Walk past `node`, the script path, and any leading top-level options
// (-v/--verbose, -c/--config <path>) to find the index of the subcommand
// token. Returns -1 if no subcommand is present.
const TOP_LEVEL_BOOLEAN_FLAGS = ["-v", "--verbose"];
const TOP_LEVEL_VALUE_FLAGS = ["-c", "--config"];

function findSubcommandIndex(argv: string[]): number {
  // argv[0] = node, argv[1] = script path. Subcommand search starts at 2.
  let i = 2;
  while (i < argv.length) {
    const token = argv[i];
    if (TOP_LEVEL_BOOLEAN_FLAGS.includes(token)) {
      i += 1;
      continue;
    }
    if (TOP_LEVEL_VALUE_FLAGS.includes(token)) {
      i += 2;
      continue;
    }
    if (token.startsWith("--config=") || token.startsWith("--verbose=")) {
      i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;

if (isMain) {
  await runCli();
} else {
  console.warn(
    "Not executing Agency CLI because it was imported as a module.",
  );
}
