import { AgencyConfig } from "@/config.js";
import { compile } from "./commands.js";
import { pickANode } from "./util.js";
import { parseAgency } from "@/parser.js";
import { getNodesOfType } from "@/utils/node.js";
import { GraphNodeDefinition } from "@/types.js";
import { DebuggerDriver } from "@/debugger/driver.js";
import { DebuggerUI } from "@/debugger/ui.js";
import * as fs from "fs";
import * as path from "path";

export async function debug(
  config: AgencyConfig,
  inputFile: string,
  options: {
    node?: string;
    rewindSize?: number;
  } = {},
): Promise<void> {
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
  const rewindSize = options.rewindSize ?? 30;
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

  // Run the node — with debugger mode enabled, it will pause at the first
  // debugStep() and return an interrupt immediately
  const initialResult = await nodeFunction(...args, { callbacks });

  // Hand off to the debugger loop
  await driver.run(initialResult);
}
