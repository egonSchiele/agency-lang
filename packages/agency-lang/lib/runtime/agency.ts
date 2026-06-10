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
 *    `callsite()` is the lone exception: callsite is intrinsically
 *    optional (bootstrap frames omit it) so it always returns
 *    `CallsiteLocation | undefined` even from inside a valid frame.
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
 */
import * as smoltalk from "smoltalk";
import { nanoid } from "nanoid";
import {
  agencyStore,
  getRuntimeContext,
  runInTestContext,
  withCallsite as _withCallsite,
  withPushedHandler,
  type CallsiteLocation,
} from "./asyncContext.js";
import {
  interrupt,
  type InterruptOpts,
} from "./agencyInterrupt.js";
import { llm as _llm } from "./agencyLlm.js";
import {
  checkpoint as _checkpoint,
  getCheckpoint as _getCheckpoint,
  restore as _restore,
} from "./checkpoint.js";
import type { RestoreOptions } from "./errors.js";
import { CostGuard, TimeGuard } from "./guard.js";
import {
  withResumableScope as _withResumableScope,
  type ResumableScope,
  type ResumableScopeOpts,
} from "./resumableScope.js";
import {
  withLockOnCtx,
  type WithLockOptions,
} from "./lock.js";
import { isIpcMode, sendLockAcquireToParent } from "./ipc.js";
import type { Checkpoint } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { StateStack } from "./state/stateStack.js";
import type { MessageThread } from "./state/messageThread.js";
import type { ThreadStore } from "./state/threadStore.js";
import type { HandlerFn } from "./types.js";
import type { MemoryConfig } from "./memory/types.js";
import {
  _enableMemory,
  _disableMemory,
  _setMemoryId,
  _shouldRunMemory,
  _remember,
  _recall,
  _forget,
} from "../stdlib/memory.js";

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
 *  (the bare/anonymous module).
 *
 *  Reads from the active ALS frame's `globals` slot — the same source
 *  generated user code reads via `__globals()`. Inside a `fork` /
 *  `parallel` / `race` branch this is the branch's per-branch
 *  snapshot, NOT the parent's canonical `ctx.globals`. Outside any
 *  branch (top-level node bodies, function calls) the frame's slot
 *  pointer-shares `ctx.globals`, so behavior is identical to the
 *  pre-isolation reads. */
const global_ = <T = unknown>(name: string, moduleId = ""): T =>
  getRuntimeContext().globals.get(moduleId, name) as T;

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
 *  active stack (including on throw) when `fn` returns. Accepts a
 *  sync or async callback. */
const threadWith = async <T>(
  threadId: string,
  fn: () => T | Promise<T>,
): Promise<T> => {
  const store = threadStore();
  store.pushActive(threadId);
  try {
    return await fn();
  } finally {
    store.popActive();
  }
};

// ---- Threads (registry) subnamespace ----------------------------------

/** Plain record describing a thread in the run's registry. Slug-ified
 *  ids (`t0`, `t1`, ...) wrap the internal counter strings so LLMs see
 *  short, easy-to-quote identifiers. `label` and `summary` are
 *  surfaced directly from the underlying `MessageThread` (post-Commit-B:
 *  no more module-level TS cache). */
export type ThreadInfoTS = {
  id: string;
  parentId: string | null;
  threadType: "thread" | "subthread";
  messageCount: number;
  isActive: boolean;
  /** Snapshot of the thread's messages in smoltalk's wire format.
   *  Consumers that need flat `{role, content}` records can call
   *  `m.role` / `m.content` directly; tool-call / structured-content
   *  variants land here untouched (no lossy coercion). */
  messages: smoltalk.MessageJSON[];
  /** Optional user-supplied label from `thread(label: "...") { ... }`.
   *  `null` when no label was given. */
  label: string | null;
  /** Cached summary written by the stdlib's `summaryFor()` helper.
   *  `null` until the summary is computed (lazy on first
   *  `listThreads()`). */
  summary: string | null;
};

/** Convert an internal counter string id (`"0"`, `"1"`, ...) to the
 *  public slug form (`"t0"`, `"t1"`, ...). */
const toSlug = (rawId: string): string => `t${rawId}`;

/** Strip the leading `t` from a public slug to get the internal
 *  counter string id. Only strips when the input matches the
 *  canonical `t<digits>` shape — non-numeric ids (test mocks, ids
 *  that happen to start with `t`) pass through unchanged. Mirrors
 *  `stripSlug` in runner.ts so both call sites treat slugs the
 *  same way. */
const fromSlug = (slug: string): string =>
  /^t\d+$/.test(slug) ? slug.slice(1) : slug;

/** Return every thread in the run's registry as plain records.
 *  Threads created with `thread(hidden: true) { ... }` are filtered
 *  out so library-internal LLM scaffolding (e.g. summarizer prompts)
 *  doesn't show up in user-facing thread enumerations.
 *
 *  Throws when called outside any Agency frame — silently returning
 *  `[]` would mask a misuse (TS helper called from non-Agency code)
 *  that the user would otherwise debug as a confusing empty list. */
const threadsList = (): ThreadInfoTS[] => {
  const store = threadStoreMaybe();
  if (!store) {
    throw new Error(
      "agency.threads.list() called outside an Agency frame. " +
        "It must run inside `agencyStore.run(...)` / a node body — " +
        "wrap test calls with `agency.withTestContext({ctx,stack,threads}, ...)`.",
    );
  }
  const activeId = store.activeId();
  const out: ThreadInfoTS[] = [];
  for (const [rawId, thread] of Object.entries(store.threads)) {
    if (thread.hidden) continue;
    out.push({
      id: toSlug(rawId),
      parentId: thread.parentId ? toSlug(thread.parentId) : null,
      threadType: thread.parentId ? "subthread" : "thread",
      messageCount: thread.messages.length,
      isActive: rawId === activeId,
      messages: thread.messages.map((m) => m.toJSON()),
      label: thread.label,
      summary: thread.summary,
    });
  }
  return out;
};

/** Read a slice of a thread's messages. Returns `[]` for unknown ids
 *  (silent — callers can probe). `offset` and `limit` default to 0 and
 *  50, matching the Agency-side `getThread` signature.
 *
 *  Throws when called outside any Agency frame. */
const threadsGet = (
  id: string,
  offset = 0,
  limit = 50,
): smoltalk.MessageJSON[] => {
  const store = threadStoreMaybe();
  if (!store) {
    throw new Error(
      "agency.threads.get() called outside an Agency frame. " +
        "It must run inside `agencyStore.run(...)` / a node body — " +
        "wrap test calls with `agency.withTestContext({ctx,stack,threads}, ...)`.",
    );
  }
  const rawId = fromSlug(id);
  const thread = store.threads[rawId];
  if (!thread) return [];
  return thread.messages
    .slice(offset, offset + limit)
    .map((m) => m.toJSON());
};

/** Slug form of the currently active thread id, or `undefined` outside
 *  any runtime frame / when no thread is active. */
const threadsCurrent = (): string | undefined => {
  const store = threadStoreMaybe();
  const id = store?.activeId();
  return id !== undefined ? toSlug(id) : undefined;
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

/** Run `fn` with a custom `callsite` (`{moduleId, scopeName, stepPath}`)
 *  installed on the active ALS frame; restore the prior callsite when
 *  `fn` returns. The callsite is the source location used to attribute
 *  any `checkpoint()` made inside `fn` — `Runner.runInScope` seeds it
 *  automatically for every Agency step, but TS helpers that subdivide
 *  their own work into substeps can use this to give each substep a
 *  distinct location in debugger UIs / trace files.
 *
 *  Example:
 *    agency.withCallsite(
 *      { moduleId: "my.helper", scopeName: "retry", stepPath: "2.1" },
 *      async () => { await agency.checkpoint(); ... },
 *    );
 *
 *  Most TS helpers will never need this — the auto-seeded callsite
 *  from the surrounding step is the right answer. Throws if no
 *  Agency frame is installed. */
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

/** Install a `CostGuard(maxCost)` on the active branch's `StateStack.guards`
 *  for the duration of `fn`; pop in finally.
 *
 *  Pushes onto `getRuntimeContext().stack` — the ALS-resolved
 *  per-branch stack — NOT `ctx().stateStack` (which is the top-level
 *  stack). Inside a fork/race branch the two stacks differ; pushing
 *  on the wrong one would leak the guard into sibling branches. */
const withCostGuard = async <T>(
  maxCost: number,
  fn: () => Promise<T>,
): Promise<T> => {
  const stack = getRuntimeContext().stack;
  stack.pushGuard(new CostGuard(maxCost));
  try {
    return await fn();
  } finally {
    stack.popGuard();
  }
};

/** Install a `TimeGuard(maxMs)` on the active branch's stack for the
 *  duration of `fn`; pop in finally. Same ALS-stack semantics as
 *  `withCostGuard`. */
const withTimeGuard = async <T>(
  maxMs: number,
  fn: () => Promise<T>,
): Promise<T> => {
  const stack = getRuntimeContext().stack;
  stack.pushGuard(new TimeGuard(maxMs));
  try {
    return await fn();
  } finally {
    stack.popGuard();
  }
};

/** Run `fn` while holding a per-run named mutex. Concurrent branches in
 *  the same run that use the same `name` execute one at a time; different
 *  lock names do not block each other. The lock is released in `finally`,
 *  so interrupts and throws unwind safely. */
const withLock = async <T>(
  name: string,
  fn: () => T | Promise<T>,
  opts: WithLockOptions = {},
): Promise<T> => {
  const store = getRuntimeContext();
  const ownerId = opts.ownerId ?? lockOwnerIdForActiveStack();
  const lockOpts = { ...opts, ownerId };
  if (isIpcMode()) {
    const release = await sendLockAcquireToParent(name, lockOpts);
    try {
      return await fn();
    } finally {
      release();
    }
  }
  return withLockOnCtx(store.ctx, name, fn, lockOpts);
};

function lockOwnerIdForActiveStack(): string {
  const stack = getRuntimeContext().stack;
  if (!stack.lockOwnerId) {
    stack.lockOwnerId = `lock-owner:${nanoid()}`;
  }
  return stack.lockOwnerId;
}

/** Add `amount` (USD, float) to the active branch's cost accumulator
 *  and bill every installed guard. Throws `GuardExceededError` if any
 *  guard has tripped.
 *
 *  Intended for TS helpers that wrap their own LLM (or other paid)
 *  call site and want the cost to participate in `agency.getCost()` /
 *  `agency.withCostGuard()` tracking the same way the built-in `llm()`
 *  primitive does. The built-in path in `lib/runtime/prompt.ts` does
 *  exactly this sequence after every completion. */
const addCost = (amount: number): void => {
  const stack = getRuntimeContext().stack;
  stack.localCost += amount;
  stack.chargeGuards(amount);
  stack.enforceGuards();
};

// ---- Memory subnamespace ---------------------------------------------

/** Push a memory frame onto the active branch's stateStack. See
 *  `stdlib/memory.agency`'s `enableMemory` for the user-facing
 *  contract — same dir as top is a no-op, different dir stacks. */
const memoryEnable = (config: MemoryConfig): Promise<void> =>
  _enableMemory(config);

/** Pop the top memory frame on the active branch's stateStack.
 *  Pops the JSON-seeded bottom frame too — library authors should
 *  not call this casually. */
const memoryDisable = (): void => _disableMemory();

/** Set the memory scope id (orthogonal to which frame is active —
 *  persists across pushes/pops). */
const memorySetId = (id: string): Promise<void> => _setMemoryId(id);

/** `true` iff a memory frame is currently active on the branch. */
const memoryEnabled = (): boolean => _shouldRunMemory();

/** Extract + store facts from `content`. No-op when no frame is active. */
const memoryRemember = (content: string): Promise<void> => _remember(content);

/** Retrieve facts as a formatted string. Empty string when no frame
 *  is active or nothing matches. */
const memoryRecall = (query: string): Promise<string> => _recall(query);

/** Soft-delete facts matching `query`. No-op when no frame is active. */
const memoryForget = (query: string): Promise<void> => _forget(query);

// ---- Test helpers ------------------------------------------------------

/**
 * @internal
 * Install an ALS frame from explicit `{ctx, stack, threads}` for
 * tests that exercise stdlib helpers directly. Mirrors
 * `runInTestContext` with an object-arg signature so test bodies
 * compose with the rest of the namespace. Not intended for
 * production TS-helper code — application code runs inside an
 * Agency frame already seeded by `Runner.runInScope`.
 */
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
  withTimeGuard,
  withLock,
  addCost,

  withResumableScope: _withResumableScope,

  llm: _llm,

  interrupt,

  memory: {
    enable: memoryEnable,
    disable: memoryDisable,
    setId: memorySetId,
    enabled: memoryEnabled,
    remember: memoryRemember,
    recall: memoryRecall,
    forget: memoryForget,
  },

  threads: {
    list: threadsList,
    get: threadsGet,
    current: threadsCurrent,
  },

  withTestContext,
};

export type { InterruptOpts, ResumableScope, ResumableScopeOpts };
export type { MemoryConfig, WithLockOptions };
