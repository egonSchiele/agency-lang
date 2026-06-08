/** A normalized eval record produced from one statelog trace.
 *
 * Deliberately project-agnostic: nothing in this shape knows about
 * specific subagent names (oracle/explorer/code/etc.). Consumers who
 * want semantic identification ("did the oracle fire?") query the
 * thread `label` / `session` fields populated by the runtime.
 *
 * ── Field-presence matrix (recorded during Task 1 Step 2) ─────────
 *
 * | field                                | legacy `statelog.log` | post-Task 0 fresh capture |
 * |--------------------------------------|-----------------------|---------------------------|
 * | threadCreated.label                  | ✗                     | ✓                         |
 * | threadCreated.session                | ✗                     | ✓                         |
 * | threadCreated.hidden                 | ✗                     | ✓                         |
 * | toolCallStart (event type)           | ✗                     | ✓                         |
 * | handlerDecision.interrupt            | ✗                     | ✓                         |
 * | interruptResolved.interrupt          | ✗                     | ✓                         |
 * | promptCompletion.threadId            | ✗                     | ✓                         |
 * | toolCall.threadId                    | ✗                     | ✓                         |
 * | toolCallStart.threadId               | ✗                     | ✓                         |
 * | evalInputRecorded                    | ✗                     | only if agent annotates   |
 * | evalOutputRecorded                   | ✗                     | only if agent annotates   |
 *
 * Legacy traces parse without errors; extraction degrades by leaving
 * the missing fields null and emitting one warning during normalize.
 */
export type EvalRecord = {
  /** trace_id from the source statelog. */
  traceId: string;
  /** Format version of the EvalRecord shape itself (NOT the statelog
   *  format_version). Bump when fields change incompatibly. */
  recordVersion: 2;
  /** Statelog wire-format version, copied from the source envelope
   *  (`events[0].format_version`). Lets consumers reason about which
   *  optional fields they can expect (label, threadId, etc.). */
  formatVersion: number;
  /** Total wall-clock duration in milliseconds, derived from the
   *  first event's timestamp to the last event's timestamp. */
  durationMs: number;
  /** Source file path, for traceability. Always a real path — stdin
   *  input is not supported. */
  source: string;

  /** Values used as eval inputs. Explicit values recorded via
   *  std::statelog.evalInput() are preferred; if absent, the
   *  extractor may synthesize one fallback entry from the last
   *  user-role message of the first promptCompletion on the top-level
   *  thread (warning emitted in `warnings`). Empty only when neither
   *  explicit events nor a heuristic source exists. */
  evalInputs: EvalValue[];

  /** Values used as eval outputs. Explicit values recorded via
   *  std::statelog.evalOutput() are preferred; if absent, the
   *  extractor may synthesize one fallback entry from the last
   *  promptCompletion's completion on the top-level thread (warning
   *  emitted in `warnings`). Empty only when neither explicit events
   *  nor a heuristic source exists. Consumers that want a single
   *  answer usually consume the last element. */
  evalOutputs: EvalValue[];

  /** Every thread observed in the trace. Each `threadCreated` event
   *  becomes one entry. Resumes (`threadResumed`) do NOT create new
   *  entries — they map back to the existing thread by id. */
  threads: ThreadEntry[];

  /** Chronological list of normalized events. The single source of
   *  truth — everything else in this record is a derived aggregation
   *  over this list. */
  events: NormalizedEvent[];

  /** Interrupts that surfaced during the run, with their resolution
   *  outcome. Built from `interruptThrown` / `handlerDecision` /
   *  `interruptResolved` events. Carries the kind/message/data so
   *  consumers can see what was approved/rejected without
   *  correlating manually. */
  interrupts: InterruptEntry[];

  /** Errors raised during the run. */
  errors: ErrorEntry[];

  /** Tool invocations that started (`toolCallStart`) but never
   *  emitted a matching `toolCall` end event. Almost always means
   *  the run was killed or aborted mid-tool. */
  incomplete: IncompleteInvocation[];

  /** Coarse-grained aggregations for quick scanning. NOT meant to be
   *  authoritative — anything load-bearing should be re-derived from
   *  `events` by the consumer. */
  metrics: Metrics;

  /** Warnings the extractor emitted while processing this trace
   *  (e.g. unknown event types, missing fields, suspicious shapes). */
  warnings: string[];
};

export type ThreadEntry = {
  threadId: string;
  threadType: "thread" | "subthread";
  parentThreadId: string | null;
  /** From `thread(label: "...")`. The most useful semantic tag. */
  label: string | null;
  /** From `thread(session: "...")`. Only populated on first create
   *  of a session; resumes don't re-emit. */
  session: string | null;
  hidden: boolean;
  /** Milliseconds since trace start (NOT epoch). */
  createdAtMs: number;
};

/** Fields every normalized event carries, regardless of `kind`. Kept
 *  as a single base type so we don't repeat them across each variant
 *  and so consumers can write helpers that operate on the common
 *  shape (e.g. `function timeOf(e: NormalizedEventBase) {...}`). */
export type NormalizedEventBase = {
  tMs: number;
  threadId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
};

/** One step in the chronological tool-call / LLM-call sequence. */
export type NormalizedEvent =
  | (NormalizedEventBase & {
    kind: "llm";
    model: string;
    /** Tool names available to this LLM call. Useful for
     *  fingerprinting an agent when thread labels are absent. */
    tools: string[];
    durationMs: number | null;
    costUsd: number | null;
    tokensIn: number | null;
    tokensOut: number | null;
  })
  | (NormalizedEventBase & {
    kind: "tool_start";
    /** Sourced from `toolCallStart.data.toolName`. */
    tool: string;
    argsPreview: string;
    model: string | null;
  })
  | (NormalizedEventBase & {
    kind: "tool_end";
    /** Sourced from `toolCall.data.toolName`. */
    tool: string;
    outputPreview: string;
    durationMs: number | null;
  });

export type InterruptEntry = {
  interruptId: string;
  /** From the interrupt summary attached to handlerDecision /
   *  interruptResolved by the runtime. Null on older traces. */
  kind: string | null;
  message: string | null;
  /** Full data payload as it was on the interrupt object. May be
   *  large — consumers should preview, not log verbatim. */
  data: unknown;
  outcome: "approved" | "rejected" | "propagated" | "unresolved";
  resolvedBy: "handler" | "user" | "policy" | "ipc" | null;
  thrownAtMs: number | null;
  resolvedAtMs: number | null;
};

export type ErrorEntry = {
  tMs: number;
  errorType: string;
  message: string;
  spanId: string | null;
};

export type IncompleteInvocation = {
  tool: string;
  startedAtMs: number;
  spanId: string | null;
  /** The thread that called the tool, if resolvable. */
  threadId: string | null;
};

export type Metrics = {
  llmCalls: number;
  toolStarts: number;
  toolEnds: number;
  /** Distinct model strings observed, deduped and sorted ascending
   *  for diff-friendly snapshots. */
  models: string[];
  /** Sum of input tokens across all `promptCompletion` events,
   *  reading `data.usage.inputTokens` (zero if absent). */
  tokensInTotal: number;
  /** Sum of `data.usage.outputTokens` across all promptCompletion
   *  events (zero if absent). */
  tokensOutTotal: number;
  /** Sum of `data.cost.totalCost` across all promptCompletion events.
   *  Treated as USD — `lib/runtime/prompt.ts` records cost in dollars. */
  costUsdTotal: number;
  /** Count of tool END events (`toolCall`) per tool name. Does NOT
   *  count incomplete `toolCallStart`s — those live in `incomplete`. */
  toolCounts: Record<string, number>;
};

/** One firing of `evalInput(...)` or `evalOutput(...)` from agent
 *  code, plus enough provenance for consumers to filter by thread
 *  (e.g. drop subagent firings) or correlate with the event timeline.
 *  `tMs` is derived from the envelope timestamp at extract time, not
 *  emitted on the wire. `value` is whatever the agent passed —
 *  already JSON-round-tripped at the stdlib boundary, may be
 *  truncated by the extractor if it exceeds STATELOG_EVAL_MAX_VALUE_BYTES
 *  (in which case `truncated: true` is set; otherwise omitted). */
export type EvalValue = {
  value: unknown;
  threadId: string | null;
  tMs: number;
  truncated?: true;
};
