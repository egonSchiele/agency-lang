/**
 * The host passes the tools a workflow may call as function values. A
 * function value carries the compiler's module id, a path relative to the
 * working directory it was compiled in (`stdlib/shell.agency`,
 * `agent/notes.agency`). This file turns each one into the module text an
 * import line uses, which is also what a workflow's `module` field says.
 */
import path from "#path";
import { AgencyFunction } from "../../runtime/agencyFunction.js";
import { moduleIdToOrigin } from "../../runtime/origin.js";
import { assertUniqueToolNames } from "../../runtime/toolInvocation.js";
import type { Problem, ToolRef } from "./types.js";

export type ToolRefsResult =
  { refs: ToolRef[]; problems: [] } | { refs: null; problems: Problem[] };

/** The module text is written into an import line, so it may hold no quote,
 *  backslash, space, or newline. */
export const MODULE_PATH = /^[A-Za-z0-9_@:./-]+$/;

/** Agency's own stdlib is compiled from the package root, so its ids start
 *  here. A user file in a folder named `stdlib` has a longer id and stays
 *  local. */
const STDLIB_ID = /^stdlib\//;

const RUNTIME_MODULE = "__runtime";

/** The function value a tool is, or the refusal that it cannot be imported. */
type Importable = { fn: AgencyFunction; refusal: null } | { fn: null; refusal: string };

function importable(tool: unknown, index: number): Importable {
  if (!AgencyFunction.isAgencyFunction(tool)) {
    return refused(`tool ${index + 1} is not an Agency function`);
  }
  if (tool.name !== tool.registeredName) {
    return refused(
      `tool "${tool.name}" is renamed from "${tool.registeredName}"; pass the original def`,
    );
  }
  if (tool.boundArgs !== null) {
    return refused(`tool "${tool.name}" is a partial; pass the original def`);
  }
  if (tool.created !== undefined) {
    return refused(`tool "${tool.name}" was built by createTool and cannot be imported`);
  }
  if (tool.module === RUNTIME_MODULE) {
    return refused(`tool "${tool.name}" is built into the runtime and cannot be imported`);
  }
  return { fn: tool, refusal: null };
}

function refused(refusal: string): Importable {
  return { fn: null, refusal };
}

/** The module text for an import line, or the refusal. */
type ModuleOutcome = { text: string; refusal: null } | { text: null; refusal: string };

function localModule(tool: AgencyFunction, dir: string, cwd: string): ModuleOutcome {
  const fromDir = path.relative(path.resolve(cwd, dir), path.resolve(cwd, tool.module));
  if (fromDir === ".." || fromDir.startsWith("../") || path.isAbsolute(fromDir)) {
    const refusal = `tool "${tool.name}" is defined in "${tool.module}", outside the workflow directory`;
    return { text: null, refusal };
  }
  return { text: `./${fromDir}`, refusal: null };
}

function moduleText(tool: AgencyFunction, dir: string, cwd: string): ModuleOutcome {
  const origin = moduleIdToOrigin(tool.module);
  if (origin.startsWith("pkg::")) {
    // `describe` cannot read a package's source from a re-export line, so
    // the tool's return type would be unknown.
    const refusal = `tool "${tool.name}" comes from the package "${origin}"; package tools are not supported yet`;
    return { text: null, refusal };
  }
  const isStdlib = origin.startsWith("std::") && STDLIB_ID.test(tool.module);
  const outcome = isStdlib ? { text: origin, refusal: null } : localModule(tool, dir, cwd);
  if (outcome.text !== null && !MODULE_PATH.test(outcome.text)) {
    const refusal = `tool "${tool.name}" comes from a module path that cannot be written in an import`;
    return { text: null, refusal };
  }
  return outcome;
}

/** The ref for one tool, or the problem that refuses it. */
type ToolOutcome = { ref: ToolRef | null; problem: Problem | null };

const wholeWorkflow = (message: string): Problem => ({ step: null, field: null, message });

function toolOutcome(tool: unknown, index: number, dir: string, cwd: string): ToolOutcome {
  const checked = importable(tool, index);
  if (checked.fn === null) {
    return { ref: null, problem: wholeWorkflow(checked.refusal) };
  }
  const module = moduleText(checked.fn, dir, cwd);
  if (module.text === null) {
    return { ref: null, problem: wholeWorkflow(module.refusal) };
  }
  return { ref: { module: module.text, name: checked.fn.name }, problem: null };
}

/** One `ToolRef` per function value. `dir` is the workflow's directory and
 *  `cwd` the working directory the tools were compiled in; a relative `dir`
 *  is read against `cwd`. Every tool that cannot be imported is reported,
 *  in order; the duplicate-name check runs only when all of them can. */
export function toolRefs(tools: unknown[], dir: string, cwd: string): ToolRefsResult {
  const outcomes = tools.map((tool, index) => toolOutcome(tool, index, dir, cwd));
  const problems = outcomes.flatMap(({ problem }) => (problem === null ? [] : [problem]));
  if (problems.length > 0) {
    return { refs: null, problems };
  }
  const refs = outcomes.map(({ ref }) => ref!);
  try {
    assertUniqueToolNames(refs);
  } catch (error) {
    // The runtime's check throws; here its message is a problem like any other.
    const message = error instanceof Error ? error.message : String(error);
    return { refs: null, problems: [wholeWorkflow(message)] };
  }
  return { refs, problems: [] };
}
