import type { AgencyNode, Expression, VariableType } from "../types.js";
import type { TypeAlias } from "../types/typeHints.js";
import { expressionChildren, walkNodes } from "../utils/node.js";
import { diagnostic } from "./diagnostics.js";
import type { TypeCheckerContext } from "./types.js";
import { visitTypes } from "./typeWalker.js";

/**
 * A value argument to a value-parameterized type (`type Age = GreaterThan(minAge)`)
 * may only name a `static const`, an imported name, or a value parameter of
 * the enclosing alias (AG7007).
 *
 * Codegen prints a value argument as a bare identifier and reads it once,
 * where the type is declared. A plain top-level `const` lives in the global
 * store, and a parameter or local lives on the stack frame, so neither is a
 * JavaScript identifier there: the program crashed with "minAge is not
 * defined" (issue #441). Only a name the checker can prove is one of those
 * is reported. An unknown name is the undefined-variable diagnostic's job.
 */
export function checkValueArgReferences(ctx: TypeCheckerContext): void {
  const legal: string[] = [];
  const globals: string[] = [];
  for (const top of ctx.programNodes) {
    const node = top.type === "withModifier" ? top.statement : top;
    if (node.type === "assignment" && node.declKind) {
      (node.static ? legal : globals).push(node.variableName);
    }
    if (node.type === "importStatement") {
      for (const entry of node.importedNames) {
        if (entry.type !== "namedImport") continue;
        for (const name of entry.importedNames) {
          if (typeof name === "string") legal.push(name);
        }
      }
    }
    if (node.type === "typeAlias") {
      checkAlias(node, legal, globals, ctx);
    }
  }

  const defs = [...Object.values(ctx.functionDefs), ...Object.values(ctx.nodeDefs)];
  for (const def of defs) {
    const params = def.parameters.map((p) => p.name);
    const locals: string[] = [];
    for (const { node } of walkNodes(def.body)) {
      if (node.type === "assignment" && node.declKind) locals.push(node.variableName);
    }
    const kindOf = (name: string): string | null => {
      if (params.includes(name)) return "a parameter";
      if (locals.includes(name)) return "a local variable";
      if (globals.includes(name)) return "a top-level variable";
      return null;
    };
    for (const p of def.parameters) {
      if (p.typeHint) checkType(p.typeHint, legal, kindOf, def.loc, ctx);
    }
    if (def.returnType) checkType(def.returnType, legal, kindOf, def.loc, ctx);
    for (const { node } of walkNodes(def.body)) {
      if (node.type === "typeAlias") {
        checkAliasWith(node, legal, kindOf, ctx);
      } else if (node.type === "assignment" && node.typeHint) {
        checkType(node.typeHint, legal, kindOf, node.loc, ctx);
      }
    }
  }
}

function checkAlias(
  alias: TypeAlias,
  legal: string[],
  globals: string[],
  ctx: TypeCheckerContext,
): void {
  const kindOf = (name: string): string | null =>
    globals.includes(name) ? "a top-level variable" : null;
  checkAliasWith(alias, legal, kindOf, ctx);
}

function checkAliasWith(
  alias: TypeAlias,
  legal: string[],
  kindOf: (name: string) => string | null,
  ctx: TypeCheckerContext,
): void {
  const ownParams = (alias.valueParams ?? []).map((p) => p.name);
  const legalHere = [...legal, ...ownParams];
  checkType(alias.aliasedType, legalHere, kindOf, alias.loc, ctx);
}

function checkType(
  t: VariableType,
  legal: string[],
  kindOf: (name: string) => string | null,
  loc: AgencyNode["loc"],
  ctx: TypeCheckerContext,
): void {
  visitTypes(t, (inner) => {
    if (inner.type !== "typeAliasVariable" && inner.type !== "genericType") return;
    const alias = inner.type === "typeAliasVariable" ? inner.aliasName : inner.name;
    for (const arg of inner.valueArgs ?? []) {
      for (const name of variableNamesIn(arg)) {
        if (legal.includes(name)) continue;
        const what = kindOf(name);
        if (what === null) continue;
        ctx.errors.push(diagnostic("valueArgNotStatic", { alias, name, what }, loc ?? null));
      }
    }
  });
}

function variableNamesIn(expr: Expression): string[] {
  const names: string[] = [];
  const visit = (node: AgencyNode): void => {
    if (node.type === "variableName") names.push(node.value);
    for (const child of expressionChildren(node)) visit(child);
  };
  visit(expr as AgencyNode);
  return names;
}
