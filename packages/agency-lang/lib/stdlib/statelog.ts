import { agencyStore } from "../runtime/asyncContext.js";
import { StatelogParser } from "../eval/statelogParser.js";
import type { EvalRecord, EvalValue } from "../eval/types.js";
import type { StatelogClient } from "../statelogClient.js";
import { resolveDir } from "./resolveDir.js";

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
      "evalValue/evalOutput value must be JSON-serializable; top-level functions and symbols cannot be recorded",
    );
  }
  return JSON.parse(json);
}

export async function _evalValue(value: unknown): Promise<void> {
  const prepared = prepareEvalEvent(value);
  if (!prepared) return;
  await prepared.client.evalValueRecorded(prepared.payload);
}

export async function _evalOutput(value: unknown): Promise<void> {
  const prepared = prepareEvalEvent(value);
  if (!prepared) return;
  await prepared.client.evalOutputRecorded(prepared.payload);
}

export async function _evalRecord(
  statelogPath: string,
  allowedPaths: string[] = [],
): Promise<EvalRecord> {
  return new StatelogParser(await resolveStatelogPath(statelogPath, allowedPaths))
    .evalRecord();
}

export async function _evalValues(
  statelogPath: string,
  allowedPaths: string[] = [],
): Promise<EvalValue[]> {
  return new StatelogParser(await resolveStatelogPath(statelogPath, allowedPaths))
    .evalValues();
}

export async function _evalOutputs(
  statelogPath: string,
  allowedPaths: string[] = [],
): Promise<EvalValue[]> {
  return new StatelogParser(await resolveStatelogPath(statelogPath, allowedPaths))
    .evalOutputs();
}

export async function _finalEvalOutput(
  statelogPath: string,
  allowedPaths: string[] = [],
): Promise<EvalValue | null> {
  return new StatelogParser(await resolveStatelogPath(statelogPath, allowedPaths))
    .finalEvalOutput();
}

function resolveStatelogPath(
  statelogPath: string,
  allowedPaths: string[],
): Promise<string> {
  return resolveDir(statelogPath, allowedPaths, "cwd");
}
