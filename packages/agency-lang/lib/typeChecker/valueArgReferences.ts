import type { AgencyNode, Expression, VariableType } from "../types.js";
import type { SourceLocation } from "../types/base.js";
import type { FunctionDefinition } from "../types/function.js";
import type { GraphNodeDefinition } from "../types/graphNode.js";
import { expressionChildren, walkNodes } from "../utils/node.js";
import { diagnostic } from "./diagnostics.js";
import { hasFunctionOrNodeAncestor } from "./nameReferences.js";
import { JS_GLOBALS, SANDBOX_JS_GLOBALS } from "./resolveCall.js";
import { resolveVariable } from "./resolveVariable.js";
import type { Scope } from "./scope.js";
import { collectProgramShadowing } from "./shadowing.js";
import { topLevelAssignments } from "./staticInitRules.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import type { ValueParam } from "../types/typeHints.js";
import { visitTypes } from "./typeWalker.js";

/**
 * A value argument to a value-parameterized type (`type Age = GreaterThan(minAge)`)
 * must be a literal, a `static const`, an imported name, or a value parameter
 * of the enclosing alias (AG7007). A value parameter's default may also name
 * an earlier value parameter of the same alias.
 *
 * The generated validator for a type is module-level JavaScript, and it
 * prints a value argument as a bare identifier. A `static const` and an
 * import are JavaScript identifiers there. A plain top-level variable lives
 * in the global store and a parameter or local lives on the stack frame, so
 * the program would crash with "minAge is not defined" (issue #441).
 *
 * A name that resolves to nothing at all is reported as an undefined
 * variable, since the general pass does not look inside types.
 */
export function checkValueArgReferences(scopes: ScopeInfo[], ctx: TypeCheckerContext): void {
  const report = makeReporter(ctx);
  const module = moduleOrigins(ctx.programNodes);
  for (const info of scopes) {
    const isTopLevel = info.name === "top-level";
    const definition = isTopLevel ? undefined : definitionNamed(info.name, ctx);
    const params = definition?.parameters.map((param) => param.name) ?? [];
    const classify = (name: string, site: TypeSite): Verdict => {
      const isOwnValueParam = site.valueParams.some((param) => param.name === name);
      if (isOwnValueParam || module[name] === "static") {
        return { kind: "legal" };
      }
      if (module[name] === "global") {
        return { kind: "rejected", what: "a top-level variable" };
      }
      if (params.includes(name)) {
        return { kind: "rejected", what: "a parameter" };
      }
      if (!isTopLevel && info.scope.lookupInFunction(name) !== undefined) {
        return { kind: "rejected", what: "a local variable" };
      }
      return { kind: "unknown", scope: info.scope };
    };
    if (definition) {
      for (const site of signatureSites(definition)) {
        checkSite(site, classify, report);
      }
    }
    for (const { node, ancestors } of walkNodes(info.body)) {
      if (isTopLevel && hasFunctionOrNodeAncestor(ancestors)) continue;
      for (const site of sitesOf(node)) {
        checkSite(site, classify, report);
      }
    }
  }
}

/** Where a top-level name was declared. Anything else is not in this map. */
type ModuleOrigin = "static" | "global";

type Verdict =
  { kind: "legal" } | { kind: "rejected"; what: string } | { kind: "unknown"; scope: Scope };

type Classify = (name: string, site: TypeSite) => Verdict;

type Definition = FunctionDefinition | GraphNodeDefinition;

/** One `(alias, name)` pair: a value argument to `alias` mentions `name`. */
type ValueArgRef = { alias: string; name: string; loc: SourceLocation | undefined };

/** One type-bearing position. An alias site also carries its own value
 *  parameters, whose defaults are checked too. */
type TypeSite = {
  type: VariableType;
  loc: SourceLocation | undefined;
  valueParams: ValueParam[];
  aliasName: string | undefined;
};

type Reporter = (ref: ValueArgRef, verdict: Verdict) => void;

/** Reports a rejected name as AG7007 and a name that resolves to nothing as
 *  an undefined variable, at the severity the general undefined-variable
 *  pass uses, so a typo in a value argument does not reach generated code. */
function makeReporter(ctx: TypeCheckerContext): Reporter {
  const sandbox = ctx.config.typechecker?.jsGlobals === "sandbox";
  const undefinedMode = sandbox
    ? "error"
    : (ctx.config.typechecker?.undefinedVariables ?? "silent");
  const { importedNodeNames } = collectProgramShadowing(ctx.programNodes);
  return (ref, verdict) => {
    if (verdict.kind === "rejected") {
      const params = { alias: ref.alias, name: ref.name, what: verdict.what };
      ctx.errors.push(diagnostic("valueArgNotStatic", params, ref.loc ?? null));
      return;
    }
    if (verdict.kind === "legal" || undefinedMode === "silent") {
      return;
    }
    const resolution = resolveVariable(ref.name, {
      functionDefs: ctx.functionDefs,
      nodeDefs: ctx.nodeDefs,
      importedFunctions: ctx.importedFunctions,
      importedNodeNames,
      jsImportedNames: ctx.jsImportedNames,
      scopeHas: (name) => verdict.scope.has(name),
      registry: sandbox ? SANDBOX_JS_GLOBALS : JS_GLOBALS,
    });
    if (resolution.kind !== "unresolved") {
      return;
    }
    ctx.errors.push(
      diagnostic("undefinedVariable", { name: ref.name }, ref.loc ?? null, {
        severity: undefinedMode === "warn" ? "warning" : "error",
      }),
    );
  };
}

function checkSite(site: TypeSite, classify: Classify, report: Reporter): void {
  for (const ref of valueArgRefs(site.type, site.loc)) {
    report(ref, classify(ref.name, site));
  }
  // A default may name an earlier value parameter, as in
  // `type Between(low: number, high: number = low)`: the generated factory
  // is a JavaScript function, and a default parameter sees the ones before it.
  site.valueParams.forEach((param, index) => {
    if (!param.default) {
      return;
    }
    const earlier = { ...site, valueParams: site.valueParams.slice(0, index) };
    for (const name of variableNamesIn(param.default)) {
      report({ alias: site.aliasName ?? "", name, loc: site.loc }, classify(name, earlier));
    }
  });
}

/** Which top-level `let`/`const` names are static. Null-prototype, since
 *  the keys are user-written identifiers. */
function moduleOrigins(nodes: AgencyNode[]): Record<string, ModuleOrigin> {
  const origins: Record<string, ModuleOrigin> = Object.create(null);
  for (const assignment of topLevelAssignments(nodes)) {
    if (assignment.declKind) {
      origins[assignment.variableName] = assignment.static ? "static" : "global";
    }
  }
  return origins;
}

function definitionNamed(name: string, ctx: TypeCheckerContext): Definition | undefined {
  return ctx.functionDefs[name] ?? ctx.nodeDefs[name];
}

/** Parameter and return annotations. */
function signatureSites(definition: Definition): TypeSite[] {
  const sites: TypeSite[] = [];
  for (const param of definition.parameters) {
    if (param.typeHint) {
      sites.push(plainSite(param.typeHint, definition.loc));
    }
  }
  if (definition.returnType) {
    sites.push(plainSite(definition.returnType, definition.loc));
  }
  return sites;
}

/**
 * The types a statement or expression node carries. This lists every AST
 * node with a `VariableType` field that a value-parameterized alias can
 * appear in, other than a definition's signature (`signatureSites`). Type
 * patterns in a `match` are lowered to `typeTestExpression` before the
 * checker runs, so they are covered by that case.
 */
function sitesOf(node: AgencyNode): TypeSite[] {
  switch (node.type) {
    case "typeAlias":
      return [
        {
          type: node.aliasedType,
          loc: node.loc,
          valueParams: node.valueParams ?? [],
          aliasName: node.aliasName,
        },
      ];
    case "assignment":
      return node.typeHint ? [plainSite(node.typeHint, node.loc)] : [];
    case "schemaExpression":
      return [plainSite(node.typeArg, node.loc)];
    case "typeTestExpression":
      return [plainSite(node.typeHint, node.loc)];
    case "handleBlock":
      return node.handler.kind === "inline" && node.handler.param.typeHint
        ? [plainSite(node.handler.param.typeHint, node.loc)]
        : [];
    case "functionCall": {
      const block = node.block;
      if (!block) {
        return [];
      }
      const types = block.params.map((param) => param.typeHint ?? null);
      types.push(block.declaredYieldType ?? null);
      return types.filter(isPresent).map((type) => plainSite(type, node.loc));
    }
    default:
      return [];
  }
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function plainSite(type: VariableType, loc: SourceLocation | undefined): TypeSite {
  return { type, loc, valueParams: [], aliasName: undefined };
}

/** Every value-argument reference inside a type. */
function valueArgRefs(type: VariableType, loc: SourceLocation | undefined): ValueArgRef[] {
  const found: ValueArgRef[] = [];
  visitTypes(type, (inner) => {
    if (inner.type !== "typeAliasVariable" && inner.type !== "genericType") {
      return;
    }
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
