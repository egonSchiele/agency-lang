#!/usr/bin/env node
import {
  compile,
  format,
  formatFile,
  loadConfig,
  parse,
  readFile,
  readStdin,
  run,
} from "@/cli/commands.js";
import { evaluate } from "@/cli/evaluate.js";
import { fixtures, test, testTs, SlowTest } from "@/cli/test.js";
import { createBundle, extractBundle } from "@/cli/bundle.js";
import { traceLog } from "@/cli/events.js";
import { AgencyConfig } from "@/config.js";
import * as path from "path";
import { _parseAgency } from "@/parser.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { collectProgramInfo } from "@/programInfo.js";
import { formatErrors, typeCheck } from "@/typeChecker/index.js";
import { Command } from "commander";
import * as fs from "fs";
import { color } from "@/utils/termcolors.js";
import { TarsecError } from "tarsec";
import process from "process";
import { agent } from "@/cli/agent.js";
import { loadEnv } from "@/utils/envfile.js";
import { debug } from "@/cli/debug.js";
import { generateDoc } from "@/cli/doc.js";
import { optimize } from "@/cli/optimize.js";
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

type RunOptions = { resume?: string; trace?: string | true };

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
    const config = getConfig();
    if (options.trace) {
      config.trace = true;
      config.traceFile =
        typeof options.trace === "string"
          ? options.trace
          : input.replace(/\.agency$/, ".trace");
    }
    run(config, input, undefined, options.resume);
  }

  program
    .command("compile")
    .alias("build")
    .description("Compile .agency file(s) or directory(s) to JavaScript")
    .argument("<inputs...>", "Paths to .agency input files or directories")
    .option("--ts", "Output .ts files with // @no-check header")
    .option("-w, --watch", "Watch for changes and recompile")
    .action(
      async (inputs: string[], opts: { ts?: boolean; watch?: boolean }) => {
        const config = getConfig();
        if (opts.watch) {
          const close = await watchAndCompile(config, inputs, { ts: opts.ts });
          process.once("SIGINT", async () => {
            await close();
            process.exit(0);
          });
        } else {
          for (const input of inputs) {
            compile(config, input, undefined, { ts: opts.ts });
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
      if (inputs.length === 0) {
        const contents = await readStdin();
        const result = parse(contents, config);
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const input of inputs) {
          const contents = readFile(input);
          const result = parse(contents, config);
          console.log(JSON.stringify(result, null, 2));
        }
      }
    });

  program
    .command("preprocess")
    .description(
      "Parse .agency file(s) and show AST after preprocessing (reads from stdin if no input)",
    )
    .argument("[inputs...]", "Paths to .agency input files")
    .action(async (inputs: string[]) => {
      const config = getConfig();

      const processInput = (contents: string) => {
        const parsedProgram = parse(contents, config);
        const info = collectProgramInfo(parsedProgram);
        const preprocessor = new TypescriptPreprocessor(
          parsedProgram,
          config,
          info,
        );
        preprocessor.preprocess();
        console.log(JSON.stringify(preprocessor.program, null, 2));
      };

      if (inputs.length === 0) {
        const contents = await readStdin();
        processInput(contents);
      } else {
        for (const input of inputs) {
          const contents = readFile(input);
          processInput(contents);
        }
      }
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
    .description("Run tests (default), or use subcommands: js, fixtures, eval");

  testCmd
    .command("run", { isDefault: true })
    .description("Run Agency test files")
    .argument("[inputs...]", "Paths to .test.json files or directories")
    .option(
      "-p, --parallel <number>",
      "Number of test files to run in parallel",
      parseInt,
    )
    .action(async (testFile: string[], opts: { parallel?: number }) => {
      const config = getConfig();
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
    .action(async (testFile: string[], opts: { parallel?: number }) => {
      const config = getConfig();
      const parallel = opts.parallel ?? config.test?.parallel ?? 1;
      await testTs(config, testFile, parallel);
    });

  testCmd
    .command("fixtures")
    .description("Generate test fixtures")
    .argument("[target]", "Target in file.agency:nodeName format")
    .action(async (target: string | undefined) => {
      await fixtures(getConfig(), target);
    });

  testCmd
    .command("eval")
    .description("Run evaluation")
    .argument("[target]", "Target in file.agency:nodeName format")
    .option("--args <path>", "Path to eval args JSON file")
    .option("--results <path>", "Path to existing results file (to resume)")
    .action(
      async (
        target: string | undefined,
        opts: { args?: string; results?: string },
      ) => {
        await evaluate(getConfig(), target, opts.args, opts.results);
      },
    );

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
      if (inputs.length === 0) {
        const contents = await readStdin();
        try {
          _parseAgency(contents);
        } catch (error) {
          if (error instanceof TarsecError) {
            console.log(JSON.stringify(error.data, null, 2));
          } else {
            throw error;
          }
        }
      } else {
        for (const input of inputs) {
          const contents = readFile(input);
          try {
            _parseAgency(contents);
          } catch (error) {
            if (error instanceof TarsecError) {
              console.log(JSON.stringify(error.data, null, 2));
            } else {
              throw error;
            }
          }
        }
      }
    });

  program
    .command("typecheck")
    .alias("tc")
    .description("Type check .agency file(s) (reads from stdin if no input)")
    .argument("[inputs...]", "Paths to .agency input files")
    .option("--strict", "Enable strict types (untyped variables are errors)")
    .action(async (inputs: string[], opts: { strict?: boolean }) => {
      const config = getConfig();
      let hasErrors = false;
      const runTypeCheck = (contents: string) => {
        const parsedProgram = parse(contents, config);
        const info = collectProgramInfo(parsedProgram);
        const { errors } = typeCheck(parsedProgram, config, info);
        if (errors.length > 0) {
          console.error(formatErrors(errors));
          hasErrors = true;
        } else {
          console.log("No type errors found.");
        }
      };
      if (opts.strict) config.strictTypes = true;
      if (inputs.length === 0) {
        const contents = await readStdin();
        runTypeCheck(contents);
      } else {
        for (const input of inputs) {
          const contents = readFile(input);
          runTypeCheck(contents);
        }
      }
      if (hasErrors) process.exit(1);
    });

  program
    .command("debug")
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

  program
    .command("optimize")
    .description("Optimize prompts and parameters using iterative feedback")
    .argument("<target>", "Target node (e.g., file.agency:nodeName)")
    .option("--iterations <n>", "Maximum iterations", parseInt)
    .action(async (target: string, opts: any) => {
      const config = getConfig();
      const optimizeOpts: Record<string, any> = {};
      if (opts.iterations !== undefined)
        optimizeOpts.iterations = opts.iterations;
      await optimize(config, target, optimizeOpts);
    });

  program
    .command("agent")
    .description("Launch the Agency language assistant agent")
    .action(() => {
      const config = getConfig();
      agent(config);
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
  await program.parseAsync(argv);
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
