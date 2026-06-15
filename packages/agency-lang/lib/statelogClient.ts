import * as fs from "fs";
import * as path from "path";
import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "nanoid";
import { ModelName } from "smoltalk";
import { JSONEdge } from "./types.js";

// Bump this when the wire format changes in a way the viewer needs
// to notice. The viewer rejects files with a higher version.
export const STATELOG_FORMAT_VERSION = 1;

// === Span model ===

export type SpanType =
  | "agentRun"
  | "nodeExecution"
  | "llmCall"
  | "toolExecution"
  | "forkAll"
  | "race"
  | "handlerChain"
  // Embedding-vector requests. Distinct from `llmCall` so cost
  // roll-ups in the viewer don't conflate chat-completion cost with
  // embedding cost, and so embeddings are filterable on their own.
  | "embedding"
  // Memory-subsystem umbrella spans. Each one wraps a single
  // user-facing memory operation; the inner `llmCall`/`embedding`
  // spans nest underneath via AsyncLocalStorage so a viewer can
  // collapse the whole operation into one row.
  | "memoryRemember"
  | "memoryRecall"
  | "memoryForget"
  | "memoryCompaction";

export type SpanContext = {
  spanId: string;
  parentSpanId: string | null;
  spanType: SpanType;
  startTime: number;
};

// === Config ===

export type RunMetadata = {
  tags?: string[];
  environment?: string;
  userId?: string;
  agentVersion?: string;
  custom?: Record<string, string>;
};

export type StatelogConfig = {
  host: string;
  traceId?: string;
  apiKey: string;
  projectId: string;
  debugMode: boolean;
  metadata?: RunMetadata;
  observability?: boolean;
  // Append every event as a JSON line to this file path. Intended for
  // local development and tests. Mutually compatible with host/stdout —
  // events are written to all configured sinks.
  logFile?: string;
  /**
   * Per-request timeout (milliseconds) applied to the remote http POST.
   * Prevents a slow/unreachable statelog host from wedging the agent's
   * end-of-run cleanup. Default: 1500ms.
   */
  requestTimeoutMs?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 1500;

// === Token / cost types ===

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
};

export type TokenCost = {
  inputCost?: number;
  outputCost?: number;
  totalCost?: number;
};

// === Client ===

// Shared empty stack returned by `snapshotStack()` when the client is
// disabled. Reusing one frozen array avoids per-fork allocations in the
// default no-op mode. The runner only ever reads from this snapshot
// (passes it back into `runInBranchContext`), never mutates it.
const EMPTY_STACK: ReadonlyArray<SpanContext> = Object.freeze([]) as ReadonlyArray<SpanContext>;

export class StatelogClient {
  private host: string;
  private debugMode: boolean;
  private traceId: string;
  private apiKey: string;
  private projectId: string;
  private logFile?: string;
  private enabled: boolean = true;
  // Whether the remote http sink is usable. A configured host with no
  // apiKey disables ONLY the remote send; local sinks (logFile, stdout)
  // still receive events.
  private remoteEnabled: boolean = false;
  // In-flight remote POSTs. Each event's network round-trip is fired
  // without being awaited (so execution never blocks on telemetry), and
  // tracked here so `flush()` can drain them at the end of a run before
  // the process exits.
  private inFlight: Set<Promise<unknown>> = new Set();
  // The "root" span stack — used by the outer agent run thread. Code
  // running inside `runInBranchContext` sees a branch-local stack
  // delivered via AsyncLocalStorage instead.
  private rootStack: SpanContext[] = [];
  // Per-branch span stacks live in this AsyncLocalStorage. Each concurrent
  // fork/race branch gets its own stack so its `startSpan`/`endSpan`
  // calls never bleed into the parent or siblings — even though they all
  // share this single StatelogClient instance.
  private spanStorage = new AsyncLocalStorage<SpanContext[]>();
  private metadata?: RunMetadata;
  private requestTimeoutMs: number;

  constructor(config: StatelogConfig) {
    const { host, apiKey, projectId, traceId, debugMode } = config;
    this.host = host;
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.debugMode = debugMode || false;
    this.traceId = traceId || nanoid();
    this.logFile = config.logFile;
    this.requestTimeoutMs =
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    this.metadata = config.metadata;

    // Observability must be explicitly enabled. When false (the default),
    // the entire client is a no-op — no events emitted, no network calls,
    // no file writes.
    if (!config.observability) {
      this.enabled = false;
      return;
    }

    if (this.debugMode) {
      console.log(
        `Statelog client initialized with host: ${host} and traceId: ${this.traceId}`,
        { config },
      );
    }

    // Decide whether the remote sink is usable. The remote sink (any
    // host that isn't "stdout") requires an apiKey. If the host is set
    // but the key is missing, we keep the client enabled (so local
    // sinks still work) but skip the http POST inside `post()`.
    const hostLower = this.host.toLowerCase();
    const isRemoteHost = !!this.host && hostLower !== "stdout";
    if (isRemoteHost) {
      if (this.apiKey) {
        this.remoteEnabled = true;
      } else if (this.debugMode) {
        console.warn(
          "StatelogClient: remote host configured without apiKey — remote sink disabled. Local sinks (stdout/logFile) will still receive events.",
        );
      }
    }

    // If a logFile is configured, ensure the parent directory exists.
    // We don't truncate here — each run uses its own runId as traceId,
    // so multiple runs writing to the same file are still distinguishable.
    if (this.logFile) {
      try {
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      } catch (err) {
        if (this.debugMode)
          console.warn(`StatelogClient: failed to ensure logFile dir: ${err}`);
      }
    }
  }

  // === Span management ===
  //
  // Spans are tracked per-async-context. Outside fork/race branches the
  // active stack is `rootStack`. Inside `runInBranchContext` it is the
  // per-branch stack delivered by `spanStorage`. This means concurrent
  // branches each get a private stack — their `startSpan`/`endSpan`
  // calls cannot interleave or pop each other's spans, and events
  // emitted inside a branch are attributed to that branch's current
  // span (which inherits the parent fork span at branch entry).
  private currentStack(): SpanContext[] {
    return this.spanStorage.getStore() ?? this.rootStack;
  }

  // Returns a shallow snapshot of the active span stack — used by the
  // runner to seed each branch's stack with the parent's spans so
  // events inside the branch nest under the fork/race span.
  //
  // Short-circuits to a shared empty array when observability is off
  // so the runner can call this unconditionally without paying for an
  // allocation on every fork/race in the no-op default mode.
  snapshotStack(): SpanContext[] {
    if (!this.enabled) return EMPTY_STACK as SpanContext[];
    return [...this.currentStack()];
  }

  // Run `fn` with a fresh, branch-local span stack seeded from
  // `parentStack`. Each call to this method creates an independent ALS
  // context; sibling calls (e.g. concurrent fork branches) see
  // independent stacks even though they share this StatelogClient.
  //
  // Spans pushed inside `fn` are popped against this private stack only,
  // never the parent. Defensively copies `parentStack` so the caller's
  // array is never mutated.
  //
  // When observability is disabled the ALS plumbing is skipped entirely
  // — we just invoke `fn()` directly. The runner can therefore always
  // wrap branches in this call without paying ALS overhead in no-op
  // mode.
  runInBranchContext<T>(
    parentStack: SpanContext[],
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) return fn();
    return this.spanStorage.run([...parentStack], fn);
  }

  startSpan(type: SpanType): string | undefined {
    if (!this.enabled) return undefined;
    const stack = this.currentStack();
    const spanId = nanoid(12);
    const parentSpanId = stack.length > 0 ? stack[stack.length - 1].spanId : null;
    stack.push({
      spanId,
      parentSpanId,
      spanType: type,
      startTime: performance.now(),
    });
    return spanId;
  }

  // Pop the span identified by `spanId` from the active stack. The id
  // MUST be the one returned by the matching `startSpan` call:
  //
  //   const id = client.startSpan("agentRun");
  //   try { ... } finally { client.endSpan(id); }
  //
  // - If `spanId` is undefined, this is a no-op.
  // - If the span is at the top of the active stack, it pops it directly.
  // - Otherwise we drop everything above the matched span — this
  //   defends against an inner span that forgot to call `endSpan`.
  // - If the span isn't found in the active stack, this is a no-op.
  //   That can legitimately happen when a branch tries to end a span
  //   that lives on the parent's stack, or vice versa.
  endSpan(spanId?: string): SpanContext | undefined {
    if (!this.enabled || !spanId) return undefined;
    const stack = this.currentStack();
    const top = stack[stack.length - 1];
    if (top && top.spanId === spanId) {
      return stack.pop();
    }
    const idx = stack.findIndex((s) => s.spanId === spanId);
    if (idx < 0) return undefined;
    const popped = stack[idx];
    stack.length = idx;
    return popped;
  }

  get currentSpan(): SpanContext | undefined {
    const stack = this.currentStack();
    return stack.length > 0 ? stack[stack.length - 1] : undefined;
  }

  toJSON() {
    return {
      traceId: this.traceId,
      projectId: this.projectId,
      host: this.host,
      debugMode: this.debugMode,
    };
  }

  // === Existing event methods ===

  async debug(message: string, data: any): Promise<void> {
    await this.post({
      type: "debug",
      message: message,
      data,
    });
  }

  async graph({
    nodes,
    edges,
    startNode,
  }: {
    nodes: string[];
    edges: Record<string, JSONEdge>;
    startNode?: string;
  }): Promise<void> {
    await this.post({
      type: "graph",
      nodes,
      edges,
      startNode,
    });
  }

  async enterNode({
    nodeId,
    data,
  }: {
    nodeId: string;
    data: any;
  }): Promise<void> {
    await this.post({
      type: "enterNode",
      nodeId,
      data,
    });
  }

  async exitNode({
    nodeId,
    data,
    timeTaken,
  }: {
    nodeId: string;
    data: any;
    timeTaken?: number;
  }): Promise<void> {
    await this.post({
      type: "exitNode",
      nodeId,
      data,
      timeTaken,
    });
  }

  async beforeHook({
    nodeId,
    startData,
    endData,
    timeTaken,
  }: {
    nodeId: string;
    startData: any;
    endData: any;
    timeTaken?: number;
  }): Promise<void> {
    await this.post({
      type: "beforeHook",
      nodeId,
      startData,
      endData,
      timeTaken,
    });
  }

  async afterHook({
    nodeId,
    startData,
    endData,
    timeTaken,
  }: {
    nodeId: string;
    startData: any;
    endData: any;
    timeTaken?: number;
  }): Promise<void> {
    await this.post({
      type: "afterHook",
      nodeId,
      startData,
      endData,
      timeTaken,
    });
  }

  async followEdge({
    fromNodeId,
    toNodeId,
    isConditionalEdge,
    data,
  }: {
    fromNodeId: string;
    toNodeId: string;
    isConditionalEdge: boolean;
    data: any;
  }): Promise<void> {
    await this.post({
      type: "followEdge",
      edgeId: `${fromNodeId}->${toNodeId}`,
      fromNodeId,
      toNodeId,
      isConditionalEdge,
      data,
    });
  }

  async promptCompletion({
    messages,
    completion,
    model,
    timeTaken,
    tools,
    responseFormat,
    usage,
    cost,
    finishReason,
    stream,
    threadId,
  }: {
    messages: any[];
    completion: any;
    model?: ModelName | string;
    timeTaken?: number;
    tools?: {
      name: string;
      description?: string;
      schema: any;
    }[];
    responseFormat?: any;
    usage?: TokenUsage;
    cost?: TokenCost;
    finishReason?: string;
    stream?: boolean;
    /** Registry id of the thread that issued this LLM call. Stamped
     *  here so downstream eval / log tools can attribute the call to
     *  a thread without walking the span tree (which doesn't link
     *  promptCompletion back to threadCreated). Null when the caller
     *  has no active thread (rare — only at the very start of a run). */
    threadId?: string | null;
  }): Promise<void> {
    await this.post({
      type: "promptCompletion",
      messages,
      completion,
      model,
      timeTaken,
      tools,
      responseFormat,
      usage,
      cost,
      finishReason,
      stream,
      threadId: threadId ?? null,
    });
  }

  /**
   * Emit an `embedCompletion` event. Mirrors `promptCompletion` so the
   * viewer can render the two with a shared formatter, but keeps the
   * embedding-specific bits (dimensions, phase tag) separate.
   *
   * `inputPreview` is intentionally a short slice of the source text —
   * the full text is kept off the wire so a transcript-with-PII never
   * ends up in a remote sink by accident. Vectors are NEVER logged
   * (only their length, via `dimensions`).
   */
  async embedCompletion({
    inputPreview,
    inputCount,
    model,
    dimensions,
    timeTaken,
    usage,
    cost,
    phase,
  }: {
    /** First ~200 chars of the embedded text, for human-readable tracing. */
    inputPreview: string;
    /** Number of input strings in the batch. Currently always 1 from
     *  memory; left as a count so future batching changes don't
     *  require a schema bump. */
    inputCount: number;
    /** Embedding model name (e.g. "text-embedding-3-small"). */
    model?: string;
    /** Vector length. Useful for catching index-vs-query model
     *  mismatches at trace time without comparing the full vectors. */
    dimensions?: number;
    /** Wall-clock latency in ms (caller measures via `performance.now`). */
    timeTaken?: number;
    /** Optional provider-reported usage. Not all embed providers
     *  return these; absent values stay undefined. */
    usage?: TokenUsage;
    cost?: TokenCost;
    /** Free-form tag identifying the caller — e.g. "recall-query",
     *  "new-observation". Lets a viewer filter "embed for recall"
     *  vs "embed for storage" without parsing the parent span tree. */
    phase?: string;
  }): Promise<void> {
    await this.post({
      type: "embedCompletion",
      inputPreview,
      inputCount,
      model,
      dimensions,
      timeTaken,
      usage,
      cost,
      phase,
    });
  }

  /**
   * Memory umbrella-span marker events.
   *
   * Why these exist: the logs viewer infers span types from EVENT
   * types (see `lib/logsViewer/tree.ts#inferSpanLabel`). A span that
   * never has an event posted with its own `span_id` is invisible to
   * the viewer — its children get re-parented to the trace root.
   *
   * Calling `startSpan("memoryRemember")` only sets up the AsyncLocal-
   * Storage stack; on its own it produces no event. These methods
   * post a tiny marker event right after `startSpan` so the span
   * materializes in the tree with the right label, and the inner
   * `llmCall` / `embedding` spans nest under it. The payload is also
   * useful in its own right (content/query preview, memoryId).
   */
  async memoryRemember({
    contentPreview,
    memoryId,
  }: {
    /** First ~N chars of the content being remembered. */
    contentPreview: string;
    /** Active memory scope (from `setMemoryId`, defaults to "default"). */
    memoryId: string;
  }): Promise<void> {
    await this.post({
      type: "memoryRemember",
      contentPreview,
      memoryId,
    });
  }

  async memoryRecall({
    queryPreview,
    memoryId,
    phase,
  }: {
    /** First ~N chars of the recall query. */
    queryPreview: string;
    memoryId: string;
    /** "recall" for the user-facing tier-3 call, "recallForInjection"
     *  for the auto-injection variant. Lets the viewer distinguish
     *  the two without inspecting the parent span tree. */
    phase: "recall" | "recallForInjection";
  }): Promise<void> {
    await this.post({
      type: "memoryRecall",
      queryPreview,
      memoryId,
      phase,
    });
  }

  async memoryForget({
    queryPreview,
    memoryId,
  }: {
    queryPreview: string;
    memoryId: string;
  }): Promise<void> {
    await this.post({
      type: "memoryForget",
      queryPreview,
      memoryId,
    });
  }

  async memoryCompaction({
    memoryId,
    messageCount,
    threshold,
  }: {
    memoryId: string;
    /** Number of messages in the thread that triggered compaction. */
    messageCount: number;
    /** Threshold the count was checked against (so a viewer can show
     *  how close to the trigger this run was). */
    threshold: number;
  }): Promise<void> {
    await this.post({
      type: "memoryCompaction",
      memoryId,
      messageCount,
      threshold,
    });
  }

  /** Fired immediately before a tool is invoked. Paired with `toolCall`
   *  (which fires on tool completion). Consumers can use the pair to
   *  detect tool calls that started but never finished — e.g. when the
   *  user cancels the current run mid-tool. The two events share the
   *  same `span_id` (the toolExecution span). Designed to be
   *  OTEL-compatible: an OTLP aggregator can merge the start + end
   *  events into a single span using start_time + end_time. */
  async toolCallStart({
    toolName,
    args,
    model,
    threadId,
  }: {
    toolName: string;
    args: any;
    model?: ModelName;
    /** Registry id of the thread that issued the LLM call which is
     *  invoking this tool. Stamped here so downstream tools can
     *  attribute the tool call to a thread without walking the span
     *  tree. Null when no active thread is known. */
    threadId?: string | null;
  }): Promise<void> {
    await this.post({
      type: "toolCallStart",
      toolName,
      args,
      model,
      threadId: threadId ?? null,
    });
  }

  async toolCall({
    toolName,
    args,
    output,
    model,
    timeTaken,
    threadId,
  }: {
    toolName: string;
    args: any;
    output: any;
    model?: ModelName;
    timeTaken?: number;
    /** Registry id of the thread that issued the LLM call which is
     *  invoking this tool. See `toolCallStart` for rationale. */
    threadId?: string | null;
  }): Promise<void> {
    await this.post({
      type: "toolCall",
      toolName,
      args,
      output,
      model,
      timeTaken,
      threadId: threadId ?? null,
    });
  }

  async evalInputRecorded({
    value,
    threadId,
  }: {
    value: unknown;
    threadId: string | null;
  }): Promise<void> {
    await this.post({
      type: "evalInputRecorded",
      value,
      threadId: threadId ?? null,
    });
  }

  async evalOutputRecorded({
    value,
    threadId,
  }: {
    value: unknown;
    threadId: string | null;
  }): Promise<void> {
    await this.post({
      type: "evalOutputRecorded",
      value,
      threadId: threadId ?? null,
    });
  }

  async diff({
    itemA,
    itemB,
    message,
  }: {
    itemA: any;
    itemB: any;
    message?: string;
  }): Promise<void> {
    await this.post({
      type: "diff",
      itemA,
      itemB,
      message,
    });
  }

  // === New event methods ===

  async runMetadata(metadata: RunMetadata & {
    moduleName?: string;
    entryNode?: string;
  }): Promise<void> {
    await this.post({
      type: "runMetadata",
      ...metadata,
    });
  }

  async agentStart({
    entryNode,
    args,
  }: {
    entryNode: string;
    args?: any;
  }): Promise<void> {
    await this.post({
      type: "agentStart",
      entryNode,
      args,
    });
    if (this.metadata) {
      await this.runMetadata({ ...this.metadata, entryNode });
    }
  }

  async agentEnd({
    entryNode,
    result,
    timeTaken,
    tokenStats,
  }: {
    entryNode: string;
    result?: any;
    timeTaken: number;
    tokenStats?: {
      usage: TokenUsage;
      cost: TokenCost;
    };
  }): Promise<void> {
    // Fire-and-forget the remote send: this is the very last event of
    // a run, and waiting for the http round trip here directly delays
    // process exit. The synchronous file/stdout sinks still run inline
    // inside `post()`, so local observability is unaffected.
    await this.post(
      {
        type: "agentEnd",
        entryNode,
        result,
        timeTaken,
        tokenStats,
      },
      { noWait: true },
    );
  }

  // --- Interrupt lifecycle ---

  async interruptThrown({
    interruptId,
    interruptData,
  }: {
    interruptId: string;
    interruptData: any;
  }): Promise<void> {
    await this.post({
      type: "interruptThrown",
      interruptId,
      interruptData,
    });
  }

  async handlerDecision({
    interruptId,
    handlerIndex,
    decision,
    value,
    interrupt,
  }: {
    interruptId: string;
    handlerIndex: number;
    decision: "approve" | "reject" | "propagate" | "none";
    value?: any;
    /** Optional summary of the interrupt being decided on. Carries
     *  `kind`, `message`, and `data` so log consumers can see *what*
     *  was being approved/rejected without having to correlate with
     *  a separate `interruptThrown` event (which doesn't fire for
     *  synchronously-resolved interrupts like `with approve`). */
    interrupt?: { kind: string; message: string; data: any };
  }): Promise<void> {
    await this.post({
      type: "handlerDecision",
      interruptId,
      handlerIndex,
      decision,
      value,
      interrupt,
    });
  }

  async interruptResolved({
    interruptId,
    outcome,
    resolvedBy,
    timeTaken,
    interrupt,
  }: {
    interruptId: string;
    outcome: "approved" | "rejected" | "propagated";
    resolvedBy: "handler" | "user" | "policy" | "ipc";
    timeTaken?: number;
    /** Optional summary of the interrupt being resolved. See
     *  `handlerDecision.interrupt` for rationale. */
    interrupt?: { kind: string; message: string; data: any };
  }): Promise<void> {
    await this.post({
      type: "interruptResolved",
      interruptId,
      outcome,
      resolvedBy,
      timeTaken,
      interrupt,
    });
  }

  // --- Checkpoint lifecycle ---

  async checkpointCreated({
    checkpointId,
    reason,
    sourceLocation,
  }: {
    checkpointId: number;
    reason: "interrupt" | "explicit" | "failure" | "fork" | "race";
    sourceLocation?: { moduleId: string; scopeName: string; stepPath: string };
  }): Promise<void> {
    await this.post({
      type: "checkpointCreated",
      checkpointId,
      reason,
      sourceLocation,
    });
  }

  async checkpointRestored({
    checkpointId,
    restoreCount,
    maxRestores,
    overrides,
  }: {
    checkpointId: number;
    restoreCount: number;
    maxRestores?: number;
    overrides?: { args?: boolean; globals?: boolean; locals?: boolean };
  }): Promise<void> {
    await this.post({
      type: "checkpointRestored",
      checkpointId,
      restoreCount,
      maxRestores,
      overrides,
    });
  }

  // --- Fork/Race lifecycle ---

  async forkStart({
    forkId,
    mode,
    branchCount,
  }: {
    forkId: string;
    mode: "all" | "race";
    branchCount: number;
  }): Promise<void> {
    await this.post({
      type: "forkStart",
      forkId,
      mode,
      branchCount,
    });
  }

  async forkBranchEnd({
    forkId,
    branchIndex,
    outcome,
    timeTaken,
  }: {
    forkId: string;
    branchIndex: number;
    outcome: "success" | "failure" | "interrupted" | "aborted";
    timeTaken: number;
  }): Promise<void> {
    await this.post({
      type: "forkBranchEnd",
      forkId,
      branchIndex,
      outcome,
      timeTaken,
    });
  }

  async forkEnd({
    forkId,
    mode,
    timeTaken,
    winnerIndex,
  }: {
    forkId: string;
    mode: "all" | "race";
    timeTaken: number;
    winnerIndex?: number;
  }): Promise<void> {
    await this.post({
      type: "forkEnd",
      forkId,
      mode,
      timeTaken,
      winnerIndex,
    });
  }

  // --- Thread lifecycle ---

  async threadCreated({
    threadId,
    threadType,
    parentThreadId,
    label,
    session,
    hidden,
  }: {
    threadId: string;
    threadType: "thread" | "subthread";
    parentThreadId?: string;
    /** User-supplied label from `thread(label: "...") { ... }`. */
    label?: string | null;
    /** User-supplied session name from `thread(session: "...") { ... }`.
     *  Only populated on first-create of a session (later resumes fire
     *  `threadResumed`, not `threadCreated`). */
    session?: string | null;
    /** True when the thread was created with `thread(hidden: true)`. */
    hidden?: boolean;
  }): Promise<void> {
    await this.post({
      type: "threadCreated",
      threadId,
      threadType,
      parentThreadId,
      label,
      session,
      hidden,
    });
  }

  /** Fired when a previously-closed thread is re-activated via
   *  `ThreadStore.resumeExisting()` (i.e. by `thread(continue: id)`
   *  or `thread(session: name)` on second+ entry). Mirrors
   *  `threadCreated` so trace consumers can distinguish first-entry
   *  from resumption. */
  async threadResumed({
    threadId,
  }: {
    threadId: string;
  }): Promise<void> {
    await this.post({
      type: "threadResumed",
      threadId,
    });
  }

  /** Fired when the `onThreadEnd` callback dispatcher itself throws
   *  inside the `Runner.thread` finally block. Individual callback
   *  errors are caught and logged by `fireWithGuard`; this event
   *  covers the rarer case where the dispatcher loop itself blew up
   *  (e.g. a malformed registration). Emitted in lieu of the
   *  previous `console.error` so the failure is observable in
   *  traces. */
  async threadEndHookError({
    threadId,
    error,
  }: {
    threadId: string;
    error: string;
  }): Promise<void> {
    await this.post({
      type: "threadEndHookError",
      threadId,
      error,
    });
  }

  // --- Structured errors ---

  async error({
    errorType,
    message,
    functionName,
    retryable,
    sourceLocation,
  }: {
    errorType: "toolError" | "llmError" | "runtimeError" | "validationError" | "limitExceeded";
    message: string;
    functionName?: string;
    retryable?: boolean;
    sourceLocation?: { moduleId: string; line?: number };
  }): Promise<void> {
    await this.post({
      type: "error",
      errorType,
      message,
      functionName,
      retryable,
      sourceLocation,
    });
  }

  // === Post (wire format) ===

  async post(
    body: Record<string, any>,
    options?: {
      /**
       * When true, fire the remote http POST without awaiting its
       * result. The synchronous file/stdout sinks still run inline so
       * the event ordering they care about is preserved; only the
       * network round-trip is detached. Used for end-of-run events
       * (e.g. `agentEnd`) where nothing useful can be done with the
       * response and waiting would just delay process exit.
       */
      noWait?: boolean;
    },
  ): Promise<void> {
    if (!this.enabled) {
      return;
    }

    // We need either a host (remote / stdout) or a logFile to do anything.
    if (!this.host && !this.logFile) {
      return;
    }

    const span = this.currentSpan;
    const postBody = JSON.stringify({
      format_version: STATELOG_FORMAT_VERSION,
      trace_id: this.traceId,
      project_id: this.projectId,
      span_id: span?.spanId ?? null,
      parent_span_id: span?.parentSpanId ?? null,
      data: { ...body, timestamp: new Date().toISOString() },
    });

    // File sink: append one JSON object per line. Done synchronously
    // so tests can read the file immediately after an awaited event.
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, postBody + "\n");
      } catch (err) {
        if (this.debugMode)
          console.error("StatelogClient: failed to append to logFile:", err);
      }
    }

    if (!this.host) return;

    if (this.host.toLowerCase() === "stdout") {
      console.log(postBody);
      return;
    }

    // Remote sink is only attempted when an apiKey was provided. Without
    // it we silently skip the http POST so a configured logFile/stdout
    // sink keeps working without firing unauthenticated requests.
    if (!this.remoteEnabled) return;

    try {
      const fullUrl = new URL("/api/logs", this.host);
      const url = fullUrl.toString();

      // Bound each remote send by `requestTimeoutMs` so a slow or
      // unreachable statelog host cannot wedge process exit. The
      // request still completes asynchronously; on timeout it just
      // aborts with no retry.
      const request = fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: postBody,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      }).catch((err) => {
        if (this.debugMode) console.error("Failed to send statelog:", err);
      });

      // Detach the network round-trip from the caller's await chain so
      // execution never blocks on telemetry delivery. Awaiting each POST
      // used to add ~1.8s to agent startup — one blocked round-trip per
      // init-time interrupt. Track the request so `flush()` can drain it
      // before the process exits; the `.catch` above guarantees no
      // UnhandledPromiseRejection if it later fails or aborts. (`noWait`
      // is now the default for every event; the option is kept for
      // source compatibility.)
      const tracked: Promise<unknown> = request.finally(() => {
        this.inFlight.delete(tracked);
      });
      this.inFlight.add(tracked);
    } catch (err) {
      if (this.debugMode)
        console.error("Error sending log in statelog client:", err, {
          host: this.host,
        });
    }
  }

  /**
   * Await every in-flight remote POST. Remote sends are fire-and-forget
   * (see `post`), so call this at the end of a run — before the process
   * exits — to make sure detached telemetry is actually delivered. A
   * no-op when observability is off or nothing is in flight.
   */
  async flush(): Promise<void> {
    if (this.inFlight.size === 0) return;
    await Promise.allSettled([...this.inFlight]);
  }
}

export function getStatelogClient(config: {
  host: string;
  traceId?: string;
  projectId: string;
  debugMode?: boolean;
  observability?: boolean;
  logFile?: string;
}): StatelogClient {
  const statelogConfig = {
    host: config.host,
    traceId: config.traceId || nanoid(),
    apiKey: process.env.STATELOG_API_KEY || "",
    projectId: config.projectId,
    debugMode: config.debugMode || false,
    observability: config.observability,
    logFile: config.logFile,
  };
  const client = new StatelogClient(statelogConfig);
  return client;
}
