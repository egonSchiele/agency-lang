import { isAnyType } from "./utils.js";
import { diagnostic, type DiagnosticParams } from "./diagnostics.js";
import type { InterruptEffect } from "../symbolTable.js";
import type { TypeCheckerContext, ScopeInfo } from "./types.js";
import { synthType } from "./synthesizer.js";
import { safeResolveType } from "./assignability.js";
import { resolveEffectSet } from "./effectSets.js";
import { walkNodes, type WalkAncestor } from "../utils/node.js";
import type { AgencyNode, Expression, VariableType } from "../types.js";
import type { SplatExpression, NamedArgument } from "../types/dataStructures.js";
import type { Scope } from "./scope.js";
import { isInsideHandler } from "./checker.js";
import {
  addUnique,
  argumentExpression,
  calledName,
  collectBodyFacts,
  unique,
} from "../analysis/bodyFacts.js";
import { propagateToFixpoint } from "../analysis/effects.js";
import type { HandleBlock } from "../types/handleBlock.js";
import type { InterruptStatement } from "../types/interruptStatement.js";

export type TaggedHandler = { block: HandleBlock; file: string };

/** Stable cross-file identity for a function/node, of the form
 *  `${file}:${name}`. Used as the key in `InterruptCallGraph` and on
 *  every call edge so that propagation works correctly when the same
 *  top-level name is defined in two modules or when an import is
 *  aliased locally (`import { foo as bar } …`). */
export type QualifiedKey = string;

export function qualifyName(file: string, name: string): QualifiedKey {
  return `${file}:${name}`;
}

export type CallEdge = {
  /** Local name used at the call site, e.g. `bar` for
   *  `import { foo as bar } …; bar()`. Preserved for diagnostics and
   *  tests; the propagation graph uses `calleeKey`. */
  calleeName: string;
  /** Resolved cross-file identity of the callee. For locally defined
   *  symbols this is `${currentFile}:${name}`. For imports it's
   *  `${originFile}:${originalName}`. For unresolved names (builtins,
   *  unknown identifiers) it falls back to `${currentFile}:${name}`. */
  calleeKey: QualifiedKey;
  enclosingHandlers: TaggedHandler[];
};

export type CallGraphFunction = {
  /** Local (unqualified) name of the function/node — what users wrote
   *  in the source. Stable within a single file. The outer map's key is
   *  the qualified `${file}:${name}` form. */
  name: string;
  /** Absolute path to the .agency file this function/node is defined in. */
  file: string;
  callEdges: CallEdge[];
  interruptSites: {
    site: InterruptStatement;
    /** Same as the function's `file`. Carried explicitly so consumers don't
     *  have to look it up. */
    file: string;
    enclosingHandlers: TaggedHandler[];
  }[];
};

/** Cross-file call graph keyed by `QualifiedKey`. Built per-file by
 *  `buildInterruptCallGraph` and merged across files in
 *  `lib/analysis/interrupts.ts` (where the qualified keys are what make
 *  the merge collision-free). */
export type InterruptCallGraph = Record<QualifiedKey, CallGraphFunction>;

/** Per-function analysis: what it directly interrupts and what it calls. Field
 *  names match PropagationNode so the shared fixpoint runs over it unchanged. */
type FunctionProfile = {
  effects: string[];
  calleeKeys: string[];
};

/**
 * Declarative pipeline: collect per-scope profiles → propagate transitively → format.
 */
export function analyzeInterruptsFromScopes(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): Record<string, InterruptEffect[]> {
  return formatResult(propagateToFixpoint(collectProfiles(scopes, ctx)));
}

// -- Phase 1: Collect --

function collectProfiles(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): Record<string, FunctionProfile> {
  const profiles: Record<string, FunctionProfile> = {};

  // Seed imported functions' direct kinds
  for (const [name, importedKinds] of Object.entries(ctx.interruptEffectsByFunction)) {
    profiles[name] = {
      effects: importedKinds.map((entry) => entry.effect),
      calleeKeys: [],
    };
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
  // Set the typechecker's current scope so synthType (called via
  // functionRefsInArgs) can resolve scope-local type aliases.
  let profile: FunctionProfile = { effects: [], calleeKeys: [] };
  ctx.withScope(info.scopeKey, () => {
    profile = collectFromBody(info.body, info.scope, ctx);
  });
  return profile;
}

/** The effects a callee declares when it is a function-typed VARIABLE (a
 *  callback), read from its type's `raises` clause. Returns [] for a named
 *  `def` (its type is a `functionRefType`, not a `blockType`, so it is not
 *  double-counted — the callee lookup already covers it) and for `<*>` (which
 *  has no concrete labels to attribute; see the v1 limitation in the guide). */
function calleeDeclaredEffects(
  functionName: string,
  scope: Scope,
  ctx: TypeCheckerContext,
): string[] {
  const t = scope.lookup(functionName);
  if (t === undefined || isAnyType(t)) return [];
  const resolved = safeResolveType(t, ctx.getTypeAliases());
  if (resolved.type !== "blockType" || !resolved.raises) return [];
  const set = resolveEffectSet(resolved.raises, ctx.getTypeAliases());
  return set.any ? [] : set.labels;
}

/** Walk one AST body and produce a `FunctionProfile`: direct interrupt
 *  kinds plus the names of every callee — including function references
 *  passed as arguments (e.g. `llm(..., { tools: [deploy] })`) and `goto`
 *  targets. Shared between Phase 1 scope analysis and the handler-body
 *  diagnostic so any future analyzer change applies to both. The caller
 *  is responsible for setting `ctx.withScope` if the body's
 *  `functionRefsInArgs` resolution needs scope-local type aliases. */
function collectFromBody(
  body: AgencyNode[],
  scope: Scope,
  ctx: TypeCheckerContext,
): FunctionProfile {
  const facts = collectBodyFacts(body);
  return {
    effects: unique([
      ...facts.effects,
      // A call THROUGH a function-typed variable (a callback) contributes the
      // variable's declared effects. Named defs resolve via the callee lookup
      // instead; they aren't blockTypes, so this adds nothing for them.
      ...facts.callees.flatMap((name) => calleeDeclaredEffects(name, scope, ctx)),
    ]),
    calleeKeys: unique([
      ...facts.callees,
      ...facts.calls.flatMap((call) => functionRefsInArgs(call.arguments, scope, ctx)),
    ]),
  };
}

// -- Phase 3: Format --

function formatResult(
  profiles: Record<string, FunctionProfile>,
): Record<string, InterruptEffect[]> {
  const result: Record<string, InterruptEffect[]> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.effects.length > 0) {
      result[name] = profile.effects.map((effect) => ({ effect }));
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
    functionNamesFromType(synthType(argumentExpression(arg), scope, ctx), names);
  }
  return names;
}

/** Recursively extract function names from a synthesized type. */
function functionNamesFromType(t: VariableType, out: string[]): void {
  if (isAnyType(t)) return;
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

/**
 * Build a per-function call graph that, for each call edge and each
 * `interruptStatement`, records the list of `handle` blocks in the
 * enclosing function body that lexically wrap it. Each handler is
 * tagged with its file so the file survives propagation in the
 * downstream handler-set analyzer.
 *
 * Unlike `analyzeInterruptsFromScopes` this does NOT propagate kinds
 * transitively — it only records direct, per-function structural facts.
 * The propagation lives in `lib/analysis/interrupts.ts`.
 */
export function buildInterruptCallGraph(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): InterruptCallGraph {
  const out: InterruptCallGraph = {};
  const resolveCallee = makeCalleeResolver(ctx);
  for (const info of scopes) {
    if (!info.name || info.name === "top-level") continue;
    const file = info.file;
    const entry: CallGraphFunction = {
      name: info.name,
      file,
      callEdges: [],
      interruptSites: [],
    };
    const addEdge = (calleeName: string, enclosing: TaggedHandler[]) => {
      entry.callEdges.push({
        calleeName,
        calleeKey: resolveCallee(calleeName, file),
        enclosingHandlers: enclosing,
      });
    };
    ctx.withScope(info.scopeKey, () => {
      for (const { node, ancestors } of walkNodes(info.body)) {
        const enclosing = enclosingHandleBlocks(ancestors, file);
        if (node.type === "interruptStatement") {
          entry.interruptSites.push({
            site: node,
            file,
            enclosingHandlers: enclosing,
          });
        } else if (node.type === "functionCall") {
          addEdge(node.functionName, enclosing);
          for (const refName of functionRefsInArgs(node.arguments, info.scope, ctx)) {
            addEdge(refName, enclosing);
          }
        } else if (node.type === "gotoStatement") {
          addEdge(node.nodeCall.functionName, enclosing);
        }
      }
    });
    out[qualifyName(file, info.name)] = entry;
  }
  return out;
}

/**
 * Build a resolver that maps a local callee name (as written at a call
 * site in `currentFile`) to its qualified `${originFile}:${originalName}`
 * key:
 *
 *  - If the name is defined locally (`ctx.functionDefs` / `ctx.nodeDefs`),
 *    the key is `${currentFile}:${name}`.
 *  - If the name is imported (`ctx.importedFunctions[name]`), the key is
 *    `${originFile}:${originalName}` — which is what the corresponding
 *    `CallGraphFunction` entry will be keyed under after `buildInterruptCallGraph`
 *    runs over the origin file.
 *  - If the name is an imported node from an `import node …` statement,
 *    the symbol table is consulted for the origin file. Node imports
 *    don't permit aliasing, so the originalName equals the local name.
 *  - Otherwise (builtins, unknown names), fall back to
 *    `${currentFile}:${name}` so the edge is at least keyed consistently;
 *    the propagation just won't find any matching callee state.
 */
function makeCalleeResolver(
  ctx: TypeCheckerContext,
): (calleeName: string, currentFile: string) => QualifiedKey {
  // Pre-resolve `import node … from …` statements once per typecheck pass
  // so per-edge resolution is a single map lookup.
  const importedNodeOrigins: Record<string, { file: string; originalName: string }> = {};
  if (ctx.symbolTable && ctx.currentFile) {
    for (const node of ctx.programNodes) {
      if (node.type !== "importNodeStatement") continue;
      for (const r of ctx.symbolTable.resolveImportedNodes(node, ctx.currentFile)) {
        importedNodeOrigins[r.localName] = { file: r.file, originalName: r.originalName };
      }
    }
  }
  return (calleeName, currentFile) => {
    const importedFn = ctx.importedFunctions[calleeName];
    if (importedFn?.originFile && importedFn.originalName) {
      return qualifyName(importedFn.originFile, importedFn.originalName);
    }
    const importedNode = importedNodeOrigins[calleeName];
    if (importedNode) {
      return qualifyName(importedNode.file, importedNode.originalName);
    }
    return qualifyName(currentFile, calleeName);
  };
}

/** Return the `handle` block ancestors of a walked node, tagged with the
 *  file they live in (always the enclosing function's file). `walkNodes`
 *  yields `WalkAncestor[]` (a union including `BlockArgument`), so the
 *  filter narrows by `type === "handleBlock"`. */
function enclosingHandleBlocks(ancestors: WalkAncestor[], file: string): TaggedHandler[] {
  const out: TaggedHandler[] = [];
  for (const a of ancestors) {
    if (a.type === "handleBlock") {
      out.push({ block: a, file });
    }
  }
  return out;
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
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
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
      // This walk reads the call site directly rather than going through
      // collectFromBody, so it needs the same rule: a method call in an access
      // chain names a method on a value, not a global function.
      const called = calledName(node, ancestors);
      if (called === null) continue;
      const kinds = interruptEffectsByFunction[called];
      if (!kinds || kinds.length === 0) continue;
      if (isInsideHandler(ancestors)) continue;
      const kindList = kinds.map((entry) => entry.effect).join(", ");
      // The guard construct desugars to a `_guard` call before this
      // walk (guardDesugar.ts); users wrote `guard(...) { }`, so the
      // warning names the construct, not the internal impl.
      const displayName = called === "_guard" ? "guard" : called;
      ctx.errors.push(
        diagnostic("unhandledInterrupts", { fn: displayName, effects: kindList }, node.loc ?? null),
      );
    }
  }
}

// AG3010 (handlerBodyRaises) lived here until handler self-exclusion
// landed: the dispatcher now skips the executing handler entry for its
// own raises, so the recursion the check guarded against cannot happen
// and raising inside a handler body is legal. The registry entry is
// retired, not deleted, so the code stays reserved.

/**
 * Every interrupt effect kind an (inline handler / handle) `body` can raise,
 * transitively — direct raises plus the propagated kinds of everything it calls
 * (via `collectFromBody` + `interruptEffectsByFunction`). The single source of
 * the "what can this body raise" computation, shared by handler-offender
 * detection and handler-param typing (H1).
 */
export function collectRaisableEffects(
  body: AgencyNode[],
  info: ScopeInfo,
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
  ctx: TypeCheckerContext,
): string[] {
  const profile = collectFromBody(body, info.scope, ctx);
  const kinds = [...profile.effects];
  for (const callee of profile.calleeKeys) {
    for (const k of interruptEffectsByFunction[callee] ?? []) {
      addUnique(kinds, k.effect);
    }
  }
  return kinds;
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
 * function. We look that function up in `interruptEffectsByFunction`
 * (transitively populated) and emit an error if it may interrupt.
 */
export function checkCallbackBodyInterrupts(
  scopes: ScopeInfo[],
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
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

      const kinds = interruptEffectsByFunction[fnName];
      if (!kinds || kinds.length === 0) continue;

      const kindList = kinds.map((ik) => ik.effect).join(", ");
      ctx.errors.push(
        diagnostic("interruptInCallback", { hook: hookName, effects: kindList }, node.loc ?? null),
      );
    }
  }
}
