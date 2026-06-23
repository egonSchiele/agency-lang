import * as smoltalk from "smoltalk";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import { CostGuard, TimeGuard } from "../runtime/guard.js";
import { normalizeModelUsage, type ModelUsage } from "../runtime/utils.js";
import type { RuntimeContext } from "../runtime/state/context.js";
import type { StateStack } from "../runtime/state/stateStack.js";
import type { ThreadStore } from "../runtime/state/threadStore.js";

/**
 * std::thread TS implementations for the context-injected builtins
 * registered in `lib/codegenBuiltins/contextInjected.ts`. The agency-
 * side wrappers in `stdlib/thread.agency` call these without any of
 * the prefix args; the TypeScript builder prepends `__ctx`,
 * `__stateStack`, and `__threads` at every context-injected call
 * site.
 *
 * - Message builtins (`*Message`) push onto the active thread of the
 *   caller's `__threads` store. They ignore `_stack` and use
 *   `threads.getOrCreateActive()` so messages injected before the first
 *   `llm()` call still land on a real thread (rather than being
 *   silently dropped by `threads.active()?.push(...)`).
 * - Cost / token builtins (`getCost`, `getTokens`) read the per-branch
 *   accumulator from the caller's `__stateStack` (which has been
 *   seeded by `Runner.runForkAll` / `runRace` to inherit parent
 *   totals). They ignore `_ctx` and `_threads`.
 *
 * See docs/superpowers/specs/2026-05-20-thread-builtins-and-stdlib-
 * design.md for the per-branch cost model.
 */

export async function __internal_systemMessage(
  _ctx: RuntimeContext<any>,
  _stack: StateStack,
  threads: ThreadStore,
  msg: string,
): Promise<void> {
  threads.getOrCreateActive().push(smoltalk.systemMessage(msg));
}

/** ALS-reading replacement for `__internal_systemMessage`. */
export async function _systemMessage(msg: string): Promise<void> {
  const { threads } = getRuntimeContext();
  threads.getOrCreateActive().push(smoltalk.systemMessage(msg));
}

export async function __internal_userMessage(
  _ctx: RuntimeContext<any>,
  _stack: StateStack,
  threads: ThreadStore,
  msg: string,
): Promise<void> {
  threads.getOrCreateActive().push(smoltalk.userMessage(msg));
}

/** ALS-reading replacement for `__internal_userMessage`. */
export async function _userMessage(msg: string): Promise<void> {
  const { threads } = getRuntimeContext();
  threads.getOrCreateActive().push(smoltalk.userMessage(msg));
}

export async function __internal_assistantMessage(
  _ctx: RuntimeContext<any>,
  _stack: StateStack,
  threads: ThreadStore,
  msg: string,
): Promise<void> {
  threads.getOrCreateActive().push(smoltalk.assistantMessage(msg));
}

/** ALS-reading replacement for `__internal_assistantMessage`. */
export async function _assistantMessage(msg: string): Promise<void> {
  const { threads } = getRuntimeContext();
  threads.getOrCreateActive().push(smoltalk.assistantMessage(msg));
}

export async function __internal_getCost(
  _ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
): Promise<number> {
  return stack.localCost;
}

/** ALS-reading replacement for `__internal_getCost`. */
export async function _getCost(): Promise<number> {
  const { stack } = getRuntimeContext();
  return stack.localCost;
}

export async function __internal_getTokens(
  _ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
): Promise<number> {
  return stack.localTokens;
}

/** ALS-reading replacement for `__internal_getTokens`. */
export async function _getTokens(): Promise<number> {
  const { stack } = getRuntimeContext();
  return stack.localTokens;
}

export type ModelCost = ModelUsage;

/**
 * Per-model usage breakdown from the global `__tokenStats.models`
 * accumulator (populated by `updateTokenStats` on every LLM call,
 * including subagent/tool branches that pointer-share it). Returned
 * sorted by cost descending so callers can show the priciest model
 * first. Unlike `_getCost`/`_getTokens`, this reads the process-wide
 * total (not the per-branch accumulator), which is the right scope for
 * a `/cost` summary that attributes spend across every model used.
 */
export async function _getModelCosts(): Promise<ModelCost[]> {
  const { ctx } = getRuntimeContext();
  const stats = ctx?.globals?.getTokenStats?.();
  return normalizeModelUsage(stats?.models);
}

/**
 * Open 0..2 guard scopes on the caller's stack, depending on which
 * limits were passed. Returns the count actually pushed so the
 * surrounding `guard` stdlib function knows how many to pop. Either
 * argument may be `null` (meaning "no limit on this dimension"); at
 * least one must be non-null.
 *
 * When both cost and time are set, both guards trip independently —
 * whichever exceeds its limit first throws GuardExceededError. They
 * are pushed in order [cost, time] so popping LIFO returns the time
 * guard first (uninstall ordering doesn't matter for correctness, but
 * matters for the structured guard.uninstall stack-mutation cleanup).
 *
 * See lib/runtime/guard.ts.
 */
function pushGuardImpl(
  stack: StateStack,
  costLimit: number | null,
  timeLimit: number | null,
): string[] {
  if (costLimit == null && timeLimit == null) {
    throw new Error(
      "guard() requires at least one of: cost, time",
    );
  }
  // Return the pushed guards' ids (innermost-last) so the caller can scope a
  // `try` to convert ONLY its own guards' trips (C2 ownedGuardIds). The array
  // length also drives the LIFO pop, replacing the old count.
  const ids: string[] = [];
  if (costLimit != null) {
    const g = new CostGuard(costLimit);
    stack.pushGuard(g);
    ids.push(g.guardId);
  }
  if (timeLimit != null) {
    const g = new TimeGuard(timeLimit);
    stack.pushGuard(g);
    ids.push(g.guardId);
  }
  return ids;
}

export async function __internal_pushGuard(
  _ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  costLimit: number | null,
  timeLimit: number | null,
): Promise<string[]> {
  return pushGuardImpl(stack, costLimit, timeLimit);
}

/** ALS-reading replacement for `__internal_pushGuard`. */
export async function _pushGuard(
  costLimit: number | null,
  timeLimit: number | null,
): Promise<string[]> {
  const { stack } = getRuntimeContext();
  return pushGuardImpl(stack, costLimit, timeLimit);
}

/**
 * Close the most-recently-opened guard scopes on the caller's stack — one
 * per id in `ids`. Paired with `pushGuard`'s returned id array so the caller
 * pops exactly the guards it pushed.
 */
function popGuardImpl(stack: StateStack, ids: string[]): void {
  for (let i = 0; i < ids.length; i++) {
    stack.popGuard();
  }
}

export async function __internal_popGuard(
  _ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  ids: string[],
): Promise<void> {
  popGuardImpl(stack, ids);
}

/** ALS-reading replacement for `__internal_popGuard`. */
export async function _popGuard(ids: string[]): Promise<void> {
  const { stack } = getRuntimeContext();
  popGuardImpl(stack, ids);
}
