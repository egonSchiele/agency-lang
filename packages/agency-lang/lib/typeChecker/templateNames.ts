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
import { validateTypeReferences } from "./validate.js";
import { ANY_T } from "./primitives.js";
import type { AgencyConfig } from "../config.js";
import type {
  AgencyNode,
  AgencyProgram,
  CodeLiteral,
  TypeAliasEntry,
} from "../types.js";
import type { SourceLocation } from "../types/base.js";
import type { FunctionDefinition } from "../types/function.js";
import type { GraphNodeDefinition } from "../types/graphNode.js";
import type { TypeCheckError, TypeCheckerContext } from "./types.js";

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
  options: { includeTypeNames?: boolean } = {},
): UndefinedTemplateName[] {
  const { includeTypeNames = true } = options;
  const found: UndefinedTemplateName[] = [];
  const context = isolatedContext({ type: "agencyProgram", nodes }, config);
  for (const scope of templateNameScopes(nodes, context)) {
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
  if (includeTypeNames) {
    // Building the scopes above already validated every annotated
    // declaration, including a hole's, against the template's own aliases.
    // Those findings are in the isolated context; the rest of what it
    // collected stays discarded.
    found.push(...unknownTypesIn(context.errors));
    found.push(...undefinedSignatureTypes(nodes, context));
  }
  return found;
}

/** The unknown-type findings among diagnostics, by their recorded name. */
function unknownTypesIn(
  errors: readonly TypeCheckError[],
): UndefinedTemplateName[] {
  return errors
    .filter((error) => error.name === "unknownTypeAlias")
    .map((error) => ({
      name: String((error.params as { alias?: unknown }).alias ?? ""),
      loc: error.loc ?? null,
    }));
}

/**
 * Types named in a `def` or `node` signature.
 *
 * `walkScopeBody` validates annotated declarations and nothing else, so a
 * parameter or return type would otherwise go unchecked.
 *
 * Alias bodies stay unchecked on purpose: `type Box<T>` binds `T`, and
 * `validateTypeReferences` has no notion of a bound name, so checking one
 * would report every generic alias a template declares.
 */
function undefinedSignatureTypes(
  nodes: AgencyNode[],
  context: TypeCheckerContext,
): UndefinedTemplateName[] {
  const errors: TypeCheckError[] = [];
  const aliases = context.getTypeAliases();
  for (const { node } of walkNodes(nodes)) {
    if (node.type !== "function" && node.type !== "graphNode") {
      continue;
    }
    const signature = node as FunctionDefinition | GraphNodeDefinition;
    for (const parameter of signature.parameters) {
      if (!parameter.typeHint) continue;
      validateTypeReferences(
        parameter.typeHint,
        parameter.name,
        aliases,
        errors,
        node.loc,
      );
    }
    if (signature.returnType) {
      validateTypeReferences(
        signature.returnType,
        "return",
        aliases,
        errors,
        node.loc,
      );
    }
  }
  return unknownTypesIn(errors);
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
    // Type names are left alone here. A file's own annotations are already
    // validated against its real imports, which resolve; reporting them
    // again would put AG8015 beside the AG1006 that pass emits.
    const findings = findUndefinedTemplateNames(ctx.programNodes, ctx.config, {
      includeTypeNames: false,
    });
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
  context: TypeCheckerContext,
): TemplateNameScope[] {
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
 * Every name the template's own imports bring in, as a resolvable alias.
 *
 * A template that imports `Person` may annotate with it, and no file gets
 * read to prove that, exactly as an imported function is accepted without
 * one. The stub body is `any` because nothing here knows the real shape.
 *
 * Imports do not say which names are types, so a function's name lands
 * here too: a template writing `const x: edit = …` goes unreported. That
 * costs a message the compile of the generated program still gives.
 */
function importedTypeStubs(
  nodes: AgencyNode[],
): Record<string, TypeAliasEntry> {
  const stubs: Record<string, TypeAliasEntry> = Object.create(null);
  for (const node of nodes) {
    if (node.type !== "importStatement") continue;
    for (const entry of node.importedNames) {
      if (entry.type !== "namedImport") continue;
      for (const name of entry.importedNames) {
        if (typeof name !== "string") continue;
        // Own-property only: `import { toString }` would otherwise read the
        // alias map's prototype and key the stub by a function.
        const local = Object.hasOwn(entry.aliases, name)
          ? entry.aliases[name]
          : name;
        stubs[local] = { body: ANY_T };
      }
    }
  }
  return stubs;
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
  const imported = importedTypeStubs(program.nodes);
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
    // Imported stubs first, so a name the template also declares wins.
    // Null-prototype: a type named `toString` must miss, not find a method.
    getTypeAliases: () =>
      Object.assign(
        Object.create(null) as Record<string, TypeAliasEntry>,
        imported,
        unit.typeAliases.visibleIn(currentScopeKey),
      ),
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
