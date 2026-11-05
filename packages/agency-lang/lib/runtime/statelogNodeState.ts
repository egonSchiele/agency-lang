import { hasInterrupts } from "./isInterrupt.js";

/** Fields of the graph's node state that hold the runtime, not the node's data. */
const RUNTIME_STATE_KEYS = ["ctx", "run"];

/** A node event's state without the runtime. The graph hands each node
 *  `{ messages, data, ctx, isResume, run }`, and `ctx` and `run` both hold
 *  the whole state stack, which no reader of the log uses. */
export function nodeStateForLog(state: unknown): unknown {
  if (state === null || typeof state !== "object") {
    return state;
  }
  const kept = Object.entries(state).filter(([key]) => !RUNTIME_STATE_KEYS.includes(key));
  return Object.fromEntries(kept);
}

/**
 * The last node's state without its return value. A finished run logs that
 * value once, in `agentEnd.result`; logging it here too doubled the largest
 * value of the run. A run that paused keeps its interrupts here, because a
 * paused run writes no `agentEnd` and no other event has them.
 */
export function withoutFinalValue(state: unknown): unknown {
  if (state === null || typeof state !== "object") {
    return state;
  }
  const record = state as Record<string, unknown>;
  if (hasInterrupts(record.data)) {
    return state;
  }
  const { data: _finalValue, ...rest } = record;
  return rest;
}
