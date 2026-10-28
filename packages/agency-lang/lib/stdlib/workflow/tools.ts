/**
 * The host passes the tools a workflow may call as function values. A
 * function value carries the compiler's module id, a path relative to the
 * working directory it was compiled in (`stdlib/shell.agency`,
 * `agent/notes.agency`). This file turns each one into the module text an
 * import line uses, which is also what a workflow's `module` field says.
 */
import { isAbsolute, relative, resolve } from "path";
import { AgencyFunction } from "../../runtime/agencyFunction.js";
import { moduleIdToOrigin } from "../../runtime/origin.js";
import { assertUniqueToolNames } from "../../runtime/toolInvocation.js";
import type { ToolRef } from "./types.js";

/** The module text is written into an import line, so it may hold no quote,
 *  backslash, space, or newline. */
const MODULE_PATH = /^[A-Za-z0-9_@:./-]+$/;

/** Agency's own stdlib is compiled from the package root, so its ids start
 *  here. A user file in a folder named `stdlib` has a longer id and stays
 *  local. */
const STDLIB_ID = /^stdlib\//;

const RUNTIME_MODULE = "__runtime";

function checkImportable(tool: unknown, index: number): AgencyFunction {
  if (!AgencyFunction.isAgencyFunction(tool)) {
    throw new Error(`tool ${index + 1} is not an Agency function`);
  }
  if (tool.name !== tool.registeredName) {
    throw new Error(
      `tool "${tool.name}" is renamed from "${tool.registeredName}"; pass the original def`,
    );
  }
  if (tool.boundArgs !== null) {
    throw new Error(`tool "${tool.name}" is a partial; pass the original def`);
  }
  if (tool.created !== undefined) {
    throw new Error(`tool "${tool.name}" was built by createTool and cannot be imported`);
  }
  if (tool.module === RUNTIME_MODULE) {
    throw new Error(`tool "${tool.name}" is built into the runtime and cannot be imported`);
  }
  return tool;
}

function localModule(tool: AgencyFunction, dir: string, cwd: string): string {
  const fromDir = relative(resolve(cwd, dir), resolve(cwd, tool.module));
  if (fromDir === ".." || fromDir.startsWith("../") || isAbsolute(fromDir)) {
    throw new Error(
      `tool "${tool.name}" is defined in "${tool.module}", outside the workflow directory`,
    );
  }
  return `./${fromDir}`;
}

function moduleText(tool: AgencyFunction, dir: string, cwd: string): string {
  const origin = moduleIdToOrigin(tool.module);
  const isShared =
    origin.startsWith("pkg::") || (origin.startsWith("std::") && STDLIB_ID.test(tool.module));
  const text = isShared ? origin : localModule(tool, dir, cwd);
  if (!MODULE_PATH.test(text)) {
    throw new Error(
      `tool "${tool.name}" comes from a module path that cannot be written in an import`,
    );
  }
  return text;
}

/** One `ToolRef` per function value. `dir` is the workflow's directory and
 *  `cwd` the working directory the tools were compiled in; a relative `dir`
 *  is read against `cwd`. Throws on the first tool that cannot be imported. */
export function toolRefs(tools: unknown[], dir: string, cwd: string): ToolRef[] {
  const functions = tools.map(checkImportable);
  const refs = functions.map((tool) => ({ module: moduleText(tool, dir, cwd), name: tool.name }));
  assertUniqueToolNames(refs);
  return refs;
}
