import { StateStack } from "../state/stateStack.js";
import { GlobalStore } from "../state/globalStore.js";
import { CheckpointStore } from "../state/checkpointStore.js";
import { PendingPromiseStore } from "../state/pendingPromiseStore.js";
import type { DebuggerState } from "../../debugger/debuggerState.js";

/**
 * Creates a mock RuntimeContext for unit tests.
 * Includes all methods that runtime code calls on the context.
 */
export function makeMockCtx(opts: {
  debuggerState?: DebuggerState | null;
} = {}): any {
  const stateStack = new StateStack();
  stateStack.nodesTraversed = ["start", "process"];
  const state = stateStack.getNewState();
  state.args = { input: "hello" };
  state.locals = { x: 42 };
  state.step = 3;

  const globals = GlobalStore.withTokenStats();
  globals.set("mod1", "count", 10);

  return {
    stateStack,
    globals,
    checkpoints: new CheckpointStore(),
    pendingPromises: new PendingPromiseStore(),
    debuggerState: opts.debuggerState ?? null,
    handlers: [] as any[],
    callbacks: {},
    _skipNextCheckpoint: false,
    _toolCallDepth: 0,
    runId: null,
    traceConfig: {},
    pushHandler(fn: any) { this.handlers.push(fn); },
    popHandler() { this.handlers.pop(); },
    isCancelled() { return false; },
    enterToolCall() { this._toolCallDepth++; },
    exitToolCall() { this._toolCallDepth--; },
    interruptResponses: {} as Record<string, { response: any }>,
    setInterruptResponses(responses: Record<string, { response: any }>) {
      this.interruptResponses = responses;
    },
    getInterruptResponse(id: string) {
      return this.interruptResponses[id]?.response;
    },
    threads: {
      create: () => "tid-1",
      createSubthread: () => "tid-sub-1",
      pushActive: () => {},
      popActive: () => {},
      activeId: () => undefined,
      get: () => ({ messages: [], parentId: null }),
      resumeExisting: () => {},
      openSession: (_name: string) => ({ id: "tid-1", existed: false }),
    },
    // Minimal statelogClient stub. runBatch (used by Runner.hook's
    // per-callback machinery) needs `snapshotStack` and
    // `runInBranchContext`; everything else is a no-op.
    statelogClient: {
      snapshotStack: () => [],
      runInBranchContext: <T>(_stack: unknown, fn: () => T): T => fn(),
      startSpan: () => "span-mock",
      endSpan: () => {},
      forkStart: () => {},
      forkEnd: () => {},
      forkBranchEnd: () => {},
      checkpointCreated: () => {},
      checkpointRestored: () => {},
      error: () => {},
      toolCall: () => {},
      interruptThrown: () => {},
      interruptResolved: () => {},
      handlerDecision: () => {},
      agentStart: () => {},
      agentEnd: () => {},
    },
    hasDebugger() { return this.debuggerState !== null; },
    hasTraceWriter() { return false; },
    isInsideToolCall() { return this._toolCallDepth > 0; },
    getRunId() { return this.runId || "mock-run-id"; },
    async writeCheckpointToTraceWriter() {},
    async pauseTraceWriter() {},
    async closeTraceWriter() {},
  };
}
