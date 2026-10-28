import { currentRunOrNone, type Run } from "../runtime/asyncContext.js";
import { StatelogParser } from "../eval/statelogParser.js";
import type { EvalRecord, EvalValue } from "../eval/types.js";
import type { StatelogClient } from "../statelogClient.js";
import { resolveDir } from "./resolveDir.js";
import { currentHost } from "../runtime/currentHost.js";
import { agentNameProblem } from "../statelog/agentName.js";

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
 * argument. Each function reads the current run on its
 * first line and emits the corresponding wire event.
 *
 * No-op when called outside an Agency execution frame (e.g. a tool
 * function invoked directly from a test). This is the lenient pattern
 * used by the generated-code accessors in lib/runtime/asyncContext.ts.
 */
function prepareEvalEvent(value: unknown): PreparedEvalEvent | null {
  const frame = currentRunOrNone();
  if (!frame) return null;
  const safeValue = serializeEvalValue(value);
  const threadId = frame.threads.activeId() ?? null;
  return {
    client: frame.log,
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

/** Rejects an invalid name even outside an Agency frame, so a bad name is a
 *  bug at the call site rather than a trace that silently cannot be grouped. */
export async function _setAgentName(name: string): Promise<void> {
  const problem = agentNameProblem(String(name));
  if (problem !== null) {
    throw new Error(`setAgentName: ${problem}`);
  }
  const frame = currentRunOrNone();
  if (!frame) {
    return;
  }
  await frame.log.agentName({ name: String(name) });
}

/** Whether this run's statelog records anything. False when `observability`
 *  is off, which makes every statelog client a no-op, and outside an Agency
 *  frame. */
export function _isLogging(): boolean {
  const frame = currentRunOrNone();
  if (!frame) return false;
  return frame.ctx.getStatelogSink().observability;
}

export async function _evalValue(value: unknown): Promise<void> {
  const prepared = prepareEvalEvent(value);
  if (!prepared) return;
  await prepared.client.evalValueRecorded(prepared.payload);
}

/** The REPLs log a turn for every line a person submits, except a slash
 *  command, which is an instruction to the program and not a message. A
 *  test's stub client may have no `turnStart`, as `ThreadStore` allows for
 *  its thread events. */
export async function logReplTurn(run: Run, line: string): Promise<void> {
  if (line.trimStart().startsWith("/")) {
    return;
  }
  await run.log.turnStart?.({ message: line });
}

/** Logs `turnStart`; a no-op outside an Agency frame, like the eval events. */
export async function _turnStart(message: string): Promise<void> {
  const frame = currentRunOrNone();
  if (!frame) return;
  await frame.log.turnStart({ message: String(message) });
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
  return new StatelogParser(await resolveStatelogPath(statelogPath, allowedPaths)).evalRecord();
}

export async function _evalValues(
  statelogPath: string,
  allowedPaths: string[] = [],
): Promise<EvalValue[]> {
  return new StatelogParser(await resolveStatelogPath(statelogPath, allowedPaths)).evalValues();
}

export async function _evalOutputs(
  statelogPath: string,
  allowedPaths: string[] = [],
): Promise<EvalValue[]> {
  return new StatelogParser(await resolveStatelogPath(statelogPath, allowedPaths)).evalOutputs();
}

export async function _finalEvalOutput(
  statelogPath: string,
  allowedPaths: string[] = [],
): Promise<EvalValue | null> {
  return new StatelogParser(
    await resolveStatelogPath(statelogPath, allowedPaths),
  ).finalEvalOutput();
}

/** Called on the first line of each function above, before any await, so
 *  the host it reads is the current run's. */
function resolveStatelogPath(statelogPath: string, allowedPaths: string[]): Promise<string> {
  const host = currentHost();
  return resolveDir(host, statelogPath, allowedPaths);
}
