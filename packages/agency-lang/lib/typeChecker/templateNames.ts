import { buildCompilationUnit, GLOBAL_SCOPE_KEY } from "../compilationUnit.js";
import { PRELUDE_NAMES } from "../prelude.js";
import { declaredName } from "../types/hole.js";
import { holeNames } from "../utils/holes.js";
import { walkNodes, walkNodesArray } from "../utils/node.js";
import { diagnostic } from "./diagnostics.js";
import {
  hasFunctionOrNodeAncestor,
  isResolvableBareCall,
  isResolvableVariableReference,
} from "./nameReferences.js";
import { resolveCall } from "./resolveCall.js";
import { resolveVariable } from "./resolveVariable.js";
import { buildScopes } from "./scopes.js";
import { collectProgramShadowing } from "./shadowing.js";
import { ANY_T } from "./primitives.js";
import type { AgencyConfig } from "../config.js";
import type { AgencyNode, AgencyProgram, CodeLiteral } from "../types.js";
import type { SourceLocation } from "../types/base.js";
import type { TypeCheckerContext } from "./types.js";

const PRELUDE = new Set(PRELUDE_NAMES);

/** A name a template uses but does not define. */
export type UndefinedTemplateName = {
  name: string;
  loc: SourceLocation | null;
};

/** One body to check, with its own view of what resolves. */
type TemplateNameScope = {
  body: AgencyNode[];
  kind: "topLevel" | "definition";
  resolvesVariable(name: string): boolean;
  resolvesCall(name: string): boolean;
};

/**
 * Names a template uses that it does not define.
 *
 * A template body is analysed as if it were its own file, because that is
 * what it becomes. `toSource` prints it, `runCode` compiles the print, and
 * the surrounding file is not there. So this takes `config` and nothing
 * else from the caller: there is no host context to leak from.
 *
 * A template may use language builtins and JS globals, the prelude, and
 * whatever it declares or imports itself.
 */
export function findUndefinedTemplateNames(
  nodes: AgencyNode[],
  config: AgencyConfig,
): UndefinedTemplateName[] {
  const found: UndefinedTemplateName[] = [];
  for (const scope of templateNameScopes(nodes, config)) {
    const isTopLevel = scope.kind === "topLevel";
    for (const { node, ancestors } of walkNodes(scope.body)) {
      // A definition's body has its own scope below, so skip it here or
      // every name inside fires twice.
      if (isTopLevel && hasFunctionOrNodeAncestor(ancestors)) {
        continue;
      }
      if (node.type === "variableName") {
        if (!isResolvableVariableReference(node, ancestors)) {
          continue;
        }
        if (scope.resolvesVariable(node.value)) {
          continue;
        }
        found.push({ name: node.value, loc: node.loc ?? null });
      }
      if (node.type === "functionCall") {
        if (!isResolvableBareCall(node, ancestors)) {
          continue;
        }
        if (scope.resolvesCall(node.functionName)) {
          continue;
        }
        found.push({ name: node.functionName, loc: node.loc ?? null });
      }
    }
  }
  return found;
}

/**
 * AG8015 — report every name a template uses but does not define.
 *
 * Always on, unlike the ordinary undefined-name checks. A template is
 * printed, compiled and run elsewhere, so nothing downstream catches this
 * before run time.
 */
export function checkTemplateNames(ctx: TypeCheckerContext): void {
  // A file with holes is itself a template, so this pass owns every name
  // in it, not just the ones inside literals. The ordinary undefined-name
  // passes stand down for such a file.
  if (holeNames(ctx.programNodes).length > 0) {
    const findings = findUndefinedTemplateNames(ctx.programNodes, ctx.config);
    reportTemplateNameFindings(findings, ctx);
  }
  // The literal loop still runs: the walker treats a literal's nodes as
  // opaque, so the whole-file pass above never looked inside them.
  for (const visit of walkNodesArray(ctx.programNodes)) {
    if (visit.node.type !== "codeLiteral") {
      continue;
    }
    const literal = visit.node as CodeLiteral;
    reportTemplateNameFindings(
      findUndefinedTemplateNames(literal.nodes, ctx.config),
      ctx,
    );
  }
}

function reportTemplateNameFindings(
  findings: UndefinedTemplateName[],
  ctx: TypeCheckerContext,
): void {
  for (const finding of findings) {
    ctx.errors.push(
      diagnostic("templateNameNotDefined", { name: finding.name }, finding.loc),
    );
  }
}

/**
 * One scope per body: the template's top level, plus one per nested
 * definition with its parameters seeded.
 *
 * `buildScopes` produces that shape already. A single flat scope would
 * reject `def greet(name: string) { return name }`, because a parameter
 * lives in its definition's own scope.
 */
function templateNameScopes(
  nodes: AgencyNode[],
  config: AgencyConfig,
): TemplateNameScope[] {
  const program: AgencyProgram = { type: "agencyProgram", nodes };
  const context = isolatedContext(program, config);
  // `walkScopeBody` has no `importNodeStatement` case, so an `import node`
  // the template makes itself has no lexical-scope fallback. Collect those
  // names here or a template-local imported node looks undefined.
  const { importedNodeNames } = collectProgramShadowing(nodes);
  return buildScopes(context).map((info) => ({
    body: info.body,
    kind: info.name === "top-level" ? "topLevel" : "definition",
    resolvesVariable: (name: string) =>
      PRELUDE.has(name) ||
      resolveVariable(name, {
        functionDefs: context.functionDefs,
        nodeDefs: context.nodeDefs,
        importedFunctions: context.importedFunctions,
        importedNodeNames,
        jsImportedNames: context.jsImportedNames,
        scopeHas: (candidate: string) => info.scope.has(candidate),
      }).kind !== "unresolved",
    resolvesCall: (name: string) =>
      PRELUDE.has(name) ||
      resolveCall(name, {
        functionDefs: context.functionDefs,
        nodeDefs: context.nodeDefs,
        importedFunctions: context.importedFunctions,
        importedNodeNames,
        jsImportedNames: context.jsImportedNames,
        scopeHas: (candidate: string) => info.scope.has(candidate),
      }).kind !== "unresolved",
  }));
}

/**
 * A context for the template body alone.
 *
 * Built from the body and the config, never from the host's. Host
 * declarations, imports, aliases, flow state and errors are all absent by
 * construction rather than by discipline.
 *
 * `buildCompilationUnit` leaves `importedFunctions` empty without a symbol
 * table, which is fine here. `walkScopeBody` declares every syntactic
 * import in the lexical scope, so an imported name still resolves through
 * `scope.has`. Do not copy the host's imports to compensate.
 */
function isolatedContext(
  program: AgencyProgram,
  config: AgencyConfig,
): TypeCheckerContext {
  const unit = buildCompilationUnit(program);
  const nodeDefs = Object.fromEntries(
    unit.graphNodes.map((node) => [declaredName(node.nodeName), node]),
  );
  let currentScopeKey = GLOBAL_SCOPE_KEY;

  const context: TypeCheckerContext = {
    programNodes: program.nodes,
    scopedTypeAliases: unit.typeAliases,
    get currentScopeKey() {
      return currentScopeKey;
    },
    functionDefs: unit.functionDefinitions,
    nodeDefs,
    importedFunctions: unit.importedFunctions,
    jsImportedNames: unit.jsImportedNames,
    interruptEffectsByFunction: {},
    errors: [],
    inferredReturnTypes: {},
    inferringReturnType: new Set<string>(),
    matchExprTypes: {},
    matchExprYieldTypes: {},
    config,
    getTypeAliases: () => unit.typeAliases.visibleIn(currentScopeKey),
    withScope<T>(key: string, fn: () => T): T {
      const previous = currentScopeKey;
      currentScopeKey = key;
      try {
        return fn();
      } finally {
        currentScopeKey = previous;
      }
    },
    inferReturnTypeFor: () => ANY_T,
  };
  return context;
}
