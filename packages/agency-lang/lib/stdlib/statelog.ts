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

export async function _setAgentName(name: string): Promise<void> {
  const frame = agencyStore.getStore();
  if (!frame) {
    return;
  }
  await frame.ctx.statelogClient.agentName({ name: String(name) });
}

/** A printed value larger than this (in UTF-8 bytes) is more likely a mistake
 *  than a labelable output, and is not worth storing as training data. Matches
 *  the label ingest size cap so "labelable" means the same thing everywhere. */
export const PRINT_VALUE_MAX_BYTES = 1_048_576;

/** What an oversized print records instead of its value. A fixed placeholder,
 *  not a prefix: a clipped prefix of a tagged/secret string could slip past
 *  redaction, which matches whole tagged values. */
export const TRUNCATED_PRINT_VALUE = `[print omitted: value exceeded ${PRINT_VALUE_MAX_BYTES} bytes]`;

type PreparedPrintValue = {
  value: string;
  truncated: boolean;
};

function preparePrintValue(value: string): PreparedPrintValue {
  if (Buffer.byteLength(value, "utf8") > PRINT_VALUE_MAX_BYTES) {
    return { value: TRUNCATED_PRINT_VALUE, truncated: true };
  }
  return { value, truncated: false };
}

/**
 * Record a console print in the statelog. No-op outside an execution frame.
 *
 * Fire-and-forget on purpose: logging must not change whether `print` itself
 * succeeds, and it must not await remote I/O on the print path. `post()` owns
 * and reports sink failures, so the returned promise never rejects and needs
 * no `.catch`.
 */
export function recordPrint(kind: "print" | "printJSON", value: string): void {
  const frame = agencyStore.getStore();
  if (!frame) {
    return;
  }
  const prepared = preparePrintValue(value);
  void frame.ctx.statelogClient.printRecorded({
    kind,
    value: prepared.value,
    truncated: prepared.truncated,
    threadId: frame.threads.activeId() ?? null,
  });
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
  return resolveDir(statelogPath, allowedPaths);
}
