import { StateStack } from "../state/stateStack.js";
import { GlobalStore } from "../state/globalStore.js";
import { CheckpointStore } from "../state/checkpointStore.js";
import { PendingPromiseStore } from "../state/pendingPromiseStore.js";
import type { DebuggerState } from "../../debugger/debuggerState.js";
import { ThreadStore } from "../state/threadStore.js";
import type { RuntimeContext } from "../state/context.js";
import { ambientRun, runInTestContext, type Run } from "../asyncContext.js";

type TestFn = (name: string, fn: () => unknown, timeout?: number) => unknown;

/**
 * Run `fn` inside an execution frame built from a mock context.
 *
 * The call depth, the handler depth, the executing-handler list and the
 * active-callback list live on the frame, and the functions that keep them
 * throw when there is none. A test that calls such a function directly
 * needs a frame around it.
 */
export function inTestFrame<T>(fn: () => T): T {
  const ctx = makeMockCtx();
  return runInTestContext(ctx, ctx.stateStack, ctx.threads, fn);
}

/**
 * Run `fn` inside a frame built from the test's own context, so the run it
 * is handed has `run.ctx === ctx` and `run.stack === stack`.
 */
export function inFrameOf<T>(ctx: RuntimeContext<any>, stack: StateStack, fn: (run: Run) => T): T {
  return runInTestContext(ctx, stack, new ThreadStore(), fn);
}

/**
 * The run of the frame a test is running in. A test passes it to a runtime
 * function that takes a run:
 *
 *   await runner.step(0, testRun(), async (r, run) => { ... });
 *
 * Outside a frame it throws. Wrap the test with `withTestFrame`.
 */
export function testRun(): Run {
  return ambientRun("A test");
}

/**
 * Make `ctx` the context of the frame the test is running in, and return it.
 * A test whose frame already exists when it builds its own context calls
 * this, so `testRun().ctx` is the context the test asserts against.
 */
export function adoptCtx<T extends { globals: GlobalStore }>(ctx: T): T {
  const run = testRun();
  run.ctx = ctx as unknown as RuntimeContext<any>;
  run.globals = ctx.globals;
  return ctx;
}

/**
 * Wrap vitest's `it` so that every test body runs inside a frame:
 *
 *   import { it as baseIt } from "vitest";
 *   const it = withTestFrame(baseIt);
 */
export function withTestFrame(base: TestFn): TestFn {
  return (name, fn, timeout) => base(name, () => inTestFrame(fn), timeout);
}

/**
 * Creates a mock RuntimeContext for unit tests.
 * Includes all methods that runtime code calls on the context.
 */
export function makeMockCtx(
  opts: {
    debuggerState?: DebuggerState | null;
  } = {},
): any {
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
    pauseRequested: false,
    abortController: new AbortController(),
    throwIfCancelled() {
      if (this.abortController.signal.aborted) {
        throw this.abortController.signal.reason;
      }
    },
    _toolCallDepth: 0,
    runId: null,
    traceConfig: {},
    pushHandler(fn: any, liveGuardIds: string[] = []) {
      this.handlers.push({ fn, liveGuardIds });
    },
    pushRunHandler(fn: any, liveGuardIds: string[] = []) {
      this.handlers.push({ fn, liveGuardIds, takesRun: true });
    },
    popHandler() {
      this.handlers.pop();
    },
    isCancelled() {
      return false;
    },
    enterToolCall() {
      this._toolCallDepth++;
    },
    exitToolCall() {
      this._toolCallDepth--;
    },
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
      toolCallStart: () => {},
      interruptThrown: () => {},
      interruptResolved: () => {},
      handlerDecision: () => {},
      threadCreated: () => {},
      threadResumed: () => {},
      threadRepaired: () => {},
      agentStart: () => {},
      agentEnd: () => {},
    },
    hasDebugger() {
      return this.debuggerState !== null;
    },
    hasTraceWriter() {
      return false;
    },
    isInsideToolCall() {
      return this._toolCallDepth > 0;
    },
    getRunId() {
      return this.runId || "mock-run-id";
    },
    async writeCheckpointToTraceWriter() {},
    async pauseTraceWriter() {},
    async closeTraceWriter() {},
  };
}
