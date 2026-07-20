/**
 * `agency.withResumableScope` — Temporal-style resumable TS workflows.
 *
 * A resumable scope wraps a TS body in the same substep-counter +
 * serialized-frame machinery generated Agency function bodies use, so
 * interrupts that happen inside a step body re-enter exactly where
 * they left off on resume: already-completed steps are skipped, and
 * the deepest in-flight step re-runs from scratch.
 *
 * Determinism contract (load-bearing!):
 *  - Step bodies must be pure with respect to inputs. On resume, the
 *    in-flight step's body re-runs from scratch — any non-pure work
 *    (Date.now, Math.random, cumulative I/O) will diverge from the
 *    pre-interrupt run.
 *  - All "I/O that should run exactly once" must live inside a
 *    `s.step(...)` body.
 *  - Step calls MUST be issued in a stable order across the original
 *    run and every resume. Don't put `s.step(...)` behind a condition
 *    whose outcome could change between runs (random branching,
 *    wall-clock, external state); the scope's internal step counter
 *    would mis-align with the persisted substep slots and resume
 *    would replay the wrong body. Straight-line code, loops with
 *    deterministic bounds, and conditions over stable inputs are all
 *    fine.
 *
 * Implementation notes:
 *  - All halt state lives on the `Runner` (`halted` / `haltResult`).
 *    The scope facade is stateless wrt halt — no closure-local
 *    `halted` / `HALT_SENTINEL`. After `runner.halt(...)`, every
 *    subsequent `runner.step(...)` short-circuits via `shouldSkip()`,
 *    so the body's remaining `await s.step(...)` calls are no-ops
 *    and the outer `body(scope)` resolves naturally.
 *  - Step ids are auto-assigned by an in-scope counter (`0, 1, 2,
 *    ...`) in the order `s.step(...)` is called. The counter exists
 *    only on the scope facade — the underlying frame still keys
 *    everything off `__substep_${id}`, and the determinism contract
 *    above is what keeps the counter aligned across resume.
 *  - Step return values are persisted to `frame.locals` under a
 *    reserved `__scope_step_${id}` key. On resume, when the substep
 *    counter short-circuits the callback, the cached value is
 *    returned — matching the value the original execution observed.
 *  - User-managed scope locals live under `frame.locals.__userLocals`
 *    to avoid colliding with codegen-emitted keys (`__substep_*`,
 *    `__scope_step_*`, etc.) and with user-chosen TS variable names
 *    elsewhere on the frame.
 *  - `stateStack.pop()` runs unconditionally in `finally`, mirroring
 *    the generated function-body emission in
 *    `lib/backends/typescriptBuilder.ts`.
 */
import { agencyStore, getRuntimeContext } from "./asyncContext.js";
import { setupFunction } from "./node.js";
import { Runner } from "./runner.js";
import { RESULT_ENTRY_LABEL } from "./state/checkpointStore.js";

export type ResumableScopeOpts = {
  /** Shown in traces, checkpoint locations. Required. */
  name: string;
  /** Default: "<ts-helper>". Label used only for grouping this scope's
   *  steps in trace files and debugger UI — execution is unaffected
   *  by collisions. If two TS files use the same `moduleId` +
   *  `name`, their scopes will appear under the same group in those
   *  UIs, but each scope still gets its own isolated frame on the
   *  stack at runtime. Override when you want a TS helper to appear
   *  under a distinct module label in the debugger. */
  moduleId?: string;
  /** Default: false. When true, pins a `result-entry` checkpoint at
   *  scope entry so the calling Agency function's `result.retry()`
   *  rewinds to this scope's start, exactly as it would for a
   *  generated function body. Disabled by default because pinned
   *  checkpoints accumulate without bound (evictIfNeeded only evicts
   *  unpinned) and the per-entry JSON deep-clone of stateStack +
   *  globals is a real per-keystroke cost. Pair this with the
   *  resultCheckpointSetup template which has the same behavior for
   *  compiled Agency function bodies. Not related to the debugger —
   *  for that, see `agency.callsite()` and the per-step ALS frame. */
  pinResultCheckpoint?: boolean;
};

export type ResumableScope = {
  /** Resumable step. Each call gets an auto-incrementing id (0, 1,
   *  2, ...) tied to the order `s.step(...)` is invoked. On resume,
   *  the body re-runs only if not already completed; once complete,
   *  the cached return value is returned without re-executing.
   *
   *  Step calls MUST be issued in a stable order across runs — see
   *  the determinism contract on `withResumableScope`. */
  step<T>(fn: () => T | Promise<T>): Promise<T>;

  /** Get a frame-local value persisted across resume. Returns
   *  `undefined` for unset keys. */
  getLocal<T>(key: string): T | undefined;
  /** Set a frame-local value. The value is serialized into the
   *  scope's frame and survives resume. */
  setLocal<T>(key: string, value: T): void;

  /** Halt the scope; `withResumableScope` resolves with `result`.
   *  Use this to bubble a final value (e.g. an interrupt-response
   *  outcome the step body has already handled) out of the scope
   *  without executing the remaining steps. Sets the underlying
   *  Runner's `halted` flag, so every subsequent `s.step(...)`
   *  short-circuits without invoking its callback. Does NOT throw,
   *  and does NOT raise an interrupt to the caller — for the
   *  latter, see the planned `agency.interrupt()` helper. */
  halt(result: unknown): void;
};

const STEP_RESULT_PREFIX = "__scope_step_";
const USER_LOCALS_KEY = "__userLocals";

export async function withResumableScope<T>(
  opts: ResumableScopeOpts,
  body: (s: ResumableScope) => Promise<T>,
): Promise<T> {
  const moduleId = opts.moduleId ?? "<ts-helper>";
  const pin = opts.pinResultCheckpoint ?? false;

  const runtime = getRuntimeContext();
  const ctx = runtime.ctx;

  // Push a new frame on the active branch's stack (reads `stack` /
  // `threads` from the ALS frame, same as a generated function body).
  const { stateStack, stack, threads } = setupFunction();

  if (pin) {
    await ctx.checkpoints.createPinned(stateStack, ctx, {
      moduleId,
      scopeName: opts.name,
      stepPath: "",
      label: RESULT_ENTRY_LABEL,
    });
  }

  const runner = new Runner(ctx, stack, {
    state: stack,
    moduleId,
    scopeName: opts.name,
    stack: stateStack,
    threads,
  });

  // Auto-assigned per-call step id. Exists only on the scope facade;
  // the underlying frame keys substep state off this id. The
  // determinism contract on `withResumableScope` is what keeps this
  // counter aligned with the persisted substep slots across resume.
  let nextStepId = 0;

  const scope: ResumableScope = {
    step: async <U>(fn: () => U | Promise<U>): Promise<U> => {
      const id = nextStepId++;
      const key = `${STEP_RESULT_PREFIX}${id}`;
      await runner.step(id, async () => {
        stack.locals[key] = await fn();
      });
      // After a no-op short-circuit (halted, replayed substep), the
      // cached value persists from the previous execution. Returns
      // `undefined as U` for steps that never ran (e.g. after halt).
      return stack.locals[key] as U;
    },

    setLocal: <U>(key: string, value: U): void => {
      const userLocals = ((stack.locals[USER_LOCALS_KEY] ??= {}) as Record<string, unknown>);
      userLocals[key] = value;
    },

    getLocal: <U>(key: string): U | undefined => {
      const userLocals = (stack.locals[USER_LOCALS_KEY] as Record<string, unknown> | undefined);
      return userLocals?.[key] as U | undefined;
    },

    halt: (result: unknown): void => {
      runner.halt(result);
    },
  };

  try {
    const outer = agencyStore.getStore();
    const bodyResult = await agencyStore.run(
      {
        ctx,
        stack: stateStack,
        threads,
        // Inherit `globals` from any outer ALS frame so a resumable
        // scope nested inside a fork branch sees the branch-local
        // clone instead of the canonical store. Fall back to
        // `ctx.globals` when no outer frame exists.
        globals: outer?.globals ?? ctx.globals,
        callsite: { moduleId, scopeName: opts.name, stepPath: "" },
      },
      () => body(scope),
    );
    return runner.halted ? (runner.haltResult as T) : bodyResult;
  } finally {
    stateStack.pop();
  }
}
