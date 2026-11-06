import { diagnostic } from "./diagnostics.js";
import type { TypeCheckError } from "./types.js";
import type { CompilationUnit } from "../compilationUnit.js";
import type { AgencyNode } from "../types.js";
import type { ValueAccess } from "../types/access.js";
import { walkNodes } from "../utils/node.js";
import { collectProgramShadowing } from "./shadowing.js";
import {
  collectDeclHangingExpressions,
  literalKeyOf,
  moduleScopeNames,
} from "./sandboxNameCheck.js";

/** The JavaScript globals that build code from a string. */
const CODE_FROM_STRING_NAMES = ["eval", "Function"];

/** The names of the JavaScript global object. `globalThis.eval` is `eval`. */
const GLOBAL_OBJECT_NAMES = ["globalThis", "global", "window", "self"];

/** Every function's `constructor` is `Function`, so two of these in a row
 *  reach it from any value: `(1).constructor.constructor`. */
const CONSTRUCTOR = "constructor";

/**
 * Refuse the spelled-out ways to build code from a string, in every
 * program, with or without `--agency-only`.
 *
 * Code built from a string at run time is invisible to everything that makes
 * Agency safe: it raises no interrupt, no policy sees it, and it is not
 * split into steps, so a resume can run it again. Agency has splices and
 * templates for writing code with code, so no program needs these.
 *
 * Four forms are refused:
 *
 * 1. `eval` or `Function` as a call, a bare name, or the class of a `new`,
 *    unless the program defines or imports that name itself. A local
 *    variable does not count: it could hold the real `eval`.
 * 2. Either name read from the global object, `globalThis.eval`. A program's
 *    own `def Function` does not excuse this one: a member of the global
 *    object is never the program's function.
 * 3. `globalThis` used as a value, or read with a computed key. Copied to a
 *    local, it would carry form 2 past this check.
 * 4. `.constructor.constructor` on any value.
 *
 * These need only the tree, so the compile paths call this before codegen
 * even when the type checker is off, as they do for `unwrapRefusals`.
 *
 * THIS IS NOT A BOUNDARY. It reads spellings, so it stops an honest mistake
 * and a model that writes `eval`. A key built at run time, one `constructor`
 * per statement, or `global` copied to a local all get past it. See "Two
 * names are refused in every program" in
 * docs/dev/compiler/agency-only-bound-names.md.
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
    const parent = ancestors[ancestors.length - 1] as AgencyNode | undefined;
    const name = refusedName(node, parent, owned);
    if (name === null) continue;
    refusals.push(diagnostic("codeFromString", { name }, node.loc ?? null));
  }
  return refusals;
}

/** What `node` is refused for, as the text to show the author, or null. */
function refusedName(
  node: AgencyNode,
  parent: AgencyNode | undefined,
  owned: readonly string[],
): string | null {
  if (node.type === "valueAccess") {
    return globalObjectMember(node) ?? constructorOfConstructor(node);
  }
  if (node.type === "variableName" && node.value === "globalThis") {
    return readsANamedMember(parent, node) ? null : "globalThis";
  }
  const name = bareName(node, parent);
  if (name === null || !CODE_FROM_STRING_NAMES.includes(name)) return null;
  return owned.includes(name) ? null : name;
}

/** The name a node refers to in the program's own scope: a call's function,
 *  a bare name, or the class of a `new`. Null for `model.eval()`, which
 *  calls a method of a value: there the call is a chain element of its
 *  access. In `eval("x").length` the call is the base, and it counts. */
function bareName(node: AgencyNode, parent: AgencyNode | undefined): string | null {
  if (node.type === "functionCall") {
    const isMethod = parent?.type === "valueAccess" && parent.base !== node;
    return !isMethod && typeof node.functionName === "string" ? node.functionName : null;
  }
  if (node.type === "variableName") return node.value;
  if (node.type === "newExpression") return node.className;
  return null;
}

/** `eval` or `Function` when `access` reads one from the global object:
 *  `globalThis.eval`, `globalThis.eval(...)`, `globalThis["eval"]`. */
function globalObjectMember(access: ValueAccess): string | null {
  const base = access.base;
  if (base.type !== "variableName" || !GLOBAL_OBJECT_NAMES.includes(base.value)) return null;
  const first = access.chain[0];
  const key = first === undefined ? null : literalKeyOf(first);
  return key !== null && CODE_FROM_STRING_NAMES.includes(key) ? `${base.value}.${key}` : null;
}

/** Whether `globalThis` here is the base of an access whose first key is
 *  spelled out, such as `globalThis.Math`. `globalObjectMember` judges that
 *  key. Any other use hands the whole global object to something this check
 *  cannot follow. */
function readsANamedMember(parent: AgencyNode | undefined, node: AgencyNode): boolean {
  if (parent?.type !== "valueAccess" || parent.base !== node) return false;
  const first = parent.chain[0];
  return first !== undefined && literalKeyOf(first) !== null;
}

/** `.constructor.constructor` when the chain spells `constructor` twice in
 *  a row, as a property or a string key. */
function constructorOfConstructor(access: ValueAccess): string | null {
  const keys = access.chain.map(literalKeyOf);
  const twice = keys.some((key, i) => key === CONSTRUCTOR && keys[i + 1] === CONSTRUCTOR);
  return twice ? ".constructor.constructor" : null;
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
