import * as fs from "fs";
import * as path from "path";
import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "nanoid";
import { ModelName } from "smoltalk";
import { JSONEdge } from "./types.js";

// === Span model ===

export type SpanType =
  | "agentRun"
  | "nodeExecution"
  | "llmCall"
  | "toolExecution"
  | "forkAll"
  | "race"
  | "handlerChain";

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
};

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

  constructor(config: StatelogConfig) {
    const { host, apiKey, projectId, traceId, debugMode } = config;
    this.host = host;
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.debugMode = debugMode || false;
    this.traceId = traceId || nanoid();
    this.logFile = config.logFile;

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
  snapshotStack(): SpanContext[] {
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
  runInBranchContext<T>(
    parentStack: SpanContext[],
    fn: () => Promise<T>,
  ): Promise<T> {
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
    });
  }

  async toolCall({
    toolName,
    args,
    output,
    model,
    timeTaken,
  }: {
    toolName: string;
    args: any;
    output: any;
    model?: ModelName;
    timeTaken?: number;
  }): Promise<void> {
    await this.post({
      type: "toolCall",
      toolName,
      args,
      output,
      model,
      timeTaken,
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
    await this.post({
      type: "agentEnd",
      entryNode,
      result,
      timeTaken,
      tokenStats,
    });
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
  }: {
    interruptId: string;
    handlerIndex: number;
    decision: "approve" | "reject" | "propagate" | "none";
    value?: any;
  }): Promise<void> {
    await this.post({
      type: "handlerDecision",
      interruptId,
      handlerIndex,
      decision,
      value,
    });
  }

  async interruptResolved({
    interruptId,
    outcome,
    resolvedBy,
    timeTaken,
  }: {
    interruptId: string;
    outcome: "approved" | "rejected" | "propagated";
    resolvedBy: "handler" | "user" | "policy" | "ipc";
    timeTaken?: number;
  }): Promise<void> {
    await this.post({
      type: "interruptResolved",
      interruptId,
      outcome,
      resolvedBy,
      timeTaken,
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
  }: {
    threadId: string;
    threadType: "thread" | "subthread";
    parentThreadId?: string;
  }): Promise<void> {
    await this.post({
      type: "threadCreated",
      threadId,
      threadType,
      parentThreadId,
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

  async post(body: Record<string, any>): Promise<void> {
    if (!this.enabled) {
      return;
    }

    // We need either a host (remote / stdout) or a logFile to do anything.
    if (!this.host && !this.logFile) {
      return;
    }

    const span = this.currentSpan;
    const postBody = JSON.stringify({
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

      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: postBody,
      }).catch((err) => {
        if (this.debugMode) console.error("Failed to send statelog:", err);
      });
    } catch (err) {
      if (this.debugMode)
        console.error("Error sending log in statelog client:", err, {
          host: this.host,
        });
    }
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
