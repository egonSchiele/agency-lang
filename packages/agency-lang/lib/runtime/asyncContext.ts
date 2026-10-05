/**
 * The run: the one value that carries a running program's state.
 *
 * A `Run` holds the context, the branch's state stack, thread store and
 * globals, and the values that follow a path of calls. It is passed as an
 * ordinary argument. Every generated function takes one as its first
 * parameter, `__run`, and every runtime function that needs one takes it
 * from its caller. Nothing here uses `AsyncLocalStorage` or any other Node
 * module, so this file runs wherever JavaScript runs.
 *
 * A step, a call, a handler, or a fork branch gets its own run, made from
 * the outer one by `withChildRun`. Three places make a run from nothing:
 *
 *  1. `runNode` (lib/runtime/node.ts), for a fresh agent run.
 *  2. `runInBootstrapFrame`, for code that runs outside any node: global
 *     initialisation, top-level callback registration, and the first part
 *     of a resume or rewind. Its thread store is a `BootstrapThreadStore`,
 *     which throws on every user-facing operation.
 *  3. `runInTestContext`, for a test.
 *
 * # Functions that do not take a run
 *
 * A hand-written helper, a callback from TypeScript, and a handler given
 * to `agency.withHandler` keep their own signatures. The runtime calls
 * them through `callPlain`, which sets one module variable for the
 * synchronous part of the call. `currentRun()` reads that variable, so it
 * is right until the function's first `await` and throws after it.
 * `scripts/lint-run-reads.mjs` reports code in lib/ that could read it
 * later.
 *
 * See docs/dev/runtime/async-context.md for the full picture.
 */
import { BootstrapThreadStore } from "./state/bootstrapThreadStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { GlobalStore } from "./state/globalStore.js";
import type { StateStack } from "./state/stateStack.js";
import type { ThreadStore } from "./state/threadStore.js";
import type { Runner } from "./runner.js";
import type { HandlerEntry, HandlerFn } from "./types.js";
import type { CallFrame } from "./callDepth.js";
import type { DecisionScope } from "./decision/collector.js";
import type { StatelogClient } from "../statelogClient.js";

export type CallsiteLocation = {
  moduleId: string;
  scopeName: string;
  stepPath: string;
};

export type Run = {
  ctx: RuntimeContext<any>;
  stack: StateStack;
  threads: ThreadStore;
  /**
   * The globals this run reads and writes. Outside a fork branch it is
   * the same object as `ctx.globals`. It is a separate field so a branch
   * can hold a clone: `runBatch` clones the parent's store for each
   * branch, and generated code reads `__run.globals`, so a branch sees
   * its own copy without disturbing the parent's.
   */
  globals: GlobalStore;
  /**
   * The branch stack of the tool invocation this code runs in, set by the
   * tool loop for the body's duration. `endTurn()` and `handBack()` write
   * their marks here, and the loop drains this stack when the tool
   * returns. Every frame builder copies it from the outer frame, so code
   * in a `parallel`, `fork`, or `async` branch of the body still marks
   * the tool and not the branch. Absent outside a tool invocation.
   */
  toolInvocationStack?: StateStack;
  /**
   * Per-call-site source location for the currently-executing step.
   * Seeded by `Runner.runInScope` for every step body. Stdlib helpers
   * that need to attribute a checkpoint to its originating step
   * (`checkpoint()`) read this slot instead of receiving the location
   * as a trailing positional arg from generated code.
   *
   * Optional because not every run has one: the top-level
   * `runNode` frame and `runInBootstrapFrame` deliberately omit it
   * (any checkpoint created in bootstrap scope gets the empty
   * `""::""::""` fallback, as it always has).
   */
  callsite?: CallsiteLocation;
  /**
   * The `Runner` driving the currently-executing step, if any.
   * Seeded by `Runner.runInScope` so TS helpers like `agency.interrupt`
   * can call `runner.halt(...)` without having to receive the runner
   * as an argument. Absent in bootstrap frames and in the outer
   * `withResumableScope` body frame (only inside `s.step(...)` does
   * a Runner come into scope).
   */
  runner?: Runner;
  /**
   * The decision-call collector of the enclosing fork or parallel block
   * and the key of the arm this frame runs in. Absent outside a block.
   * See lib/runtime/decision/collector.ts.
   */
  decisions?: DecisionScope;
  /**
   * The call chain that led here, innermost first. `withCallDepth` adds a
   * link for each call and stops runaway recursion. `null` at the root.
   */
  callDepth: CallFrame | null;
  /**
   * How many handler chains are running one inside another on this path.
   * `runHandlerChain` adds one and refuses to go past its limit.
   */
  handlerChainDepth: number;
  /**
   * The handler entries whose functions are running on this path, outermost
   * first. The handler chain skips these, so a handler function never hears
   * an interrupt raised inside itself.
   */
  executingHandlers: HandlerEntry[];
  /**
   * The callbacks that are running on this path. A callback already in the
   * list is not fired again, and the runner puts off an external pause while
   * the list is not empty.
   */
  activeCallbacks: object[];
  /**
   * The logger for this run's branch: the logging client bound to the
   * branch's tag store and span stack. Every run in a branch shares one.
   */
  log: StatelogClient;
  /**
   * What this run is waiting for, for the wrong-run check. Unlike every
   * other field it is written to. A child run always gets its own.
   */
  state: RunState;
};

/**
 * How many things a run has started and is waiting for, and the name of
 * the latest. A run is usable when the count is 0.
 */
export type RunState = {
  waiting: number;
  waitingFor: string;
  /** True once TypeScript code has raised an interrupt on this run. A run
   *  takes one such raise. See lib/runtime/agencyInterrupt.ts. */
  raisedFromTypeScript: boolean;
};

/** The state of a run that is waiting for nothing. */
export function freshState(): RunState {
  return { waiting: 0, waitingFor: "", raisedFromTypeScript: false };
}

/**
 * Thrown when code starts work with a run that is waiting for something it
 * started. Only the innermost run can be used: the code inside a step, a
 * call, or a fork branch must use the run it was given.
 */
export class RunInUseError extends Error {
  constructor(what: string, run: Run) {
    super(
      `Wrong run: cannot ${what} with a run that is waiting for ${run.state.waitingFor}. ` +
        "Code inside that must use the run it was given.",
    );
    this.name = "RunInUseError";
  }
}

/** A short name for a value that was passed where a run was expected. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "function") return "a function";
  if (typeof value === "object") return "an object that is not a run";
  return `${typeof value} ${JSON.stringify(value)}`;
}

/**
 * Check that `run` is not waiting for something it started. The operations
 * that start work for Agency code or a helper call this: a call, a Runner
 * step, an interrupt, a callback. `what` says what was attempted.
 *
 * Every run has the same type, so the type checker cannot tell the right
 * run from the wrong one. This catches the mistake where it happens, and it
 * does not depend on any hidden state.
 */
export function assertUsable(run: Run, what: string): Run {
  // Generated code is not type-checked when it is compiled, so a call that
  // left the run out arrives here with something else in its place. Say so,
  // where the alternative is "cannot read properties of undefined".
  const given: unknown = run;
  if (given === null || typeof given !== "object" || !("state" in given)) {
    throw new Error(
      `Expected a run as the first argument, to ${what}, and got ${describeValue(given)}. ` +
        "Every runtime function that starts work takes the run it is called under first. " +
        "In generated code that is `__run`.",
    );
  }
  if (run.state.waiting > 0) {
    throw new RunInUseError(what, run);
  }
  return run;
}

/**
 * A copy of `run` with `overrides` and its own state, for work the caller
 * does not wait for. The caller keeps running, so nothing is counted
 * against `run`.
 */
export function detachedRun(run: Run, overrides: Partial<Run>): Run {
  return { ...run, ...overrides, state: freshState() };
}

/**
 * Run `fn` under a child of `parent`, and count `parent` as waiting until
 * `fn` has finished. `what` names the wait, for the error.
 *
 * The child is `parent` with `overrides` and its own state. This is how
 * every step, call, handler, and callback gets its run.
 */
export function withChildRun<T>(
  parent: Run,
  overrides: Partial<Run>,
  what: string,
  fn: (run: Run) => T,
): T {
  const child = detachedRun(parent, overrides);
  const state = parent.state;
  const previous = state.waitingFor;
  state.waiting++;
  state.waitingFor = what;
  const done = () => {
    state.waiting--;
    state.waitingFor = previous;
  };
  let result: T;
  try {
    result = withRun(child, fn);
  } catch (error) {
    done();
    throw error;
  }
  if (result instanceof Promise) {
    return result.then(
      (value) => {
        done();
        return value;
      },
      (error) => {
        done();
        throw error;
      },
    ) as T;
  }
  done();
  return result;
}

/**
 * The logger for a run made at the root of a branch that already exists:
 * the context's client bound to `globals` and to the span stack that is
 * current now. A test's stub client has no `logFor`, and is used as it is.
 */
export function logOf(ctx: RuntimeContext<any>, globals: GlobalStore): StatelogClient {
  // Read the field, not `ctx.rootLogWithSpans`: a test may build its context
  // from a plain object, which has the field and not the getter.
  const client = ctx.statelogClient as StatelogClient;
  return typeof client?.logFor === "function" ? client.logFor(globals) : client;
}

/**
 * The four values that follow a path of calls. They are required on every
 * frame, so a frame built without them does not compile. A frame that
 * dropped them would turn off the recursion limits and the rule that a
 * handler does not hear its own raises, with no error anywhere.
 */
export type Lineage = Pick<
  Run,
  "callDepth" | "handlerChainDepth" | "executingHandlers" | "activeCallbacks"
>;

/**
 * The lineage a new frame starts with: the outer frame's when there is one,
 * and empty values at the root of a run.
 */
export function lineageOf(outer: Run | undefined): Lineage {
  if (outer) {
    return {
      callDepth: outer.callDepth,
      handlerChainDepth: outer.handlerChainDepth,
      executingHandlers: outer.executingHandlers,
      activeCallbacks: outer.activeCallbacks,
    };
  }
  return { callDepth: null, handlerChainDepth: 0, executingHandlers: [], activeCallbacks: [] };
}

/**
 * The run that a plain function was called under. It is set for the
 * synchronous part of one call and put back afterwards.
 *
 * JavaScript runs one thing at a time, and a promise continuation never
 * runs inside another call's synchronous part. So from the start of a call
 * to the function's first `await`, this holds the run of that call. After
 * the first `await` it holds whatever some other call left there, which is
 * why `currentRun()` is only for a function's first lines.
 */
let plainCallRun: Run | undefined;

/**
 * Call a function that does not take a run. The function can read the run
 * with `currentRun()` until its first `await`.
 *
 * The previous value is restored in a `finally`. If a throw skipped the
 * restore, the next helper to run would read another request's run: its
 * globals, its thread, and its handlers.
 */
export function callPlain<A extends unknown[], T>(
  run: Run,
  fn: (...args: A) => T,
  args: A,
  thisArg?: unknown,
): T {
  const previous = plainCallRun;
  plainCallRun = run;
  try {
    return fn.apply(thisArg, args);
  } finally {
    plainCallRun = previous;
  }
}

/**
 * Run `fn` under `run`: hand it the run, and make the run readable with
 * `currentRun()` for the synchronous part of the call. Every place that
 * makes a child run goes through here.
 */
export function withRun<T>(run: Run, fn: (run: Run) => T): T {
  return callPlain(run, fn, [run]);
}

/**
 * The run this function was called under. Call it on the function's first
 * line, before any `await`, and keep the result:
 *
 *   export async function _fetch(url: string) {
 *     const run = currentRun();
 *     ...
 *   }
 *
 * It throws after the first `await`. A helper that needs the run later must
 * have taken it at the top.
 */
export function currentRun(): Run {
  const run = plainCallRun;
  if (run === undefined) {
    throw new Error(
      "No run is current here. There are two ways this happens.\n" +
        "1. The run was read after an await. It is only current until a function's " +
        "first await. Take it on the first line and keep it: " +
        "`const run = agency.current()` in your own helper, " +
        "or `const run = currentRun()` inside the runtime.\n" +
        "2. The code was not called by Agency at all. " +
        "In a test, wrap the call in runInTestContext().",
    );
  }
  return run;
}

/**
 * The run of the plain call in progress, or `undefined` when there is none.
 *
 * Like `currentRun()` it is only right until a function's first `await`.
 * Unlike it, this does not throw afterwards. It returns `undefined`, which
 * looks the same as "not inside a run". So use it only where a missing run
 * has a harmless answer, such as a default or a skipped log line, and call
 * it on the function's first line. Anything that tracks a limit, a guard,
 * or a handler must use `currentRun()` or take a run.
 *
 * A root run reads it too. A run started from inside another run (a nested
 * `runNode`, or a test context inside a test context) takes its lineage
 * from the outer one, so the recursion limits keep counting across the
 * nesting. That works when the inner run is started before an `await`.
 */
export function currentRunOrNone(): Run | undefined {
  return plainCallRun;
}

/**
 * Run `fn` under a child of `run` whose `callsite` is `loc`. For TS helpers
 * that want to attach a per-internal-substep checkpoint location to nested
 * `checkpoint()` calls.
 */
export function withCallsite<T>(run: Run, loc: CallsiteLocation, fn: (run: Run) => T): T {
  return withChildRun(run, { callsite: loc }, "its callsite scope", fn);
}

/**
 * Run `fn` with `handler` pushed onto `ctx.handlers`; pop in finally.
 * Two call sites consume this: `AgencyFunction.invoke()`'s preapprove
 * branch and (in a future PR) `agency.withHandler`. Co-locating the
 * combinator here means neither call site repeats the push/try/finally
 * dance and there is no circular import between agencyFunction.ts and
 * the agency namespace module.
 */
export async function withPushedHandler<T>(
  ctx: RuntimeContext<any>,
  handler: HandlerFn,
  fn: () => Promise<T>,
  liveGuardIds: string[],
): Promise<T> {
  // The caller names the guards that are live where the handler registers.
  // TS-side registration captures them AT CALL TIME, with no memo: TS
  // callers sit outside the checkpoint replay machinery and own their own
  // re-execution semantics (unlike Agency handle blocks, which memoize in
  // Runner.handle). `agency.withHandler` passes the guards on its run's
  // stack. preapprove() passes [] because its handler registers
  // conceptually above any guard (and its body never spends).
  ctx.pushHandler(handler, liveGuardIds);
  try {
    return await fn();
  } finally {
    ctx.popHandler();
  }
}

/**
 * The old name for `currentRun()`.
 *
 * @deprecated Use `currentRun()` inside the runtime, and `agency.current()`
 * in your own helpers. This name stays exported for one release.
 */
export function getRuntimeContext(): Run {
  return currentRun();
}

/**
 * For tests that construct a RuntimeContext by hand. It makes a root run
 * from the three values and calls `fn` with it. The run is also readable
 * with `currentRun()` until `fn`'s first `await`.
 */
export function runInTestContext<T>(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  threads: ThreadStore,
  fn: (run: Run) => T,
): T {
  return withRun(
    {
      ctx,
      stack,
      threads,
      globals: ctx.globals,
      log: logOf(ctx, ctx.globals),
      state: freshState(),
      // run-read-ok: a root run. With no run current it starts a new lineage.
      ...lineageOf(currentRunOrNone()),
    },
    fn,
  );
}

/**
 * Run `fn` under a run suitable for code that runs *outside* any
 * agent node body — module-level global-init, top-level callback
 * registration, and the resume/rewind prelude. The `threads` slot is a
 * `BootstrapThreadStore` sentinel: any attempt to use a message-thread
 * builtin from inside `fn` throws with an actionable error rather than
 * silently writing into a placeholder that the runtime is about to
 * discard.
 *
 * The `stack` slot is the caller's current `ctx.stateStack`. At the
 * `runNode` / `respondToInterrupts` / `rewindFrom` `*registerTopLevel
 * Callbacks` and `onAgentStart` call sites that's the bare pre-restore
 * stack (no node frames pushed) — which is the contract
 * `__initializeGlobals` always expected. At the resume / rewind
 * `graph.run` call sites it's the restored stack carrying the
 * checkpoint frames; that's also fine because `Runner.runInScope` on
 * the first step makes a child run with the per-node ThreadStore.
 *
 * Declared `async` so synchronous throws inside `fn` (including the
 * very common case of the `BootstrapThreadStore` sentinel throwing)
 * surface as rejected promises for `.catch(...)` callers, not as
 * uncaught sync exceptions.
 */
export async function runInBootstrapFrame<T>(
  ctx: RuntimeContext<any>,
  fn: (run: Run) => T | Promise<T>,
): Promise<T> {
  return withRun(
    {
      ctx,
      stack: ctx.stateStack,
      threads: new BootstrapThreadStore(),
      // Seed the canonical store. Bootstrap frames are never inside a
      // fork branch (init / top-level callback registration / lifecycle
      // hooks all run outside any branch), so pointer-
      // sharing is exactly right: writes done by `__initializeGlobals`
      // land on the RuntimeContext's store and persist across the run.
      globals: ctx.globals,
      log: logOf(ctx, ctx.globals),
      state: freshState(),
      // run-read-ok: a root run. With no run current it starts a new lineage.
      ...lineageOf(currentRunOrNone()),
    },
    fn,
  );
}
