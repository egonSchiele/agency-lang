/**
 * Compile-time rules for what's allowed inside a `static const`
 * initializer or `static <bare>` top-level statement (Phase A).
 *
 * These rules complement PR 1's runtime read-before-init trap and
 * PR 2's `StaticReferencesGlobalError`. They surface the most common
 * misuses as TypeCheckError entries on the typechecker, so users see
 * actionable messages before they hit runtime.
 *
 * **Direct-only by design.** The rules in this file walk the static
 * initializer's *own* AST subtree. They do NOT follow user-defined
 * helper functions — `static const x = myHelper()` where
 * `myHelper()` itself calls `llm()` is not flagged here. That trade-
 * off matches PR 2.5's depth-1 dep-graph philosophy: the runtime
 * trap catches the rest. Sound interprocedural analysis is
 * intentionally out of scope for this redesign.
 *
 * **Two surfaces, same rules.** Both `static const x = expr` and
 * `static <bare>` are validated. The driver in `validateStaticInit.ts`
 * spots both via the AST shape (Assignment with `static: true` and
 * `staticStatement` respectively) and runs the same rule set against
 * the inner expression / statement.
 */
import { diagnostic } from "./diagnostics.js";
import type { AgencyNode, Expression } from "../types.js";
import type { TypeCheckError } from "./types.js";
import { walkNodes } from "../utils/node.js";

/**
 * Per-run primitives that need an execution context to run. Calling
 * any of these from a `static` initializer (which runs once at
 * process startup, before any agent run has begun) is a logic error
 * — there is no per-run ctx, no thread, no checkpoint store, no LLM
 * client wired up yet.
 *
 * `interrupt` lives on this list as a *function name* even though
 * the parser usually emits an `interruptStatement` node — a bare
 * call like `interrupt("foo")` could parse as either depending on
 * surrounding shape, so we check both. See `checkInterruptStatement`
 * below for the statement form.
 */
export const BANNED_BUILTINS_IN_STATIC_INIT: Record<string, string> = {
  llm: "`llm()` requires a per-run execution context",
  chat: "`chat()` requires a per-run execution context",
  interrupt: "`interrupt(...)` pauses the per-run execution stack",
  respondToInterrupts:
    "`respondToInterrupts()` operates on per-run interrupt state",
  rewindFrom: "`rewindFrom()` operates on per-run checkpoint state",
  runBatch: "`runBatch()` schedules per-run agent invocations",
  callback: "`callback(...)` binds a hook into the per-run callback table",
  emit: "`emit(...)` writes to per-run trace state",
  thread: "`thread { ... }` opens a per-run conversation thread",
};

/**
 * Walk a static initializer expression (or bare statement) and emit
 * a diagnostic for each direct call to a banned builtin. Does NOT
 * descend into nested `function` / `graphNode` bodies — those run
 * later, in per-run ctx, so calls there are fine. Matches the
 * ancestor-check pattern used by `collectFreeIdentifiers` in
 * `lib/compiler/initDepGraph.ts`.
 *
 * `contextLabel` is the human-readable subject of the diagnostic
 * (e.g. "static const 'prompt'" or "the `static greet()` bare
 * statement"). Used as the lead of the error message so the user
 * sees what part of their code is being rejected.
 */
export function checkBannedBuiltinCalls(
  expr: Expression | AgencyNode,
  contextLabel: string,
): TypeCheckError[] {
  const errors: TypeCheckError[] = [];
  for (const { node, ancestors } of walkNodes([expr as AgencyNode])) {
    if (
      ancestors.some(
        (a) => a.type === "function" || a.type === "graphNode",
      )
    ) {
      continue;
    }
    if (node.type === "functionCall") {
      const reason = BANNED_BUILTINS_IN_STATIC_INIT[node.functionName];
      if (reason) {
        errors.push(
          diagnostic(
            "bannedBuiltinInStaticInit",
            { contextLabel, builtin: node.functionName, reason },
            node.loc ?? null,
          ),
        );
      }
      continue;
    }
    if (node.type === "interruptStatement") {
      errors.push(
        diagnostic("interruptInStaticInit", { contextLabel }, node.loc ?? null),
      );
    }
  }
  return errors;
}

/**
 * Names of mutating method calls we recognise on common collection
 * shapes. Used by `checkStaticMutation` to spot `staticArr.push(...)`
 * — the simplest detectable form of post-declaration mutation
 * against a deep-frozen static.
 *
 * Not exhaustive — only the most-likely-to-bite cases. Statics are
 * `__deepFreeze`d at init time, so any actual mutation throws a
 * clean `TypeError` at runtime; this list is a compile-time fast
 * path for the most common user mistake.
 */
const MUTATING_METHODS: Record<string, true> = {
  push: true,
  pop: true,
  shift: true,
  unshift: true,
  splice: true,
  sort: true,
  reverse: true,
  fill: true,
  copyWithin: true,
  set: true,
  delete: true,
  clear: true,
  add: true,
};

/**
 * Decide whether a top-level node is a post-declaration mutation
 * against one of the known static names, and produce a diagnostic if
 * so. Two shapes are detected:
 *
 *   1. `staticName = ...` — a bare assignment whose target is a
 *      known static, where the assignment is NOT itself the static's
 *      declaration. Mutations inside nested `node` / `function`
 *      bodies are NOT checked here; the type-checker already rejects
 *      reassignment of any `const` via `constReassignment`, so the
 *      mutation case for statics inside per-run code is covered.
 *   2. `staticName.<mutatingMethod>(...)` — a top-level method call
 *      on a known static using one of the names listed in
 *      `MUTATING_METHODS`. Compile-time best-effort; runtime
 *      `__deepFreeze` is still the source of truth.
 *
 * Caller is responsible for filtering to top-level nodes; this
 * helper does not walk recursively. Same shape as PR 2's
 * `nodeFromTopLevel` so the validator can drive both with one loop.
 */
export function checkStaticMutation(
  node: AgencyNode,
  staticNames: Record<string, true>,
): TypeCheckError | null {
  // Assignment shape: `x = ...` where x is a known static and the
  // node is NOT a `const`/`let` declaration (those introduce a new
  // binding, not mutate the static).
  if (node.type === "assignment") {
    if (node.declKind) return null;
    if (!staticNames[node.variableName]) return null;
    return diagnostic(
      "staticReassignedAtTopLevel",
      { name: node.variableName },
      node.loc ?? null,
    );
  }
  // Method-call shape: `x.push(...)` at top level.
  if (node.type === "valueAccess") {
    if (node.base.type !== "variableName") return null;
    const name = (node.base as { value: string }).value;
    if (!staticNames[name]) return null;
    for (const elem of node.chain) {
      if (elem.kind !== "methodCall") continue;
      const methodName = elem.functionCall.functionName;
      if (!MUTATING_METHODS[methodName]) continue;
      return diagnostic(
        "staticMutatedViaMethod",
        { name, method: methodName },
        node.loc ?? null,
      );
    }
  }
  return null;
}
