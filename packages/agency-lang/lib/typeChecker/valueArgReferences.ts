import type { AgencyNode, Expression, VariableType } from "../types.js";
import type { SourceLocation } from "../types/base.js";
import type { FunctionDefinition } from "../types/function.js";
import type { GraphNodeDefinition } from "../types/graphNode.js";
import type { TypeAlias } from "../types/typeHints.js";
import { expressionChildren, walkNodes } from "../utils/node.js";
import { diagnostic } from "./diagnostics.js";
import { topLevelAssignments } from "./staticInitRules.js";
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
 * defined" (issue #441).
 *
 * The rule is `REJECTED_ORIGINS`. The rest of this file gathers where each
 * name was declared and where each type annotation sits.
 */

/** Where a name referenced from a value argument was declared. */
type NameOrigin = "static" | "import" | "valueParam" | "global" | "param" | "local";

/** Origins that are not a JavaScript identifier where a type is declared,
 *  with the wording the diagnostic uses for each. An origin missing here is
 *  legal. A name with no origin at all is the undefined-variable pass's job. */
const REJECTED_ORIGINS: Partial<Record<NameOrigin, string>> = {
  global: "a top-level variable",
  param: "a parameter",
  local: "a local variable",
};

type Origins = Record<string, NameOrigin>;

type Definition = FunctionDefinition | GraphNodeDefinition;

/** One type annotation to check, with the value parameters it declares itself. */
type TypeSite = {
  type: VariableType;
  loc: SourceLocation | undefined;
  valueParams: string[];
};

export function checkValueArgReferences(ctx: TypeCheckerContext): void {
  const module = moduleOrigins(ctx.programNodes);
  for (const site of topLevelTypeSites(ctx.programNodes)) {
    checkSite(site, module, ctx);
  }
  const definitions: Definition[] = [
    ...Object.values(ctx.functionDefs),
    ...Object.values(ctx.nodeDefs),
  ];
  for (const definition of definitions) {
    const origins = { ...module, ...definitionOrigins(definition) };
    for (const site of definitionTypeSites(definition)) {
      checkSite(site, origins, ctx);
    }
  }
}

function checkSite(site: TypeSite, origins: Origins, ctx: TypeCheckerContext): void {
  const withOwnParams: Origins = { ...origins };
  for (const name of site.valueParams) {
    withOwnParams[name] = "valueParam";
  }
  for (const { alias, name } of valueArgNames(site.type)) {
    const what = REJECTED_ORIGINS[withOwnParams[name]];
    if (what === undefined) continue;
    ctx.errors.push(diagnostic("valueArgNotStatic", { alias, name, what }, site.loc ?? null));
  }
}

/** Static, imported, and plain top-level names. */
function moduleOrigins(nodes: AgencyNode[]): Origins {
  const origins: Origins = {};
  for (const node of nodes) {
    if (node.type !== "importStatement") continue;
    for (const entry of node.importedNames) {
      if (entry.type !== "namedImport") continue;
      for (const name of entry.importedNames) {
        if (typeof name === "string") {
          origins[name] = "import";
        }
      }
    }
  }
  for (const assignment of topLevelAssignments(nodes)) {
    if (assignment.declKind) {
      origins[assignment.variableName] = assignment.static ? "static" : "global";
    }
  }
  return origins;
}

/** Parameters and locals of one function or node body. */
function definitionOrigins(definition: Definition): Origins {
  const origins: Origins = {};
  for (const param of definition.parameters) {
    origins[param.name] = "param";
  }
  for (const { node } of walkNodes(definition.body)) {
    if (node.type === "assignment" && node.declKind) {
      origins[node.variableName] = "local";
    }
  }
  return origins;
}

function topLevelTypeSites(nodes: AgencyNode[]): TypeSite[] {
  const sites: TypeSite[] = [];
  for (const node of nodes) {
    if (node.type === "typeAlias") {
      sites.push(aliasSite(node));
    }
  }
  return sites;
}

/** Parameter and return annotations, plus every annotation and alias in the body. */
function definitionTypeSites(definition: Definition): TypeSite[] {
  const sites: TypeSite[] = [];
  for (const param of definition.parameters) {
    if (param.typeHint) {
      sites.push({ type: param.typeHint, loc: definition.loc, valueParams: [] });
    }
  }
  if (definition.returnType) {
    sites.push({ type: definition.returnType, loc: definition.loc, valueParams: [] });
  }
  for (const { node } of walkNodes(definition.body)) {
    if (node.type === "typeAlias") {
      sites.push(aliasSite(node));
    } else if (node.type === "assignment" && node.typeHint) {
      sites.push({ type: node.typeHint, loc: node.loc, valueParams: [] });
    }
  }
  return sites;
}

function aliasSite(alias: TypeAlias): TypeSite {
  return {
    type: alias.aliasedType,
    loc: alias.loc,
    valueParams: (alias.valueParams ?? []).map((param) => param.name),
  };
}

/** Every `(alias, name)` pair where a value argument to `alias` mentions `name`. */
function valueArgNames(type: VariableType): { alias: string; name: string }[] {
  const found: { alias: string; name: string }[] = [];
  visitTypes(type, (inner) => {
    if (inner.type !== "typeAliasVariable" && inner.type !== "genericType") return;
    const alias = inner.type === "typeAliasVariable" ? inner.aliasName : inner.name;
    for (const arg of inner.valueArgs ?? []) {
      for (const name of variableNamesIn(arg)) {
        found.push({ alias, name });
      }
    }
  });
  return found;
}

function variableNamesIn(expr: Expression): string[] {
  const names: string[] = [];
  const visit = (node: AgencyNode): void => {
    if (node.type === "variableName") {
      names.push(node.value);
    }
    for (const child of expressionChildren(node)) {
      visit(child);
    }
  };
  visit(expr as AgencyNode);
  return names;
}
