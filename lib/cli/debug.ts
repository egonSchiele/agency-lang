import { AgencyConfig } from "@/config.js";
import { compile } from "./commands.js";
import { pickANode } from "./util.js";
import { parseAgency } from "@/parser.js";
import { getNodesOfType } from "@/utils/node.js";
import { GraphNodeDefinition } from "@/types.js";
import { DebuggerDriver } from "@/debugger/driver.js";
import { DebuggerUI } from "@/debugger/ui.js";
import { TraceReader } from "@/runtime/trace/traceReader.js";
import { Checkpoint } from "@/runtime/state/checkpointStore.js";
import { createDebugInterrupt } from "@/runtime/interrupts.js";
import * as fs from "fs";
import * as path from "path";

export async function debug(
  config: AgencyConfig,
  inputFile: string,
  options: {
    node?: string;
    rewindSize?: number;
    trace?: string;
    checkpoint?: string;
  } = {},
): Promise<void> {
  let traceCheckpoints: Checkpoint[] | undefined;
  if (options.trace) {
    if (!fs.existsSync(options.trace)) {
      console.error(`Error: Trace file not found: ${options.trace}`);
      process.exit(1);
    }
    const reader = TraceReader.fromFile(options.trace);
    if (reader.checkpoints.length === 0) {
      console.error("Error: Trace file has no checkpoints.");
      process.exit(1);
    }
    traceCheckpoints = reader.checkpoints;
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
  // Force debugger mode so the builder emits debugStep() calls
  const debugConfig: AgencyConfig = { ...config, debugger: true };

  // Compile the .agency file to .js
  const outputFile = compile(debugConfig, inputFile);
  if (outputFile === null) {
    console.error("Error: No output file generated.");
    process.exit(1);
  }

  // Dynamically import the compiled module
  const absOutput = path.resolve(outputFile);
  const mod = await import(absOutput);

  // Get the source map from the module
  const sourceMap = mod.__sourceMap ?? {};

  // Parse the .agency file to get the list of graph nodes
  const contents = fs.readFileSync(inputFile, "utf-8");
  const parseResult = parseAgency(contents, debugConfig);
  if (!parseResult.success) {
    console.error("Error: Could not parse Agency file.");
    process.exit(1);
  }
  const nodes = getNodesOfType(
    parseResult.result.nodes,
    "graphNode",
  ) as GraphNodeDefinition[];

  if (nodes.length === 0) {
    console.error("Error: No graph nodes found in the Agency file.");
    process.exit(1);
  }

  // Determine which node to debug
  let nodeName = options.node;
  if (!nodeName) {
    nodeName = await pickANode(nodes);
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
      approveInterrupt: mod.approveInterrupt,
      respondToInterrupt: mod.respondToInterrupt,
      rewindFrom: mod.rewindFrom,
      __setDebugger: mod.__setDebugger,
      __getCheckpoints: mod.__getCheckpoints,
    },
    sourceMap,
    rewindSize,
    ui: new DebuggerUI(),
    checkpoints: traceCheckpoints,
  });

  // Set the debugger state on the RuntimeContext via the module wrapper
  mod.__setDebugger(driver.debuggerState);

  // Set up callbacks from the driver
  const callbacks = driver.getCallbacks();

  // Find the selected node's definition to get parameter info
  const selectedNode = nodes.find(
    (n: GraphNodeDefinition) => n.nodeName === nodeName,
  )!;

  // Prompt for node arguments if the node has parameters
  let args: unknown[] = [];
  if (selectedNode.parameters.length > 0) {
    args = await driver.promptForNodeArgs(selectedNode.parameters);
  }

  if (traceCheckpoints) {
    // Trace mode: start at the last checkpoint as if the program just finished
    const lastCp = traceCheckpoints[traceCheckpoints.length - 1];
    const interrupt = createDebugInterrupt(undefined, lastCp.id, lastCp);
    await driver.run({ data: interrupt });
  } else {
    // Normal mode: run the node, it will pause at the first debugStep()
    const initialResult = await nodeFunction(...args, { callbacks });
    await driver.run(initialResult);
  }
}
