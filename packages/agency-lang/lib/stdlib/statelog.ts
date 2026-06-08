import { agencyStore } from "../runtime/asyncContext.js";
import type { StatelogClient } from "../statelogClient.js";

type EvalPayload = {
  value: unknown;
  threadId: string | null;
};

type PreparedEvalEvent = {
  client: StatelogClient;
  payload: EvalPayload;
};

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
function prepareEvalEvent(value: unknown): PreparedEvalEvent | null {
  const frame = agencyStore.getStore();
  if (!frame) return null;
  const safeValue = serializeEvalValue(value);
  const threadId = frame.threads.activeId() ?? null;
  return {
    client: frame.ctx.statelogClient,
    payload: { value: safeValue, threadId },
  };
}

function serializeEvalValue(value: unknown): unknown {
  const json = JSON.stringify(value ?? null);
  if (json === undefined) {
    throw new TypeError(
      "evalInput/evalOutput value must be JSON-serializable; top-level functions and symbols cannot be recorded",
    );
  }
  return JSON.parse(json);
}

export async function _evalInput(value: unknown): Promise<void> {
  const prepared = prepareEvalEvent(value);
  if (!prepared) return;
  await prepared.client.evalInputRecorded(prepared.payload);
}

export async function _evalOutput(value: unknown): Promise<void> {
  const prepared = prepareEvalEvent(value);
  if (!prepared) return;
  await prepared.client.evalOutputRecorded(prepared.payload);
}
