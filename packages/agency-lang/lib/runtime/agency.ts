/**
 * Public `agency.*` namespace — the canonical entry point for TS code
 * that wants to participate in an Agency run (read context, push
 * thread messages, install handlers, create checkpoints, etc.).
 *
 * Every method is a thin wrapper over an existing runtime function;
 * no new behavior is added here. The namespace exists for
 * discoverability and to give docs/IDEs a single surface to point at.
 *
 * Naming conventions:
 *  - No underscore prefix. Read APIs throw on missing frame by
 *    default; `*Maybe` variants return `undefined` instead.
 *  - `with*` prefix for scope-installing helpers (run a callback with
 *    a temporary modification to the active frame).
 *  - Thread-related operations live under `agency.thread.*` to keep
 *    the top-level surface lean; e.g. `agency.thread.user("hi")` and
 *    `agency.thread.current()`.
 *  - Codegen-emitted internals (`getRuntimeContext`, `agencyStore`,
 *    `__threads`, `__stateStack`, `__call`, `__callMethod`,
 *    `runInTestContext`) keep their existing names and are still
 *    exported from `agency-lang/runtime` because generated code
 *    imports them directly. TS helper authors should prefer
 *    `agency.*`.
 *
 * See docs/site/guide/ts-helpers.md (PR #5) for the long-form guide.
 */
import * as smoltalk from "smoltalk";
import {
  agencyStore,
  getRuntimeContext,
  runInTestContext,
  withCallsite as _withCallsite,
  withPushedHandler,
  type CallsiteLocation,
} from "./asyncContext.js";
import {
  checkpoint as _checkpoint,
  getCheckpoint as _getCheckpoint,
  restore as _restore,
} from "./checkpoint.js";
import type { RestoreOptions } from "./errors.js";
import { CostGuard } from "./guard.js";
import type { Checkpoint } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { StateStack } from "./state/stateStack.js";
import type { MessageThread } from "./state/messageThread.js";
import type { ThreadStore } from "./state/threadStore.js";
import type { HandlerFn } from "./types.js";

// ---- Context reads -----------------------------------------------------

/** Read the active `RuntimeContext`. Throws when called outside any
 *  `agencyStore.run(...)` frame (i.e. from non-Agency code). Tests
 *  that need a frame can use `agency.withTestContext({ctx,stack,threads}, fn)`. */
const ctx = (): RuntimeContext<any> => getRuntimeContext().ctx;

/** Lax variant of `agency.ctx()`. Returns `undefined` outside any frame. */
const ctxMaybe = (): RuntimeContext<any> | undefined => agencyStore.getStore()?.ctx;

/** Per-call-site source location seeded by `Runner.runInScope` for
 *  every step body. Returns `undefined` outside any frame or in
 *  frames where no callsite was installed (bootstrap scope). */
const callsite = (): CallsiteLocation | undefined => agencyStore.getStore()?.callsite;

/** Read a module-scoped global. Same semantics as the Agency-level
 *  `globals.get(moduleId, name)`. `moduleId` defaults to `""`
 *  (the bare/anonymous module). */
const global_ = <T = unknown>(name: string, moduleId = ""): T =>
  ctx().globals.get(moduleId, name) as T;

// ---- Thread subnamespace ----------------------------------------------

/** Active `MessageThread`, creating one if none is active yet. */
const threadCurrent = (): MessageThread =>
  getRuntimeContext().threads.getOrCreateActive();

/** Push a user-role message onto the active thread. */
const threadUser = (content: string): void => {
  threadCurrent().push(smoltalk.userMessage(content));
};

/** Push a system-role message onto the active thread. */
const threadSystem = (content: string): void => {
  threadCurrent().push(smoltalk.systemMessage(content));
};

/** Push an assistant-role message onto the active thread. */
const threadAssistant = (content: string): void => {
  threadCurrent().push(smoltalk.assistantMessage(content));
};

/** Return the full `ThreadStore`. Throws when called outside any frame. */
const threadStore = (): ThreadStore => getRuntimeContext().threads;

/** Lax variant of `agency.thread.store()`. Returns `undefined` outside any frame. */
const threadStoreMaybe = (): ThreadStore | undefined => agencyStore.getStore()?.threads;

/** Run `fn` with `threadId` pushed as the active thread; pop the
 *  active stack (including on throw) when `fn` returns. */
const threadWith = async <T>(
  threadId: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const store = threadStore();
  store.pushActive(threadId);
  try {
    return await fn();
  } finally {
    store.popActive();
  }
};

// ---- Checkpoints -------------------------------------------------------

/** Capture a checkpoint of the current execution state. The recorded
 *  location is read from the active ALS callsite slot. */
const checkpoint = (): Promise<number> => _checkpoint();

/** Look up a previously-created checkpoint by id. Throws if missing. */
const getCheckpoint = (id: number): Checkpoint => _getCheckpoint(id);

/** Restore execution to a prior checkpoint. Throws `RestoreSignal`;
 *  the surrounding runtime catches it and rewinds. */
const restore = (
  idOrCp: number | Checkpoint,
  opts: RestoreOptions = {},
): void => _restore(idOrCp, opts);

/** Run `fn` with a custom `callsite` installed on the active frame.
 *  Throws when called outside any agency frame. */
const withCallsite = <T>(loc: CallsiteLocation, fn: () => T): T =>
  _withCallsite(loc, fn);

// ---- Handlers / guards ------------------------------------------------

/** Push `handler` onto `ctx.handlers` for the duration of `fn`; pop in
 *  finally. Thin wrapper over the shared `withPushedHandler` primitive
 *  in `asyncContext.ts` so user code and `AgencyFunction`'s preapprove
 *  factory go through the same encapsulated combinator. */
const withHandler = <T>(
  handler: HandlerFn,
  fn: () => Promise<T>,
): Promise<T> => withPushedHandler(ctx(), handler, fn);

/** Install a `CostGuard(maxCost)` on the active branch's
 *  `StateStack.guards` for the duration of `fn`; pop in finally. */
const withCostGuard = async <T>(
  maxCost: number,
  fn: () => Promise<T>,
): Promise<T> => {
  const stack = ctx().stateStack;
  stack.pushGuard(new CostGuard(maxCost));
  try {
    return await fn();
  } finally {
    stack.popGuard();
  }
};

// ---- Test helpers ------------------------------------------------------

/** Install an ALS frame from explicit `{ctx, stack, threads}` for
 *  tests that exercise stdlib helpers directly. Mirrors
 *  `runInTestContext` with an object-arg signature so it composes
 *  with the rest of the namespace. */
const withTestContext = <T>(
  args: { ctx: RuntimeContext<any>; stack: StateStack; threads: ThreadStore },
  fn: () => T,
): T => runInTestContext(args.ctx, args.stack, args.threads, fn);

// ---- Namespace ---------------------------------------------------------

/**
 * Public `agency` namespace — the canonical entry point for TS code
 * that wants to participate in an Agency run. Users access everything
 * through `agency.<method>(...)`; there are no individual named
 * exports.
 */
export const agency = {
  ctx,
  ctxMaybe,
  callsite,
  global: global_,

  thread: {
    current: threadCurrent,
    user: threadUser,
    system: threadSystem,
    assistant: threadAssistant,
    store: threadStore,
    storeMaybe: threadStoreMaybe,
    with: threadWith,
  },

  checkpoint,
  getCheckpoint,
  restore,
  withCallsite,

  withHandler,
  withCostGuard,

  withTestContext,
};
