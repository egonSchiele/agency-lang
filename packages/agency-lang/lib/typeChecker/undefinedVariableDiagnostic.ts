import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import type { Scope } from "./scope.js";
import type { AgencyNode, VariableNameLiteral } from "../types.js";
import type { WalkAncestor } from "../utils/node.js";
import { walkNodes } from "../utils/node.js";
import { resolveVariable } from "./resolveVariable.js";
import { collectProgramShadowing } from "./shadowing.js";

/**
 * Emit a diagnostic for every variable reference that doesn't resolve
 * — `let x = undefinedVar`, `print(missingThing)`, `for (item in
 * notArray)`, etc.
 *
 * Severity is controlled by `config.typechecker.undefinedVariables`:
 *   - "silent" (default): no diagnostics emitted
 *   - "warn":  pushed as warnings
 *   - "error": pushed as errors
 *
 * Resolution is delegated to `resolveVariable` (pure function in
 * resolveVariable.ts) — this module just walks the AST and translates
 * "didn't resolve" into a diagnostic.
 *
 * Skipped contexts (handled by other passes / not actually variable
 * lookups):
 *   - `valueAccess.chain[i].kind === "property"` — property names like
 *     `obj.x` are not variable references; the typechecker checks them
 *     against the base's structural type elsewhere.
 *   - The base of a `valueAccess` is checked here (it's the variable),
 *     but only when it's a `variableName`.
 *   - `functionCall.functionName` is checked by `checkUndefinedFunctions`,
 *     not here.
 *   - The `name` of a `namedArgument` is a parameter name, not a variable.
 *   - Object literal keys (`{ key: value }`) are field names, not
 *     variable refs.
 */
export function checkUndefinedVariables(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): void {
  const mode = ctx.config.typechecker?.undefinedVariables ?? "silent";
  if (mode === "silent") return;

  const { importedNodeNames, classNames: classDefs } = collectProgramShadowing(
    ctx.programNodes,
  );

  for (const info of scopes) {
    if (!info.name) continue;
    const isTopLevel = info.name === "top-level";
    ctx.withScope(info.scopeKey, () => {
      for (const { node, ancestors } of walkNodes(info.body)) {
        // Mirror checkUndefinedFunctions: avoid double-reporting
        // function/graphNode bodies during the top-level pass.
        if (isTopLevel && hasFunctionOrNodeAncestor(ancestors)) continue;
        if (node.type !== "variableName") continue;
        if (isReferencePosition(node, ancestors)) {
          checkVariableRef(node, ancestors, info.scope, ctx, mode, importedNodeNames, classDefs);
        }
      }
    });
  }
}

function hasFunctionOrNodeAncestor(ancestors: readonly unknown[]): boolean {
  for (const a of ancestors) {
    const t = (a as AgencyNode | undefined)?.type;
    if (t === "function" || t === "graphNode") return true;
  }
  return false;
}

/**
 * A bare `variableName` node can show up in many positions where it's
 * NOT a real variable reference (e.g. import statements, type alias
 * names, parameter names). Only fire the diagnostic when the position
 * actually represents a value being read.
 *
 * Rather than enumerate every "skip" position, we accept positions where
 * walkNodes recurses into a value — those are the ones where a missing
 * binding would actually be a runtime error.
 */
function isReferencePosition(
  node: VariableNameLiteral,
  ancestors: readonly WalkAncestor[],
): boolean {
  const parent = ancestors[ancestors.length - 1];
  if (!parent) return false;
  const p = parent as AgencyNode;

  // The base of a valueAccess (`obj.x`, `obj[i]`, `obj.foo()`). The base
  // IS a value reference and must resolve. Property/method names are NOT
  // variable refs and are filtered by walkNodes already (it doesn't yield
  // them as standalone variableNames).
  if (p.type === "valueAccess") return p.base === node;

  // LHS of assignment (`x = 5`, no decl) is a write, not a read; the
  // const-reassignment pass handles unknown writes.
  if (p.type === "assignment") {
    // walkNodes only yields `node.value` (and accessChain elements), not
    // `variableName`. So if we reach here, it's nested deeper. Treat as
    // a real reference.
    return true;
  }
  return true;
}

function checkVariableRef(
  ref: VariableNameLiteral,
  ancestors: readonly WalkAncestor[],
  scope: Scope,
  ctx: TypeCheckerContext,
  mode: "warn" | "error",
  importedNodeNames: readonly string[],
  classNames: Record<string, true>,
): void {
  // Don't check the LHS of `for (item in items)` — itemVar/indexVar are
  // declarations, not references. (walkNodes shouldn't yield them, but
  // belt-and-suspenders.)
  for (const a of ancestors) {
    if ((a as AgencyNode).type === "forLoop") {
      const fl = a as AgencyNode & { type: "forLoop" };
      if (ref.value === fl.itemVar || ref.value === fl.indexVar) return;
    }
    // Block params on method calls (`xs.map(\(x) -> x + 1)`) and any
    // other call-with-block aren't currently tracked in the typechecker's
    // Scope, so look them up directly from any enclosing blockArgument.
    if ((a as { type: string }).type === "blockArgument") {
      const block = a as { type: "blockArgument"; params: { name: string }[] };
      if (block.params.some((p) => p.name === ref.value)) return;
    }
  }

  const resolution = resolveVariable(ref.value, {
    functionDefs: ctx.functionDefs,
    nodeDefs: ctx.nodeDefs,
    importedFunctions: ctx.importedFunctions,
    importedNodeNames,
    jsImportedNames: ctx.jsImportedNames,
    classNames,
    scopeHas: (name) => scope.has(name),
  });
  if (resolution.kind !== "unresolved") return;
  ctx.errors.push({
    message: `Variable '${ref.value}' is not defined.`,
    severity: mode === "warn" ? "warning" : "error",
    loc: ref.loc,
  });
}
