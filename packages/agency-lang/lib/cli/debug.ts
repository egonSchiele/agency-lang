import { AgencyConfig } from "@/config/config.js";
import { compile } from "@/compiler/defaultSession.js";
import { RunStrategy } from "../importStrategy.js";
import { pickANode, resolveCompiledFile } from "./util.js";
import { parseAgency } from "@/parser.js";
import { getNodesOfType } from "@/utils/node.js";
import { GraphNodeDefinition } from "@/types.js";
import { DebuggerDriver } from "@/debugger/driver.js";
import { DebuggerUI } from "@/debugger/ui.js";
import { Screen, TerminalInput, TerminalOutput } from "@/tui/index.js";
import { TraceReader } from "@/runtime/trace/traceReader.js";
import type { TraceHeader } from "@/runtime/trace/types.js";
import { Checkpoint } from "@/runtime/state/checkpointStore.js";
import { createDebugInterrupt } from "@/runtime/interrupts.js";
import type { InvocationOptions } from "@/runtime/invocationOptions.js";
import { compileChoice } from "./debugFlags.js";
import { compileAgencyOnly } from "@/compiler/compileSandboxed.js";
import { safeDeleteDirectoryWithin } from "@/utils.js";
import * as fs from "fs";
import * as path from "path";

// eslint-disable-next-line max-lines-per-function -- legacy CLI entrypoint slated for incremental refactor
export async function debug(
  config: AgencyConfig,
  _inputFile: string,
  options: {
    node?: string;
    rewindSize?: number;
    trace?: string;
    checkpoint?: string;
    distDir?: string;
    /** `--agency-only`: refuse anything in the import closure that is not
     *  Agency source. The compile refusal is the same as `run`'s; the Node
     *  process flag `run` adds to its child cannot apply here, since the
     *  debugger runs the program in its own process. */
    agencyOnly?: boolean;
    /** The policy and budget from the run flags, passed on the node call
     *  and on every resume and rewind the driver makes, since a resume
     *  installs the root policy and budget again. */
    invocation?: InvocationOptions;
  } = {},
): Promise<void> {
  let inputFile = _inputFile;
  let tempDir: string | null = null;
  let traceCheckpoints: Checkpoint[] | undefined;
  let traceHeader: TraceHeader | undefined;
  // Load a trace or bundle file. If it's a bundle (header.bundle === true),
  // extract source files to a temp dir and point inputFile there.
  function loadTraceOrBundle(filePath: string): void {
    const reader = TraceReader.fromFile(filePath);
    if (reader.checkpoints.length === 0) {
      console.error("Error: File has no checkpoints.");
      process.exit(1);
    }
    traceCheckpoints = reader.checkpoints;
    traceHeader = reader.header;
    if (reader.header.bundle) {
      if (Object.keys(reader.sources).length === 0) {
        console.error("Error: Bundle has no source files.");
        process.exit(1);
      }
      const programPath = reader.header.program;
      if (!programPath || path.isAbsolute(programPath)) {
        console.error("Error: Bundle has invalid program path.");
        process.exit(1);
      }
      // A directory this run created: two sessions started in the same
      // second must not share one, since the first to quit removes it.
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const bundleRoot = path.resolve(".tmp/bundle");
      fs.mkdirSync(bundleRoot, { recursive: true });
      tempDir = fs.mkdtempSync(path.join(bundleRoot, `${timestamp}-`));
      // On the exit event rather than in a finally: Ctrl-C and the error
      // paths below call process.exit, which skips a finally. Before the
      // debugger screen is up, Ctrl-C is a plain SIGINT, which would end
      // the process without the exit event, so it is turned into an exit.
      const extracted = tempDir;
      process.on("exit", () => safeDeleteDirectoryWithin(bundleRoot, extracted));
      process.on("SIGINT", () => process.exit(130));
      reader.writeSourcesToDisk(tempDir);
      console.log(`Bundle extracted to: ${tempDir} (removed on exit)`);
      const resolvedTempDir = path.resolve(tempDir);
      const resolvedProgram = path.resolve(resolvedTempDir, programPath);
      if (!resolvedProgram.startsWith(resolvedTempDir + path.sep)) {
        console.error("Error: Bundle program path escapes bundle directory.");
        process.exit(1);
      }
      inputFile = resolvedProgram;
    }
  }

  // Auto-detect: if input file is not .agency, try loading as trace/bundle
  if (!inputFile.endsWith(".agency")) {
    loadTraceOrBundle(inputFile);
    // If it wasn't a bundle (no source extracted), we can't compile a .trace file
    if (!tempDir) {
      console.error(
        "Error: Trace files require a source file. Use: agency debug source.agency --trace file.trace",
      );
      process.exit(1);
    }
  }

  if (options.trace) {
    loadTraceOrBundle(options.trace);
  }

  if (options.checkpoint) {
    if (!fs.existsSync(options.checkpoint)) {
      console.error(`Error: Checkpoint file not found: ${options.checkpoint}`);
      process.exit(1);
    }
    const json = JSON.parse(fs.readFileSync(options.checkpoint, "utf-8"));
    const cp = Checkpoint.fromJSON(json);
    if (!cp) {
      console.error("Error: Invalid checkpoint file.");
      process.exit(1);
    }
    traceCheckpoints = [cp];
  }
  let absOutput: string;

  const choice = compileChoice({
    agencyOnly: options.agencyOnly,
    distDir: options.distDir,
    configDistDir: config.distDir,
  });
  if ("refused" in choice) {
    console.error(`Error: ${choice.refused}`);
    process.exit(1);
  }
  if (choice.mode === "agency-only") {
    const compiled = compileAgencyOnly(inputFile);
    if (!compiled.ok) {
      console.error("Error: agency-only compile refused:");
      for (const error of compiled.errors) console.error(`  ${error}`);
      process.exit(1);
    }
    absOutput = path.resolve(compiled.scriptPath);
  } else if (choice.mode === "dist-dir") {
    // distDir mode: import pre-compiled JS from the dist directory
    const distDir = choice.distDir;
    let compiledPath: string;
    try {
      compiledPath = resolveCompiledFile(distDir, inputFile);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    // Warn if source is newer than compiled output
    const sourceMtime = fs.statSync(inputFile).mtimeMs;
    const compiledMtime = fs.statSync(compiledPath).mtimeMs;
    if (sourceMtime > compiledMtime) {
      console.warn(
        `Warning: ${inputFile} is newer than ${compiledPath}.\n` +
          `You may need to recompile before debugging.`,
      );
    }

    absOutput = compiledPath;
  } else {
    // Normal mode: compile the .agency file to .js on the fly. The
    // debugger stops at debugStep() calls, so instrumentation is forced
    // on, whatever the project's agency.json says.
    const outputFile = compile({ ...config, instrument: true }, inputFile, undefined, {
      importStrategy: new RunStrategy(),
    });
    if (outputFile === null) {
      console.error("Error: No output file generated.");
      process.exit(1);
    }
    absOutput = path.resolve(outputFile);
  }

  // Signal to stdlib UI components that they should fall back to console.log
  // instead of drawing their own TUI, which would conflict with the debugger.
  process.env.AGENCY_DEBUGGER = "1";

  // Dynamically import the compiled module
  // eslint-disable-next-line no-restricted-syntax -- compiled output path is only known at runtime
  const mod = await import(absOutput);

  // Get the source map from the module
  const sourceMap = mod.__sourceMap ?? {};

  if (choice.mode === "dist-dir" && Object.keys(sourceMap).length === 0) {
    console.warn(
      "Warning: The compiled module has an empty source map. Was it compiled with instrument: false?\n" +
        "The debugger may not be able to step through code.",
    );
  }

  // Parse the .agency file to get the list of graph nodes
  const contents = fs.readFileSync(inputFile, "utf-8");
  const parseResult = parseAgency(contents, config);
  if (!parseResult.success) {
    console.error("Error: Could not parse Agency file.");
    process.exit(1);
  }
  const nodes = getNodesOfType(parseResult.result.nodes, "graphNode") as GraphNodeDefinition[];

  if (nodes.length === 0) {
    console.error("Error: No graph nodes found in the Agency file.");
    process.exit(1);
  }

  // Determine which node to debug
  let nodeName = options.node;
  if (!nodeName) {
    if (traceCheckpoints) {
      // Use the node from the trace's first checkpoint
      nodeName = traceCheckpoints[0].nodeId;
    } else {
      nodeName = await pickANode(nodes);
    }
  }

  // Look up the exported node function from the compiled module
  const nodeFunction = mod[nodeName];
  if (typeof nodeFunction !== "function") {
    console.error(
      `Error: Node '${nodeName}' not found as an exported function in the compiled module.`,
    );
    process.exit(1);
  }

  // Create the DebuggerDriver using the module's exported wrapper functions
  const defaultRewindSize = options.rewindSize ?? 30;
  const rewindSize = traceCheckpoints
    ? Math.max(defaultRewindSize, traceCheckpoints.length)
    : defaultRewindSize;
  const driver = new DebuggerDriver({
    mod: {
      respondToInterrupts: mod.respondToInterrupts,
      rewindFrom: mod.rewindFrom,
      __setDebugger: mod.__setDebugger,
      __getCheckpoints: mod.__getCheckpoints,
    },
    rewindSize,
    ui: (() => {
      // Remove any existing keypress data handlers on stdin left behind by
      // readline/prompts, which would conflict with TerminalInput's raw mode.
      process.stdin.removeAllListeners("data");
      delete (process.stdin as any)[Symbol.for("nodejs.readline.KEYPRESS_DECODER")];
      return new DebuggerUI(
        new Screen({
          input: new TerminalInput(),
          output: new TerminalOutput(),
          width: process.stdout.columns || 80,
          height: process.stdout.rows || 24,
        }),
      );
    })(),
    checkpoints: traceCheckpoints,
    traceHeader,
    invocation: options.invocation,
  });

  // Set the debugger state on the RuntimeContext via the module wrapper
  mod.__setDebugger(driver.debuggerState);

  // Set up callbacks from the driver
  const callbacks = driver.getCallbacks();

  // Find the selected node's definition to get parameter info
  const selectedNode = nodes.find((n: GraphNodeDefinition) => n.nodeName === nodeName)!;

  // Prompt for node arguments if the node has parameters
  let args: unknown[] = [];
  if (selectedNode.parameters.length > 0) {
    args = await driver.promptForNodeArgs(selectedNode.parameters);
  }

  if (traceCheckpoints) {
    if (!traceHeader) {
      console.error("Error: Trace checkpoints found but no header information.");
      process.exit(1);
    }

    if (!traceHeader.runId) {
      console.error("Error: Trace header missing runId.");
      process.exit(1);
    }

    // Trace mode: start at the last checkpoint as if the program just finished
    const lastCp = traceCheckpoints[traceCheckpoints.length - 1];
    const interrupt = createDebugInterrupt(undefined, lastCp.id, lastCp, traceHeader.runId);
    await driver.run({ data: interrupt });
  } else {
    // Normal mode: run the node, it will pause at the first debugStep()
    // The generated node function takes its options flat (`policy`,
    // `config`, `host`, ...), so the invocation is spread; under an
    // `invocation:` key it would be dropped without an error.
    const initialResult = await nodeFunction(...args, { callbacks, ...options.invocation });
    await driver.run(initialResult);
  }
}
