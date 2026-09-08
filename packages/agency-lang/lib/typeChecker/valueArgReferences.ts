import type { AgencyNode, Expression, VariableType } from "../types.js";
import type { SourceLocation } from "../types/base.js";
import type { FunctionDefinition } from "../types/function.js";
import type { GraphNodeDefinition } from "../types/graphNode.js";
import { getImportedNames } from "../types/importStatement.js";
import type { TypeAlias } from "../types/typeHints.js";
import { expressionChildren, walkNodes } from "../utils/node.js";
import { diagnostic } from "./diagnostics.js";
import { hasFunctionOrNodeAncestor } from "./nameReferences.js";
import { JS_GLOBALS, SANDBOX_JS_GLOBALS } from "./resolveCall.js";
import { resolveVariable } from "./resolveVariable.js";
import { collectProgramShadowing } from "./shadowing.js";
import { topLevelAssignments } from "./staticInitRules.js";
import type { TypeCheckerContext } from "./types.js";
import { visitTypes } from "./typeWalker.js";

/**
 * A value argument to a value-parameterized type (`type Age = GreaterThan(minAge)`)
 * may only name a `static const`, an imported name, or a value parameter of
 * the enclosing alias (AG7007). A value parameter's default follows the same
 * rule, minus the alias's own parameters.
 *
 * Codegen prints a value argument as a bare identifier and reads it once,
 * where the type is declared. A plain top-level `const` lives in the global
 * store, and a parameter or local lives on the stack frame, so neither is a
 * JavaScript identifier there: the program crashed with "minAge is not
 * defined" (issue #441). A name that resolves to nothing at all is reported
 * as an undefined variable, since the general pass does not look inside
 * type annotations.
 *
 * The rule is `REJECTED_ORIGINS`. The rest of this file gathers where each
 * name was declared and where each type annotation sits.
 */

/** Where a name referenced from a value argument was declared. */
type NameOrigin = "static" | "import" | "valueParam" | "global" | "param" | "local";

/** Origins that are not a JavaScript identifier where a type is declared,
 *  with the wording the diagnostic uses for each. An origin missing here is
 *  legal. */
const REJECTED_ORIGINS: Partial<Record<NameOrigin, string>> = {
  global: "a top-level variable",
  param: "a parameter",
  local: "a local variable",
};

type Origins = Record<string, NameOrigin>;

type Definition = FunctionDefinition | GraphNodeDefinition;

/** One `(alias, name)` pair: a value argument to `alias` mentions `name`. */
type ValueArgRef = { alias: string; name: string; loc: SourceLocation | undefined };

/** One type-bearing position: an annotation, an alias body, a `schema(T)`,
 *  or an `x is T`. An alias site also carries its own value parameters and
 *  their defaults. */
type TypeSite = {
  type: VariableType;
  loc: SourceLocation | undefined;
  valueParams: string[];
  defaults: Expression[];
  aliasName: string | undefined;
};

export function checkValueArgReferences(ctx: TypeCheckerContext): void {
  const report = makeReporter(ctx);
  const module = moduleOrigins(ctx.programNodes);
  for (const site of topLevelTypeSites(ctx.programNodes)) {
    checkSite(site, module, report);
  }
  const definitions: Definition[] = [
    ...Object.values(ctx.functionDefs),
    ...Object.values(ctx.nodeDefs),
  ];
  for (const definition of definitions) {
    const origins = { ...module, ...definitionOrigins(definition) };
    for (const site of definitionTypeSites(definition)) {
      checkSite(site, origins, report);
    }
  }
}

type Reporter = (ref: ValueArgRef, origin: NameOrigin | undefined) => void;

/** Reports a rejected origin as AG7007 and a name with no origin as an
 *  undefined variable, at the severity the general undefined-variable pass
 *  uses, so a typo in a value argument does not reach generated code. */
function makeReporter(ctx: TypeCheckerContext): Reporter {
  const sandbox = ctx.config.typechecker?.jsGlobals === "sandbox";
  const undefinedMode = sandbox
    ? "error"
    : (ctx.config.typechecker?.undefinedVariables ?? "silent");
  const { importedNodeNames } = collectProgramShadowing(ctx.programNodes);
  const resolveInput = {
    functionDefs: ctx.functionDefs,
    nodeDefs: ctx.nodeDefs,
    importedFunctions: ctx.importedFunctions,
    importedNodeNames,
    jsImportedNames: ctx.jsImportedNames,
    scopeHas: () => false,
    registry: sandbox ? SANDBOX_JS_GLOBALS : JS_GLOBALS,
  };
  return (ref, origin) => {
    if (origin !== undefined) {
      const what = REJECTED_ORIGINS[origin];
      if (what !== undefined) {
        const params = { alias: ref.alias, name: ref.name, what };
        ctx.errors.push(diagnostic("valueArgNotStatic", params, ref.loc ?? null));
      }
      return;
    }
    if (undefinedMode === "silent") return;
    if (resolveVariable(ref.name, resolveInput).kind !== "unresolved") return;
    ctx.errors.push(
      diagnostic("undefinedVariable", { name: ref.name }, ref.loc ?? null, {
        severity: undefinedMode === "warn" ? "warning" : "error",
      }),
    );
  };
}

function checkSite(site: TypeSite, origins: Origins, report: Reporter): void {
  for (const ref of valueArgRefs(site.type, site.loc)) {
    const origin = site.valueParams.includes(ref.name) ? "valueParam" : origins[ref.name];
    report(ref, origin);
  }
  for (const expr of site.defaults) {
    for (const name of variableNamesIn(expr)) {
      report({ alias: site.aliasName ?? "", name, loc: site.loc }, origins[name]);
    }
  }
}

/** Static, imported, and plain top-level names. */
function moduleOrigins(nodes: AgencyNode[]): Origins {
  const origins: Origins = {};
  for (const node of nodes) {
    if (node.type !== "importStatement") continue;
    for (const entry of node.importedNames) {
      for (const name of getImportedNames(entry)) {
        origins[name] = "import";
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

/** Sites outside any function or node body. Bodies are covered per
 *  definition, with their own parameters and locals in scope. */
function topLevelTypeSites(nodes: AgencyNode[]): TypeSite[] {
  const sites: TypeSite[] = [];
  for (const { node, ancestors } of walkNodes(nodes)) {
    if (hasFunctionOrNodeAncestor(ancestors)) continue;
    if (node.type === "function" || node.type === "graphNode") continue;
    const site = siteOf(node);
    if (site !== null) {
      sites.push(site);
    }
  }
  return sites;
}

/** Parameter and return annotations, plus every site in the body. */
function definitionTypeSites(definition: Definition): TypeSite[] {
  const sites: TypeSite[] = [];
  for (const param of definition.parameters) {
    if (param.typeHint) {
      sites.push(plainSite(param.typeHint, definition.loc));
    }
  }
  if (definition.returnType) {
    sites.push(plainSite(definition.returnType, definition.loc));
  }
  for (const { node } of walkNodes(definition.body)) {
    const site = siteOf(node);
    if (site !== null) {
      sites.push(site);
    }
  }
  return sites;
}

/** The type a statement or expression node carries, if it carries one. */
function siteOf(node: AgencyNode): TypeSite | null {
  switch (node.type) {
    case "typeAlias":
      return aliasSite(node);
    case "assignment":
      return node.typeHint ? plainSite(node.typeHint, node.loc) : null;
    case "schemaExpression":
      return plainSite(node.typeArg, node.loc);
    case "typeTestExpression":
      return plainSite(node.typeHint, node.loc);
    default:
      return null;
  }
}

function plainSite(type: VariableType, loc: SourceLocation | undefined): TypeSite {
  return { type, loc, valueParams: [], defaults: [], aliasName: undefined };
}

function aliasSite(alias: TypeAlias): TypeSite {
  const valueParams = alias.valueParams ?? [];
  return {
    type: alias.aliasedType,
    loc: alias.loc,
    valueParams: valueParams.map((param) => param.name),
    defaults: valueParams.flatMap((param) => (param.default ? [param.default] : [])),
    aliasName: alias.aliasName,
  };
}

/** Every value-argument reference inside a type. */
function valueArgRefs(type: VariableType, loc: SourceLocation | undefined): ValueArgRef[] {
  const found: ValueArgRef[] = [];
  visitTypes(type, (inner) => {
    if (inner.type !== "typeAliasVariable" && inner.type !== "genericType") return;
    const alias = inner.type === "typeAliasVariable" ? inner.aliasName : inner.name;
    for (const arg of inner.valueArgs ?? []) {
      for (const name of variableNamesIn(arg)) {
        found.push({ alias, name, loc });
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
