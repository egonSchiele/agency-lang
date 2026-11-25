import type { DecisionAnswer, DecisionQuestion, DecisionState } from "smoltalk";
import { z } from "zod";

// Wire format produced by StatelogClient.post(). Mirrors the envelope
// shape we read from the JSONL file; do NOT depend on the runtime
// SpanContext type here — consumers (logsViewer, eval) must compile
// and run from any JSONL without the runtime loaded.
//
// Lives in `lib/statelog/` rather than `lib/logsViewer/` so the eval
// module (a peer of the viewer, not a dependent) can import these
// types without pulling in viewer internals. The viewer's
// `lib/logsViewer/types.ts` re-exports these.
/** The kinds of `error` event `StatelogClient.error` writes. */
export type StatelogErrorType =
  | "toolError"
  | "llmError"
  | "runtimeError"
  | "validationError"
  | "limitExceeded"
  | "structuredOutput"
  | "replyCutOff"
  | "droppedToolCall"
  | "finalizeError";

/** The kinds of `warn` event `StatelogClient.warn` writes. */
export type StatelogWarnType =
  | "failurePropagation"
  | "toolSchemaSize"
  | "failureData"
  | "decisionBatchCap"
  | "endTurn"
  | "replyCutOff";

export type EventEnvelope = {
  format_version: number;
  trace_id: string;
  project_id: string;
  span_id: string | null;
  parent_span_id: string | null;
  data: EventData;
};

/** On a `promptCompletion` from a decision model: what the model was sent
 *  and what it answered. The state is the thread as the model read it
 *  (each message's text and each tool result), the questions are what the
 *  response type became,
 *  and the answers are the model's reply before it was turned back into a
 *  value. Absent on a text call. The three parts reuse smoltalk's decision
 *  types so the log and the wire protocol cannot drift apart. */
export type DecisionLog = {
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  answers: Record<string, DecisionAnswer>;
};

/** The writer fields a `promptCompletion` on a thread with an identity
 *  carries. See "Messages: full copies and changes" in
 *  docs/dev/hosting/statelog.md. */
export const WriterFieldsSchema = z.object({
  logWriter: z.string(),
  threadCall: z.number().int().positive(),
});

/** A `promptCompletion` that logs its thread's whole message list. */
export const FullCopyFieldsSchema = WriterFieldsSchema.extend({
  messages: z.array(z.unknown()),
});
export type FullCopyFields = z.infer<typeof FullCopyFieldsSchema>;

/** A `promptCompletion` whose first `keptMessages` messages are the same as
 *  in this writer's previous call on the thread, and `newMessages` follow
 *  them. A change always keeps at least one message. */
export const ChangeFieldsSchema = WriterFieldsSchema.extend({
  keptMessages: z.number().int().positive(),
  newMessages: z.array(z.unknown()),
});
export type ChangeFields = z.infer<typeof ChangeFieldsSchema>;

export type EventData = {
  type: string;
  timestamp: string;
  // Untyped by design (see above). Notable fields for consumers:
  //   agentStart: `entryNode`, `args`, optional `input` (what the entry node
  //   was given, when the caller named it) and optional `code`
  //   ({ entry, closureHash, closure: [{ file, sha256 }] } — which code ran).
  [key: string]: any;
};
