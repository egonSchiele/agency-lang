import type { EvalRecord } from "@/eval/types.js";
import { completionOf } from "@/statelog/wireAccessors.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";

import type { Trace } from "./traces.js";

/**
 * A trace's input and output as text, for anything that shows a trace to a
 * person: the labeling screen, `agency runs list`, the "pick a trace" error.
 * One rule for what "the input" and "the output" of a trace are, so every
 * command shows the same thing.
 */

/** The input as text: what `agentStart` recorded when the caller named it,
 *  else the last `evalValue()` (or the extractor's inferred user message);
 *  null when the trace recorded neither. */
export function traceInputText(
  trace: { events: readonly EventEnvelope[] },
  record: EvalRecord,
): string | null {
  const start = trace.events.find((event) => event.data.type === "agentStart");
  const recorded: unknown = start?.data.input;
  const value = recorded !== undefined ? recorded : record.evalValues.at(-1)?.value;
  return asText(value);
}

export type TraceOutputText =
  /** The last recorded output (`evalOutput()` or the entry node's return). */
  | { kind: "output"; text: string }
  /** No output was recorded; this is the last assistant message instead. */
  | { kind: "lastMessage"; text: string }
  | { kind: "none" };

export function traceOutputText(trace: Trace, record: EvalRecord): TraceOutputText {
  const last = record.evalOutputs.at(-1);
  if (last !== undefined) {
    return { kind: "output", text: asText(last.value) ?? "null" };
  }
  const completions = trace.events.filter((event) => event.data.type === "promptCompletion");
  for (let index = completions.length - 1; index >= 0; index -= 1) {
    const text = completionOf(completions[index]);
    if (text !== null) return { kind: "lastMessage", text };
  }
  return { kind: "none" };
}

function asText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}
