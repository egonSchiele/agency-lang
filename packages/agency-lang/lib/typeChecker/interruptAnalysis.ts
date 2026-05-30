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

  // Set the typechecker's current scope so synthType (called via
  // functionRefsInArgs) can resolve scope-local type aliases.
  ctx.withScope(info.scopeKey, () => {
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
  });

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

/**
 * Emit warnings for function calls that may throw interrupts but aren't
 * inside a handler.
 *
 * Scoped to graph-node bodies only. `def` functions are designed to
 * propagate interrupts to the nearest enclosing handler in the caller —
 * that's the whole point of the interrupt model. Warning on `def`
 * bodies floods every library function that calls `read`/`glob`/etc.
 * with noise and trains users to ignore the diagnostic, defeating its
 * purpose at the `node` boundary where the prompt actually surfaces to
 * a human operator.
 */
export function checkUnhandledInterruptWarnings(
  scopes: ScopeInfo[],
  interruptKindsByFunction: Record<string, InterruptKind[]>,
  ctx: TypeCheckerContext,
): void {
  for (const info of scopes) {
    if (!info.name || info.name === "top-level") continue;
    // Skip `def` scopes — only warn for `node` (graph-node) bodies,
    // which are entry points where unhandled interrupts actually
    // bubble out to the runtime caller.
    if (!ctx.nodeDefs[info.name]) continue;
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

/**
 * A handler whose body can itself raise an interrupt creates a
 * dispatch-recursion loop: the inner interrupt re-enters the handler
 * chain, which visits every handler (including the one currently
 * running), which raises another interrupt, etc. The runtime now
 * bounds this at `MAX_HANDLER_CHAIN_DEPTH` and throws
 * `HandlerRecursionError`, but catching it at compile time is better.
 *
 * Restructure the code so the handler doesn't call interrupt-raising
 * functions — e.g. hoist a `read("policy.json") with approve` out of
 * the handler and into `node main()` (see `ensurePolicyLoaded` in
 * `lib/agents/agency-agent/agent.agency` for the canonical fix).
 *
 * If the call really is unavoidable, suppress this error with a
 * `// @tc-ignore` comment on the line above the `handle` block.
 */
export function checkHandlerBodyInterrupts(
  scopes: ScopeInfo[],
  interruptKindsByFunction: Record<string, InterruptKind[]>,
  ctx: TypeCheckerContext,
): void {
  for (const info of scopes) {
    ctx.withScope(info.scopeKey, () => {
      for (const { node } of walkNodes(info.body)) {
        if (node.type !== "handleBlock") continue;
        const kinds = collectHandlerOffenderKinds(
          node,
          info,
          interruptKindsByFunction,
          ctx,
        );
        if (kinds.length === 0) continue;
        const handlerLabel =
          node.handler.kind === "functionRef"
            ? `'${node.handler.functionName}'`
            : "(inline)";
        ctx.errors.push({
          message:
            `Handler ${handlerLabel} may raise interrupts [${kinds.join(", ")}]. ` +
            `That would re-enter the handler chain (the dispatcher visits ` +
            `every handler, even the one currently running) and recurse ` +
            `until \`HandlerRecursionError\` fires at runtime. ` +
            `Restructure so the handler doesn't call interrupt-raising ` +
            `code (e.g. hoist file I/O out of the handler), or suppress ` +
            `this error with \`// @tc-ignore\` on the line above the ` +
            `\`handle\` block.`,
          severity: "error",
          loc: node.loc,
        });
      }
    });
  }
}

/** Collect every interrupt kind a handle block's handler may raise,
 *  transitively. For a `functionRef` handler we read the already-propagated
 *  kinds directly. For an inline handler we mirror `collectFromScope`:
 *  direct `interruptStatement`s contribute their kind, and every callee —
 *  including function references passed as arguments (e.g. tools handed to
 *  `llm(..., tools: [deploy])`) — is resolved through
 *  `interruptKindsByFunction` so transitive interrupts via tool calls or
 *  callback handoffs are caught. */
function collectHandlerOffenderKinds(
  node: { handler: { kind: string; functionName?: string; body?: any[] } },
  info: ScopeInfo,
  interruptKindsByFunction: Record<string, InterruptKind[]>,
  ctx: TypeCheckerContext,
): string[] {
  const kinds: string[] = [];
  if (node.handler.kind === "functionRef") {
    const ks = interruptKindsByFunction[node.handler.functionName!] ?? [];
    for (const k of ks) addUnique(kinds, k.kind);
    return kinds;
  }
  // inline handler — mirror collectFromScope's callee discovery
  for (const { node: inner } of walkNodes(node.handler.body ?? [])) {
    if (inner.type === "interruptStatement") {
      addUnique(kinds, inner.kind);
      continue;
    }
    if (inner.type === "functionCall") {
      addKindsFor(inner.functionName, interruptKindsByFunction, kinds);
      for (const refName of functionRefsInArgs(inner.arguments, info.scope, ctx)) {
        addKindsFor(refName, interruptKindsByFunction, kinds);
      }
    } else if (inner.type === "gotoStatement") {
      addKindsFor(inner.nodeCall.functionName, interruptKindsByFunction, kinds);
    }
  }
  return kinds;
}

function addKindsFor(
  name: string,
  interruptKindsByFunction: Record<string, InterruptKind[]>,
  out: string[],
): void {
  const ks = interruptKindsByFunction[name] ?? [];
  for (const k of ks) addUnique(out, k.kind);
}

/** Narrow a call-argument slot (which may be a positional Expression,
 *  a SplatExpression, or a NamedArgument) to a positional Expression.
 *  Returns null for splat / named arguments — we only act on the
 *  positional `callback("hookName", fn)` shape. */
function positionalArg(
  arg: Expression | SplatExpression | NamedArgument | undefined,
): Expression | null {
  if (!arg) return null;
  if (arg.type === "splat" || arg.type === "namedArgument") return null;
  return arg;
}

/** Extract a constant string value from a literal `"text"` expression.
 *  Returns null for interpolated strings, variable references, or any
 *  expression whose value isn't statically known. */
function extractStaticString(expr: Expression): string | null {
  if (expr.type !== "string") return null;
  const segments = expr.segments ?? [];
  if (segments.length !== 1) return null;
  const seg = segments[0];
  if (seg.type !== "text") return null;
  return seg.value;
}

/**
 * `interrupt` is not allowed inside any callback body. Callbacks fire as
 * side effects; their body cannot pause execution to ask the user a
 * question. Move the `interrupt` into the calling node/function instead,
 * or use a runtime guard if you wanted budget enforcement.
 *
 * After the `liftCallbacks` preprocessor runs, every
 * `callback(...) { ... }` block becomes
 * `callback("hookName", __cb_scope_N)` — a 2-arg call whose second
 * argument is a `variableName` referencing a lifted top-level
 * function. We look that function up in `interruptKindsByFunction`
 * (transitively populated) and emit an error if it may interrupt.
 */
export function checkCallbackBodyInterrupts(
  scopes: ScopeInfo[],
  interruptKindsByFunction: Record<string, InterruptKind[]>,
  ctx: TypeCheckerContext,
): void {
  for (const info of scopes) {
    for (const { node } of walkNodes(info.body)) {
      if (node.type !== "functionCall") continue;
      if (node.functionName !== "callback") continue;
      if (node.arguments.length < 2) continue;

      const hookArg = positionalArg(node.arguments[0]);
      if (!hookArg) continue;
      const hookName = extractStaticString(hookArg);
      if (!hookName) continue;

      const fnArg = positionalArg(node.arguments[1]);
      const fnName = fnArg && fnArg.type === "variableName" ? fnArg.value : null;
      if (!fnName) continue;

      const kinds = interruptKindsByFunction[fnName];
      if (!kinds || kinds.length === 0) continue;

      const kindList = kinds.map((ik) => ik.kind).join(", ");
      ctx.errors.push({
        message:
          `\`interrupt\` is not allowed inside a callback body ` +
          `(callback registered on '${hookName}' may raise [${kindList}]). ` +
          `Callbacks fire as side effects; their body cannot pause execution ` +
          `to ask the user a question. Move the \`interrupt\` into the ` +
          `calling node/function instead, or use a runtime guard if you ` +
          `wanted budget enforcement.`,
        severity: "error",
        loc: node.loc,
      });
    }
  }
}
