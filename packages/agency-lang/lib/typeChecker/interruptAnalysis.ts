import type { InterruptKind } from "../symbolTable.js";
import type { TypeCheckerContext, ScopeInfo } from "./types.js";
import { synthType } from "./synthesizer.js";
import { walkNodes } from "../utils/node.js";
import type { Expression, VariableType } from "../types.js";
import type { SplatExpression, NamedArgument } from "../types/dataStructures.js";
import type { Scope } from "./scope.js";
import { isInsideHandler } from "./checker.js";

/** Per-function analysis: what it directly interrupts and what it calls. */
type FunctionProfile = {
  kinds: string[];
  callees: string[];
};

/**
 * Declarative pipeline: collect per-scope profiles → propagate transitively → format.
 */
export function analyzeInterruptsFromScopes(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): Record<string, InterruptKind[]> {
  const profiles = collectProfiles(scopes, ctx);
  propagateTransitively(profiles);
  return formatResult(profiles);
}

// -- Phase 1: Collect --

function collectProfiles(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): Record<string, FunctionProfile> {
  const profiles: Record<string, FunctionProfile> = {};

  // Seed imported functions' direct kinds
  for (const [name, importedKinds] of Object.entries(ctx.interruptKindsByFunction)) {
    profiles[name] = { kinds: importedKinds.map((ik) => ik.kind), callees: [] };
  }

  // Analyze each scope (skip the top-level scope — it has no function name
  // and its body walks into function bodies, causing double-counting)
  for (const info of scopes) {
    if (!info.name || info.name === "top-level") continue;
    profiles[info.name] = collectFromScope(info, ctx);
  }

  return profiles;
}

function collectFromScope(info: ScopeInfo, ctx: TypeCheckerContext): FunctionProfile {
  const kinds: string[] = [];
  const callees: string[] = [];

  for (const { node } of walkNodes(info.body)) {
    if (node.type === "interruptStatement") {
      addUnique(kinds, node.kind);
    } else if (node.type === "functionCall") {
      addUnique(callees, node.functionName);
      for (const name of functionRefsInArgs(node.arguments, info.scope, ctx)) {
        addUnique(callees, name);
      }
    } else if (node.type === "gotoStatement") {
      addUnique(callees, node.nodeCall.functionName);
    }
  }

  return { kinds, callees };
}

// -- Phase 2: Propagate --

function propagateTransitively(profiles: Record<string, FunctionProfile>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const profile of Object.values(profiles)) {
      if (propagateFromCallees(profile, profiles)) changed = true;
    }
  }
}

function propagateFromCallees(
  profile: FunctionProfile,
  profiles: Record<string, FunctionProfile>,
): boolean {
  let grew = false;
  for (const callee of profile.callees) {
    const calleeKinds = profiles[callee]?.kinds ?? [];
    for (const kind of calleeKinds) {
      if (!profile.kinds.includes(kind)) {
        profile.kinds.push(kind);
        grew = true;
      }
    }
  }
  return grew;
}

// -- Phase 3: Format --

function formatResult(
  profiles: Record<string, FunctionProfile>,
): Record<string, InterruptKind[]> {
  const result: Record<string, InterruptKind[]> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.kinds.length > 0) {
      result[name] = profile.kinds.map((k) => ({ kind: k }));
    }
  }
  return result;
}

// -- Helpers --

/** Extract function names referenced in arguments via functionRefType synthesis. */
function functionRefsInArgs(
  args: (Expression | SplatExpression | NamedArgument)[],
  scope: Scope,
  ctx: TypeCheckerContext,
): string[] {
  const names: string[] = [];
  for (const arg of args) {
    const expr = arg.type === "splat" ? arg.value
      : arg.type === "namedArgument" ? arg.value
      : arg;
    functionNamesFromType(synthType(expr, scope, ctx), names);
  }
  return names;
}

/** Recursively extract function names from a synthesized type. */
function functionNamesFromType(t: VariableType | "any", out: string[]): void {
  if (t === "any") return;
  switch (t.type) {
    case "functionRefType":
      addUnique(out, t.name);
      break;
    case "arrayType":
      functionNamesFromType(t.elementType, out);
      break;
    case "objectType":
      for (const prop of t.properties) functionNamesFromType(prop.value, out);
      break;
    case "unionType":
      for (const member of t.types) functionNamesFromType(member, out);
      break;
  }
}

function addUnique(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}

/** Emit warnings for function calls that may throw interrupts but aren't inside a handler. */
export function checkUnhandledInterruptWarnings(
  scopes: ScopeInfo[],
  interruptKindsByFunction: Record<string, InterruptKind[]>,
  ctx: TypeCheckerContext,
): void {
  for (const info of scopes) {
    if (!info.name || info.name === "top-level") continue;
    for (const { node, ancestors } of walkNodes(info.body)) {
      if (node.type !== "functionCall") continue;
      const kinds = interruptKindsByFunction[node.functionName];
      if (!kinds || kinds.length === 0) continue;
      if (isInsideHandler(ancestors)) continue;
      const kindList = kinds.map((ik) => ik.kind).join(", ");
      ctx.errors.push({
        message: `Function '${node.functionName}' may throw interrupts [${kindList}] but is not inside a handler.`,
        severity: "warning",
        loc: node.loc,
      });
    }
  }
}
