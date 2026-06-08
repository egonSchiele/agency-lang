import { agencyStore } from "../runtime/asyncContext.js";
import type { StatelogClient } from "../statelogClient.js";

/** Pick the statelog client method to call for this eval event. */
type EvalEmit = (
  client: StatelogClient,
  payload: { value: unknown; threadId: string | null },
) => Promise<void>;

/**
 * std::statelog TS impls. Called from the agency-side wrappers in
 * stdlib/statelog.agency, which pass through the user's value
 * argument. Each function reads the active AgencyStore from
 * AsyncLocalStorage and emits the corresponding wire event.
 *
 * No-op when called outside an Agency execution frame (e.g. a tool
 * function invoked directly from a test). This is the lenient pattern
 * used by the generated-code accessors in lib/runtime/asyncContext.ts.
 */
async function emitEvalEvent(emit: EvalEmit, value: unknown): Promise<void> {
  const frame = agencyStore.getStore();
  if (!frame) return;
  const safeValue = JSON.parse(JSON.stringify(value ?? null));
  const threadId = frame.threads.activeId() ?? null;
  await emit(frame.ctx.statelogClient, { value: safeValue, threadId });
}

export const _evalInput = (value: unknown) =>
  emitEvalEvent((c, p) => c.evalInputRecorded(p), value);

export const _evalOutput = (value: unknown) =>
  emitEvalEvent((c, p) => c.evalOutputRecorded(p), value);
