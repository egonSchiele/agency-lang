import { AsyncLocalStorage } from "async_hooks";
import type { HandlerEntry } from "./types.js";

/**
 * Which handler entries are executing in this async lineage, innermost
 * last.
 *
 * The dispatcher consults this so a handler never hears its own raises:
 * an interrupt raised while a handler executes skips that entry, and the
 * rest of the chain decides. This is what makes raising interrupts inside
 * handler functions safe — re-entering the raising handler was the only
 * source of the recursion that AG3010 used to ban.
 *
 * ALS because exclusion is a property of the async call tree, not a
 * global. Fork branches share the handler chain — branch B's handler is
 * invoked for branch A's interrupt — so a handler executing in one branch
 * must still hear raises from another. `handlerChainDepthALS` in
 * interrupts.ts relies on the same per-lineage property.
 *
 * Per ENTRY, not per source handler: a recursive function containing a
 * handle block registers one entry per activation, and only the executing
 * activation is skipped. Sibling activations of the same source handler
 * still hear the raise; MAX_HANDLER_CHAIN_DEPTH backstops that shape.
 *
 * This ALS is NOT what keeps pauses out of handlers, and it is never
 * checkpointed. The pause guarantee lives on the stack instead:
 * runHandlerChain mirrors each executing entry into
 * `StateStack.executingHandlerEntries`, the guard-trip machinery refuses
 * to surface while that list is non-empty, and every interrupt-pause
 * checkpoint site asserts it empty (issue #616). The ALS carries only
 * the per-lineage precision that the stack mark cannot: which raises
 * are a handler's OWN. If this ALS ever loses a read, exclusion can
 * misfire (bounded by MAX_HANDLER_CHAIN_DEPTH) — but the run still
 * cannot pause mid-handler, because the pause refusals read the stack.
 */
const executingHandlersALS = new AsyncLocalStorage<HandlerEntry[]>();

/** Run a handler body, recording its entry as executing for the duration. */
export function runAsHandler<T>(
  entry: HandlerEntry,
  fn: () => Promise<T>,
): Promise<T> {
  const current = executingHandlersALS.getStore() ?? [];
  return executingHandlersALS.run([...current, entry], fn);
}

/** The entries executing in this lineage, outermost first. */
export function executingHandlers(): HandlerEntry[] {
  return executingHandlersALS.getStore() ?? [];
}

/** True when any handler body is executing in this lineage. */
export function insideHandlerFunction(): boolean {
  return executingHandlers().length > 0;
}
