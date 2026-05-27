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
 *    `s.step(id, ...)` or `s.hook(id, ...)` body.
 *
 * Implementation notes:
 *  - All halt state lives on the `Runner` (`halted` / `haltResult`).
 *    The scope facade is stateless — no closure-local `halted` /
 *    `HALT_SENTINEL`. After `runner.halt(...)`, every subsequent
 *    `runner.step(...)` short-circuits via `shouldSkip()`, so the
 *    body's remaining `await s.step(...)` calls are no-ops and the
 *    outer `body(scope)` resolves naturally.
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

export type ResumableScopeOpts = {
  /** Shown in traces, checkpoint locations. Required. */
  name: string;
  /** Default: "<ts-helper>". Used for checkpoint location grouping in
   *  debugger UI and trace files. */
  moduleId?: string;
  /** Default: true. Pins a result checkpoint at scope entry so the
   *  calling Agency function's `result.retry()` semantics work the
   *  same way they would for a generated function body. */
  pinResultCheckpoint?: boolean;
};

export type ResumableScope = {
  /** Resumable step. `id` is the substep counter slot. On resume,
   *  the body re-runs only if not already completed; once complete,
   *  the cached return value is returned without re-executing. */
  step<T>(id: number, fn: () => T | Promise<T>): Promise<T>;

  /** Idempotent hook (substep-counted). Useful for once-per-scope
   *  side effects whose return value is not needed. The hook fires
   *  exactly once across run + every resume. */
  hook(id: number, fn: () => void | Promise<void>): Promise<void>;

  /** Frame-local persisted across resume. `init` runs only the
   *  first time the key is referenced. */
  local<T>(key: string, init: () => T): T;
  setLocal<T>(key: string, value: T): void;
  getLocal<T>(key: string): T | undefined;

  /** Halt the scope; `withResumableScope` will return `result`.
   *  Used to bubble interrupt responses out of a step body. Sets a
   *  flag on the underlying Runner — every subsequent `s.step(...)`
   *  short-circuits without invoking its callback. Does NOT throw. */
  halt(result: unknown): void;
};

const STEP_RESULT_PREFIX = "__scope_step_";
const USER_LOCALS_KEY = "__userLocals";

export async function withResumableScope<T>(
  opts: ResumableScopeOpts,
  body: (s: ResumableScope) => Promise<T>,
): Promise<T> {
  const moduleId = opts.moduleId ?? "<ts-helper>";
  const pin = opts.pinResultCheckpoint ?? true;

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
      label: null,
    });
  }

  const runner = new Runner(ctx, stack, {
    state: stack,
    moduleId,
    scopeName: opts.name,
    stack: stateStack,
    threads,
  });

  const scope: ResumableScope = {
    step: async <U>(id: number, fn: () => U | Promise<U>): Promise<U> => {
      const key = `${STEP_RESULT_PREFIX}${id}`;
      await runner.step(id, async () => {
        stack.locals[key] = await fn();
      });
      // After a no-op short-circuit (halted, replayed substep), the
      // cached value persists from the previous execution. Returns
      // `undefined as U` for steps that never ran (e.g. after halt).
      return stack.locals[key] as U;
    },

    hook: (id, fn) => runner.hook(id, async () => { await fn(); }),

    local: <U>(key: string, init: () => U): U => {
      const userLocals = ((stack.locals[USER_LOCALS_KEY] ??= {}) as Record<string, unknown>);
      if (!(key in userLocals)) {
        userLocals[key] = init();
      }
      return userLocals[key] as U;
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
    const bodyResult = await agencyStore.run(
      {
        ctx,
        stack: stateStack,
        threads,
        callsite: { moduleId, scopeName: opts.name, stepPath: "" },
      },
      () => body(scope),
    );
    return runner.halted ? (runner.haltResult as T) : bodyResult;
  } finally {
    stateStack.pop();
  }
}
