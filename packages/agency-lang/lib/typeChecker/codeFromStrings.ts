import { diagnostic } from "./diagnostics.js";
import type { TypeCheckError } from "./types.js";
import type { CompilationUnit } from "../compilationUnit.js";
import type { AgencyNode } from "../types.js";
import type { ValueAccess } from "../types/access.js";
import { walkNodes } from "../utils/node.js";
import { collectProgramShadowing } from "./shadowing.js";
import { collectDeclHangingExpressions, moduleScopeNames } from "./sandboxNameCheck.js";

/** The JavaScript globals that build code from a string. */
const CODE_FROM_STRING_NAMES = ["eval", "Function"];

/** The names of the JavaScript global object. `globalThis.eval` is `eval`. */
const GLOBAL_OBJECT_NAMES = ["globalThis", "global", "window", "self"];

/**
 * Refuse `eval` and `Function` in every program, with or without
 * `--agency-only`.
 *
 * Code built from a string at run time is invisible to everything that makes
 * Agency safe: it raises no interrupt, no policy sees it, and it is not
 * split into steps, so a resume can run it again. Agency has splices and
 * templates for writing code with code, so no program needs these names.
 *
 * These need only the tree, so the compile paths call this before codegen
 * even when the type checker is off, as they do for `unwrapRefusals`.
 *
 * A name the program defines or imports itself is left alone. A local
 * variable does not count: it could hold the real `eval`.
 *
 * This reads names only. `x["ev" + "al"]` gets past it, as it gets past
 * every check on names. See docs/dev/compiler/agency-only-bound-names.md.
 */
export function codeFromStringRefusals(
  programNodes: AgencyNode[],
  owned: readonly string[],
): TypeCheckError[] {
  // Tag arguments, default values, and docstrings hang off a declaration,
  // where walkNodes over the program does not reach.
  const hanging = collectDeclHangingExpressions(programNodes, moduleScopeNames(programNodes)).map(
    (found) => found.expr,
  );

  const refusals: TypeCheckError[] = [];
  for (const { node, ancestors } of walkNodes([...programNodes, ...hanging])) {
    if (isMethodOfAValue(node, ancestors[ancestors.length - 1])) continue;
    const name = codeFromStringName(node);
    if (name === null || owned.includes(name)) continue;
    refusals.push(diagnostic("codeFromString", { name }, node.loc ?? null));
  }
  return refusals;
}

/** The names a program defines or imports, which `codeFromStringRefusals`
 *  leaves alone. */
export function namesOwnedBy(programNodes: AgencyNode[], info: CompilationUnit): string[] {
  return [
    ...Object.keys(info.functionDefinitions),
    ...info.graphNodes.map((node) => node.nodeName).filter((name) => typeof name === "string"),
    ...Object.keys(info.importedFunctions),
    ...Object.keys(info.jsImportedNames),
    ...collectProgramShadowing(programNodes).importedNodeNames,
  ];
}

/** `model.eval()` calls a method of a value, not the global. The call is a
 *  chain element of its access. In `eval("x").length` it is the base. */
function isMethodOfAValue(node: AgencyNode, parent: unknown): boolean {
  if (node.type !== "functionCall") return false;
  const access = parent as AgencyNode | undefined;
  return access?.type === "valueAccess" && access.base !== node;
}

/** `eval` or `Function` when `node` names one, else null. */
function codeFromStringName(node: AgencyNode): string | null {
  const name = nameOf(node);
  return name !== null && CODE_FROM_STRING_NAMES.includes(name) ? name : null;
}

/** The global name a node refers to: a call's function, a bare name, the
 *  class of a `new`, or the first property read from the global object. */
function nameOf(node: AgencyNode): string | null {
  if (node.type === "functionCall") {
    return typeof node.functionName === "string" ? node.functionName : null;
  }
  if (node.type === "variableName") return node.value;
  if (node.type === "newExpression") return node.className;
  if (node.type === "valueAccess") return globalObjectMember(node);
  return null;
}

/** `eval` for `globalThis.eval`, `globalThis.eval(...)`, and
 *  `globalThis["eval"]`. Null for any other access. */
function globalObjectMember(access: ValueAccess): string | null {
  const base = access.base;
  if (base.type !== "variableName" || !GLOBAL_OBJECT_NAMES.includes(base.value)) return null;
  const first = access.chain[0];
  if (first === undefined) return null;
  if (first.kind === "property") return first.name;
  if (first.kind === "methodCall") {
    const called = first.functionCall.functionName;
    return typeof called === "string" ? called : null;
  }
  if (first.kind === "index" && first.index.type === "string") {
    const segments = first.index.segments;
    return segments.length === 1 && segments[0].type === "text" ? segments[0].value : null;
  }
  return null;
}
