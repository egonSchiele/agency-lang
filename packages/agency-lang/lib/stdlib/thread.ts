import * as smoltalk from "smoltalk";
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

export async function __internal_userMessage(
  _ctx: RuntimeContext<any>,
  _stack: StateStack,
  threads: ThreadStore,
  msg: string,
): Promise<void> {
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

export async function __internal_getCost(
  _ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
): Promise<number> {
  return stack.localCost;
}

export async function __internal_getTokens(
  _ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
): Promise<number> {
  return stack.localTokens;
}
