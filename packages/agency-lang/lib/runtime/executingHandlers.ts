import { agencyStore, requireFrame } from "./asyncContext.js";
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
 * The list lives on the frame, in `executingHandlers`, because exclusion is
 * a property of the async call tree, not a global. Fork branches share the
 * handler chain — branch B's handler is invoked for branch A's interrupt —
 * so a handler executing in one branch must still hear raises from another.
 * `handlerChainDepth` in interrupts.ts relies on the same per-lineage
 * property.
 *
 * Per ENTRY, not per source handler: a recursive function containing a
 * handle block registers one entry per activation, and only the executing
 * activation is skipped. Sibling activations of the same source handler
 * still hear the raise; MAX_HANDLER_CHAIN_DEPTH backstops that shape.
 *
 * This list is NOT what keeps pauses out of handlers, and it is never
 * checkpointed. The pause guarantee lives on the stack instead:
 * runHandlerChain mirrors each executing entry into
 * `StateStack.executingHandlerEntries`, the guard-trip machinery refuses
 * to surface while that list is non-empty, and every interrupt-pause
 * checkpoint site asserts it empty (issue #616). The frame carries only
 * the per-lineage precision that the stack mark cannot: which raises
 * are a handler's OWN.
 *
 * Every function here throws when there is no frame. Reading "no frame" as
 * an empty list would send an interrupt back to the handler that raised it.
 */

/** Run a handler body, recording its entry as executing for the duration. */
export function runAsHandler<T>(entry: HandlerEntry, fn: () => Promise<T>): Promise<T> {
  const frame = requireFrame("runAsHandler()");
  return agencyStore.run({ ...frame, executingHandlers: [...frame.executingHandlers, entry] }, fn);
}

/** The entries executing in this lineage, outermost first. */
export function executingHandlers(): HandlerEntry[] {
  return requireFrame("executingHandlers()").executingHandlers;
}

/** True when any handler body is executing in this lineage. */
export function insideHandlerFunction(): boolean {
  return executingHandlers().length > 0;
}
