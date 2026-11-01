/**
 * The driver: the small Agency program each `agency workflow` command
 * writes and runs. Every `std::workflow` function takes the tools as
 * function values, and the CLI is TypeScript, which cannot import a
 * person's `.agency` file. So the driver imports the tools and calls
 * `std::workflow`, and the command runs one of its nodes.
 *
 * `wfRunNode` has no handler around `wfRun`: the run's policy, passed as a
 * root carrier, decides each of its interrupts.
 *
 * Every node returns a `Result`. `readDriverResult` depends on that: it reads
 * a bare list as interrupts that nothing answered.
 *
 * The text is fixed. Only the import lines and the tool list are written
 * into it. Every value reaches it as a node argument, so nothing a person
 * typed lands in its source.
 */
import path from "path";
import { importLine } from "../../stdlib/workflow/lower.js";
import type { ToolImport } from "./toolImports.js";

const DRIVER = `import { catalog as wfCatalog, loadWorkflow as wfLoad, checkWorkflow as wfCheck, compileWorkflow as wfCompile, listWorkflows as wfList, runWorkflow as wfRun } from "std::workflow"
{{imports}}

const wfTools = [{{tools}}]

node wfToolsNode(dir: string) {
  const wfResult = wfCatalog(wfTools, dir) with approve
  return wfResult
}

node wfCheckNode(name: string, dir: string) {
  const wfEntry = wfLoad(name, dir) with approve
  if (wfEntry is failure) {
    return wfEntry
  }
  const wfResult = wfCheck(wfEntry.value.workflow, wfTools, dir) with approve
  return wfResult
}

node wfCompileNode(name: string, dir: string) {
  const wfEntry = wfLoad(name, dir) with approve
  if (wfEntry is failure) {
    return wfEntry
  }
  const wfResult = wfCompile(wfEntry.value.workflow, wfTools, dir) with approve
  return wfResult
}

node wfListNode(dir: string) {
  const wfResult = wfList(dir) with approve
  return wfResult
}

node wfRunNode(name: string, dir: string, inputs: any) {
  const wfEntry = wfLoad(name, dir) with approve
  if (wfEntry is failure) {
    return wfEntry
  }
  const wfResult = wfRun(wfEntry.value.workflow, inputs, wfTools, dir)
  return wfResult
}
`;

/** The driver's node for each command, so a command names its node by kind. */
export const DRIVER_NODES = {
  tools: "wfToolsNode",
  check: "wfCheckNode",
  compile: "wfCompileNode",
  list: "wfListNode",
  run: "wfRunNode",
} as const;

/** Every name the driver binds. A tool with one of these names would clash.
 *  Written beside the text, as `PROGRAM_NAMES` is beside the generator's
 *  scaffold; a test checks the two agree. */
export const DRIVER_NAMES = [
  "wfCatalog",
  "wfLoad",
  "wfCheck",
  "wfCompile",
  "wfList",
  "wfRun",
  "wfTools",
  "wfToolsNode",
  "wfCheckNode",
  "wfCompileNode",
  "wfListNode",
  "wfRunNode",
  "wfEntry",
  "wfResult",
];

const TOKEN = /\{\{(imports|tools)\}\}/g;

/** The import path from the driver's folder to a local module. */
function importPath(module: string, projectDir: string, driverDir: string): string {
  if (module.startsWith("std::")) {
    return module;
  }
  const relative = path.relative(driverDir, path.resolve(projectDir, module));
  return relative.split(path.sep).join("/");
}

/** The driver's text, with each local module's path made relative to the
 *  folder the driver is written to. */
export function driverSource(imports: ToolImport[], projectDir: string, driverDir: string): string {
  const values: Record<string, string> = {
    imports: imports
      .map((entry) =>
        importLine({ module: importPath(entry.module, projectDir, driverDir), names: entry.names }),
      )
      .join("\n"),
    tools: imports.flatMap((entry) => entry.names).join(", "),
  };
  // A function replacer, so a `$` in a path is never replacement syntax.
  return DRIVER.replace(TOKEN, (_match, token: string) => values[token]);
}
