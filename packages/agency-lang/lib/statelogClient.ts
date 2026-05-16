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
  | "forkBranch"
  | "race"
  | "raceBranch"
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
  private enabled: boolean = true;
  private spanStack: SpanContext[] = [];
  private forkDepth: number = 0;
  private metadata?: RunMetadata;

  constructor(config: StatelogConfig) {
    const { host, apiKey, projectId, traceId, debugMode } = config;
    this.host = host;
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.debugMode = debugMode || false;
    this.traceId = traceId || nanoid();

    this.metadata = config.metadata;

    // Observability must be explicitly enabled. When false (the default),
    // the entire client is a no-op — no events emitted, no network calls.
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

    if (!this.apiKey) {
      this.enabled = false;
      if (this.debugMode)
        console.warn(
          "API key is required for StatelogClient to send logs to a remote server. Logs will not be sent.",
        );
    }
  }

  // === Fork depth tracking ===
  // Inside fork/race branches, multiple concurrent branches share this
  // client. Span push/pop would interleave and corrupt the stack, so we
  // skip span management entirely when forkDepth > 0. Events still fire
  // (just without span attribution).

  enterFork(): void {
    this.forkDepth++;
  }

  exitFork(): void {
    if (this.forkDepth > 0) this.forkDepth--;
  }

  // === Span management ===

  startSpan(type: SpanType): string {
    if (!this.enabled || this.forkDepth > 0) return "";
    const spanId = nanoid(12);
    const parentSpanId = this.spanStack.length > 0
      ? this.spanStack[this.spanStack.length - 1].spanId
      : null;
    this.spanStack.push({
      spanId,
      parentSpanId,
      spanType: type,
      startTime: performance.now(),
    });
    return spanId;
  }

  endSpan(): SpanContext | undefined {
    if (!this.enabled || this.forkDepth > 0) return undefined;
    return this.spanStack.pop();
  }

  get currentSpan(): SpanContext | undefined {
    return this.spanStack.length > 0
      ? this.spanStack[this.spanStack.length - 1]
      : undefined;
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
    functionName,
    sourceLocation,
  }: {
    interruptId: string;
    interruptData: any;
    functionName?: string;
    sourceLocation?: { moduleId: string; line?: number };
  }): Promise<void> {
    await this.post({
      type: "interruptThrown",
      interruptId,
      interruptData,
      functionName,
      sourceLocation,
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
    reason: "interrupt" | "explicit" | "failure" | "fork" | "race" | "trace";
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

  private async post(body: Record<string, any>): Promise<void> {
    if (!this.host) {
      return;
    }

    if (!this.enabled) {
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

    if (this.host.toLowerCase() === "stdout") {
      console.log(postBody);
      return;
    }

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
}): StatelogClient {
  const statelogConfig = {
    host: config.host,
    traceId: config.traceId || nanoid(),
    apiKey: process.env.STATELOG_API_KEY || "",
    projectId: config.projectId,
    debugMode: config.debugMode || false,
  };
  const client = new StatelogClient(statelogConfig);
  return client;
}
