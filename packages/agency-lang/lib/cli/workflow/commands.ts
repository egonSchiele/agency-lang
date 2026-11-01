/**
 * `agency workflow tools`, `check`, `compile`, and `list`. Each command
 * returns its exit code: 0 when it did what it was asked, 1 when the
 * workflow has problems or `std::workflow` refused, and 2 when the command
 * line is wrong. Everything they print goes through `io`, so the tests
 * pass a fake.
 */
import fs from "fs";
import path from "path";
import type { AgencyConfig } from "../../config/config.js";
import type { Policy } from "../../runtime/policy.js";
import { prepareContainedPath } from "../../stdlib/prepareContainedPath.js";
import type { CatalogEntry } from "../../stdlib/workflow/catalog.js";
import { stepEffects } from "../../stdlib/workflow/effects.js";
import { parseWorkflow } from "../../stdlib/workflow/parse.js";
import { isObject, type Problem, type Workflow } from "../../stdlib/workflow/types.js";
import { stripControlCharacters } from "../../utils/controlCharacters.js";
import { DRIVER_NODES } from "./driver.js";
import { locateWorkflow, type WorkflowFile } from "./locate.js";
import {
  formatCatalog,
  formatChecked,
  formatList,
  formatProblems,
  formatRunValue,
  formatUncovered,
  NO_TERMINAL,
  type ListedWorkflow,
} from "./output.js";
import { runPolicy, startRules, uncoveredEffects, type StartPrompts } from "./runPolicy.js";
import type { DriverCall, DriverOutcome } from "./runDriver.js";
import { importsForSources, importsForSteps, type ImportPlan } from "./toolImports.js";

export type WorkflowIo = {
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
  config: AgencyConfig;
  runDriver: (call: DriverCall) => Promise<DriverOutcome>;
  /** Asks a yes-or-no question, or null when there is no terminal to ask in. */
  confirm: ((question: string) => Promise<boolean>) | null;
};

export type PreparedWorkflow = {
  found: WorkflowFile;
  /** The file's `workflow`, after `parseWorkflow`. */
  workflow: Workflow;
  plan: ImportPlan;
  /** How the file is named in messages: its path from the working directory. */
  label: string;
};

/** Find, read, parse, and plan the imports for a workflow. Prints what is
 *  wrong and returns the exit code instead when a step fails:
 *  2 for locateWorkflow, 1 for a file that does not parse as JSON, for
 *  parseWorkflow's problems, and for the import plan's problems. */
export function prepareWorkflow(
  target: string,
  io: WorkflowIo,
): PreparedWorkflow | { exitCode: number } {
  const located = locateWorkflow(target, io.cwd);
  if (located.found === null) {
    io.err(stripControlCharacters(located.error));
    return { exitCode: 2 };
  }
  const found = located.found;
  const label = path.relative(io.cwd, found.file) || found.file;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(found.file, "utf-8"));
  } catch (error) {
    io.err(stripControlCharacters(`${label} is not valid JSON: ${(error as Error).message}`));
    return { exitCode: 1 };
  }
  const parsed = parseWorkflow(isObject(raw) ? raw.workflow : undefined);
  if (parsed.workflow === null) {
    io.err(formatProblems(label, parsed.problems));
    return { exitCode: 1 };
  }
  const plan = importsForSteps(parsed.workflow, found.dir);
  if (plan.problems.length > 0) {
    io.err(formatProblems(label, plan.problems));
    return { exitCode: 1 };
  }
  return { found, workflow: parsed.workflow, plan, label };
}

export type DriverResult =
  | { kind: "value"; value: unknown }
  | { kind: "problems"; problems: Problem[] }
  | { kind: "failed"; message: string; step: string | null }
  /** The value was a list of interrupts nothing answered. */
  | { kind: "unanswered"; effects: string[] };

/** A serialized `Result` (`lib/runtime/result.ts`). */
function isResult(value: unknown): value is Record<string, unknown> {
  return isObject(value) && value.__type === "resultType";
}

/** What a driver node's outcome means. `{ ok: false }` from runDriver is
 *  `failed`, with its message. */
export function readDriverResult(outcome: DriverOutcome): DriverResult {
  if (!outcome.ok) {
    return { kind: "failed", message: outcome.message, step: null };
  }
  const data = outcome.data;
  if (Array.isArray(data)) {
    const effects = data.map((item) => (isObject(item) ? String(item.effect) : "unknown"));
    return { kind: "unanswered", effects };
  }
  if (!isResult(data)) {
    return { kind: "value", value: data };
  }
  if (data.success === true) {
    return { kind: "value", value: data.value };
  }
  const details = isObject(data.data) ? data.data : {};
  if (Array.isArray(details.problems)) {
    return { kind: "problems", problems: details.problems as Problem[] };
  }
  const step = typeof details.step === "string" ? details.step : null;
  return { kind: "failed", message: String(data.error), step };
}

/** One line for a prompt nobody answered. */
function unansweredMessage(effects: string[]): string {
  return `stopped at a prompt nobody answered: ${effects.join(", ")}`;
}

/** The `--json` form every command prints: `{ success: true, value }`, or
 *  `{ success: false, error, step }` with the problems when there are some.
 *  One shape, so a script reads every command the same way. */
export function resultJson(result: DriverResult, label: string): string {
  const body = ((): Record<string, unknown> => {
    switch (result.kind) {
      case "value":
        return { success: true, value: result.value };
      case "failed":
        return { success: false, error: result.message, step: result.step };
      case "problems":
        return {
          success: false,
          error: formatProblems(label, result.problems),
          step: null,
          problems: result.problems,
        };
      case "unanswered":
        return { success: false, error: unansweredMessage(result.effects), step: null };
    }
  })();
  return JSON.stringify(body, null, 2);
}

/** Prints a result that is not a value, and returns exit code 1. Each
 *  command prints a value its own way. */
function report(
  result: Exclude<DriverResult, { kind: "value" }>,
  label: string,
  json: boolean,
  io: WorkflowIo,
): number {
  if (json) {
    io.out(resultJson(result, label));
    return 1;
  }
  if (result.kind === "problems") {
    io.err(formatProblems(label, result.problems));
  } else if (result.kind === "failed") {
    io.err(stripControlCharacters(result.message));
  } else {
    io.err(stripControlCharacters(unansweredMessage(result.effects)));
  }
  return 1;
}

async function runPrepared(
  prepared: PreparedWorkflow,
  node: string,
  io: WorkflowIo,
): Promise<DriverResult> {
  const { found, plan } = prepared;
  const outcome = await io.runDriver({
    dir: found.dir,
    imports: plan.imports,
    node,
    args: [found.name, found.dir],
    config: io.config,
  });
  return readDriverResult(outcome);
}

export async function workflowCheck(
  target: string,
  options: { json?: boolean },
  io: WorkflowIo,
): Promise<number> {
  const prepared = prepareWorkflow(target, io);
  if ("exitCode" in prepared) {
    return prepared.exitCode;
  }
  const result = await runPrepared(prepared, DRIVER_NODES.check, io);
  if (result.kind !== "value") {
    return report(result, prepared.label, options.json ?? false, io);
  }
  if (options.json) {
    io.out(resultJson(result, prepared.label));
    return 0;
  }
  const warnings = Array.isArray(result.value) ? (result.value as Problem[]) : [];
  const steps = stepEffects(prepared.workflow, prepared.plan.signatures);
  io.out(formatChecked(prepared.label, warnings, steps));
  return 0;
}

export async function workflowCompile(target: string, io: WorkflowIo): Promise<number> {
  const prepared = prepareWorkflow(target, io);
  if ("exitCode" in prepared) {
    return prepared.exitCode;
  }
  const result = await runPrepared(prepared, DRIVER_NODES.compile, io);
  if (result.kind !== "value") {
    return report(result, prepared.label, false, io);
  }
  io.out(stripControlCharacters(String(result.value)));
  return 0;
}

export async function workflowTools(
  sources: string[],
  options: { dir?: string; json?: boolean },
  io: WorkflowIo,
): Promise<number> {
  const dir = path.resolve(io.cwd, options.dir ?? ".");
  const plan = importsForSources(sources, dir, io.cwd);
  if ("error" in plan) {
    io.err(stripControlCharacters(plan.error));
    return 2;
  }
  if (plan.problems.length > 0) {
    io.err(formatProblems(sources.join(", "), plan.problems));
    return 1;
  }
  const outcome = await io.runDriver({
    dir,
    imports: plan.imports,
    node: DRIVER_NODES.tools,
    args: [dir],
    config: io.config,
  });
  const result = readDriverResult(outcome);
  if (result.kind !== "value") {
    return report(result, sources.join(", "), options.json ?? false, io);
  }
  io.out(
    options.json
      ? resultJson(result, sources.join(", "))
      : formatCatalog(result.value as CatalogEntry[]),
  );
  return 0;
}

export async function workflowList(
  dirArg: string | undefined,
  options: { json?: boolean },
  io: WorkflowIo,
): Promise<number> {
  const dir = path.resolve(io.cwd, dirArg ?? ".");
  const outcome = await io.runDriver({
    dir,
    imports: [],
    node: DRIVER_NODES.list,
    args: [dir],
    config: io.config,
  });
  const result = readDriverResult(outcome);
  if (result.kind !== "value") {
    return report(result, dir, options.json ?? false, io);
  }
  io.out(
    options.json ? resultJson(result, dir) : formatList(dir, result.value as ListedWorkflow[]),
  );
  return 0;
}

export type RunCommandOptions = { inputs?: string; json?: boolean };
export type RunCommandSettings = {
  config: AgencyConfig;
  /** The person's policy, from --policy, --approve, and --reject. */
  person: Policy;
  budget?: { maxCost?: string; maxTime?: string };
};

/** The prompts the run node raises before the first step, spelled the way
 *  each one spells its data. loadWorkflow names the real folder, `read`
 *  names the real root and the path below it, and runWorkflow names
 *  `path.resolve(dir)` with no realpath. On macOS a temp folder under `/var`
 *  is really under `/private/var`, so the wrong spelling fails there only. */
async function startPromptsFor(prepared: PreparedWorkflow): Promise<StartPrompts> {
  const dir = path.resolve(prepared.found.dir);
  const local = prepared.plan.imports.filter((entry) => !entry.module.startsWith("std::"));
  const moduleReads = [];
  for (const entry of local) {
    moduleReads.push(await prepareContainedPath(dir, entry.module, "read"));
  }
  return {
    name: prepared.found.name,
    dir,
    workflowsDir: path.join(fs.realpathSync(dir), "workflows"),
    moduleReads,
  };
}

/** What `run` says when a rule in the person's policy propagated a prompt
 *  and there was nobody to answer it. The child saved a checkpoint, but the
 *  command does not keep it, so the run cannot go on from there. */
function unansweredRunMessage(effects: string[]): string {
  const names = effects.join(", ");
  return `${unansweredMessage(effects)}. This run cannot be resumed. Cover ${names} with --policy, --approve, or --reject, and run it again.`;
}

/** Run a saved workflow. Before anything runs, the person sees every effect
 *  their policy does not cover and approves or declines them all at once.
 *  The table, the question, and every message go to `err`, so `out` holds
 *  only the result. */
export async function workflowRun(
  target: string,
  options: RunCommandOptions,
  settings: RunCommandSettings,
  io: WorkflowIo,
): Promise<number> {
  let inputs: unknown = {};
  if (options.inputs !== undefined) {
    try {
      inputs = JSON.parse(options.inputs);
    } catch (error) {
      io.err(`--inputs is not JSON: ${(error as Error).message}`);
      return 2;
    }
  }
  const prepared = prepareWorkflow(target, io);
  if ("exitCode" in prepared) {
    return prepared.exitCode;
  }
  const steps = stepEffects(prepared.workflow, prepared.plan.signatures);
  const uncovered = uncoveredEffects(steps, settings.person);
  if (uncovered.length > 0) {
    io.err(formatUncovered(uncovered));
    if (io.confirm === null) {
      io.err(NO_TERMINAL);
      return 1;
    }
    // A yes approves each effect for the whole run, whatever step raises it,
    // the same as --approve. The question says so.
    const flag = `--approve ${uncovered.map((entry) => entry.effect).join(",")}`;
    const question = `Approve these effects for the whole run? This is the same as ${flag}`;
    if (!(await io.confirm(question))) {
      io.err("Did not run.");
      return 1;
    }
  }
  let start: StartPrompts;
  try {
    start = await startPromptsFor(prepared);
  } catch (error) {
    io.err(stripControlCharacters((error as Error).message));
    return 1;
  }
  const accepted = uncovered.map((entry) => entry.effect);
  const policy = runPolicy(settings.person, startRules(start), accepted);
  const outcome = await io.runDriver({
    dir: start.dir,
    imports: prepared.plan.imports,
    node: DRIVER_NODES.run,
    args: [start.name, start.dir, inputs],
    config: settings.config,
    carriers: {
      policy: { policyJson: JSON.stringify(policy), interactive: false },
      budget: settings.budget,
    },
  });
  const read = readDriverResult(outcome);
  const result: DriverResult =
    read.kind === "unanswered"
      ? { kind: "failed", message: unansweredRunMessage(read.effects), step: null }
      : read;
  if (options.json) {
    io.out(resultJson(result, prepared.label));
    return result.kind === "value" ? 0 : 1;
  }
  if (result.kind !== "value") {
    return report(result, prepared.label, false, io);
  }
  io.out(formatRunValue(result.value));
  return 0;
}
