import { StateStack } from "../state/stateStack.js";
import { GlobalStore } from "../state/globalStore.js";
import { CheckpointStore } from "../state/checkpointStore.js";
import { PendingPromiseStore } from "../state/pendingPromiseStore.js";
import type { DebuggerState } from "../../debugger/debuggerState.js";
import { ThreadStore } from "../state/threadStore.js";
import type { RuntimeContext } from "../state/context.js";
import { callPlain, runInTestContext, type Run } from "../asyncContext.js";

type TestFn = (name: string, fn: () => unknown, timeout?: number) => unknown;

/**
 * The root run of the test that is running, for `testRun()`. A test file's
 * tests run one at a time, so one variable is enough. It is test-only: the
 * runtime itself has no such variable, and passes every run as an argument.
 */
let rootRunOfTest: Run | undefined;

/** Call `fn` with `run` as the test's root run, until `fn` has finished. */
function asRootRunOfTest<T>(run: Run, fn: (run: Run) => T): T {
  const previous = rootRunOfTest;
  rootRunOfTest = run;
  const restore = () => {
    rootRunOfTest = previous;
  };
  let result: T;
  try {
    result = fn(run);
  } catch (error) {
    restore();
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(restore) as T;
  }
  restore();
  return result;
}

/**
 * Mark the run a test built for itself as the test's root run, so that
 * `testRun()` and `callHelper()` find it:
 *
 *   runInTestContext(ctx, stack, threads, asRootRun(async (run) => { ... }));
 */
export function asRootRun<T>(fn: (run: Run) => T): (run: Run) => T {
  return (run) => asRootRunOfTest(run, fn);
}

/**
 * Run `fn` under a root run built from a mock context, and hand it that
 * run.
 *
 * The call depth, the handler depth, the executing-handler list and the
 * active-callback list live on the run, so a test that calls a runtime
 * function directly needs one to pass in.
 */
export function inTestFrame<T>(fn: (run: Run) => T): T {
  const ctx = makeMockCtx();
  return runInTestContext(ctx, ctx.stateStack, ctx.threads, (run) => asRootRunOfTest(run, fn));
}

/**
 * Run `fn` under a root run built from the test's own context, so the run
 * it is handed has `run.ctx === ctx` and `run.stack === stack`.
 */
export function inFrameOf<T>(ctx: RuntimeContext<any>, stack: StateStack, fn: (run: Run) => T): T {
  return runInTestContext(ctx, stack, new ThreadStore(), (run) => asRootRunOfTest(run, fn));
}

/**
 * The root run of the test: the one `inTestFrame`, `inFrameOf`, or
 * `withTestFrame` built. A test passes it to a runtime function that takes
 * a run:
 *
 *   await runner.step(0, testRun(), async (r, stepRun) => { ... });
 *
 * It is always the ROOT run, also after an `await`. Code inside a step, a
 * call, or a fork branch must use the run that body was handed (`stepRun`
 * above). Passing the root run there fails with `RunInUseError`, because
 * the root run is waiting for the step it started.
 *
 * Outside a test frame it throws. Wrap the test with `withTestFrame`.
 */
export function testRun(): Run {
  if (rootRunOfTest === undefined) {
    throw new Error(
      "testRun() was called outside a test frame. " +
        "Wrap the test with withTestFrame(it), or its body with inTestFrame().",
    );
  }
  return rootRunOfTest;
}

/**
 * Call a helper the way the runtime does: under the test's root run, so the
 * helper can read the run on its first line.
 *
 * A test body that has already awaited something needs this. After the
 * first `await` in the body, a bare `_helper()` call is no longer inside
 * the synchronous part that `runInTestContext` set the run for.
 *
 *   const result = await callHelper(_fetch, url, "", {}, [], "GET", null);
 */
export function callHelper<A extends unknown[], T>(fn: (...args: A) => T, ...args: A): T {
  return callPlain(testRun(), fn, args);
}

/**
 * Make `ctx` the context of the test's root run, and return it. A test
 * whose frame already exists when it builds its own context calls this, so
 * `testRun().ctx` is the context the test asserts against. Call it before
 * the test starts any work: a child run made earlier keeps the old context.
 */
export function adoptCtx<T extends { globals: GlobalStore }>(ctx: T): T {
  const run = testRun();
  run.ctx = ctx as unknown as RuntimeContext<any>;
  run.globals = ctx.globals;
  return ctx;
}

/**
 * Wrap vitest's `it` so that every test body runs under a root run:
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
    // As on the real context: a handler from TypeScript takes only the
    // interrupt, and is wrapped into the shape the chain calls.
    pushHandler(fn: any, liveGuardIds: string[] = []) {
      this.handlers.push({
        fn: (run: Run, interrupt: unknown) => callPlain(run, fn, [interrupt]),
        liveGuardIds,
      });
    },
    pushRunHandler(fn: any, liveGuardIds: string[] = []) {
      this.handlers.push({ fn, liveGuardIds });
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
