import type { Guard, GuardExceededError, GuardJSON } from "../guard.js";
import type { HandlerEntry } from "../types.js";
import type { ReplyAttachmentPart } from "../replyAttachments.js";
import { guardFromJSON, TimeGuard } from "../guard.js";
import { sendCostTelemetryToParent } from "../costTelemetry.js";
import { Checkpoint } from "../index.js";
import { MemoryFrame } from "../memory/frame.js";
import { deepClone } from "../utils.js";
import { agencyStore } from "../asyncContext.js";
import type { GlobalStoreJSON } from "./globalStore.js";
import { ThreadStoreJSON } from "./threadStore.js";

export type BranchState = {
  // each branch gets its own state stack
  // so it doesn't push/pop frames on other threads' stacks
  stack: StateStack;

  // if an interrupt is thrown in this branch,
  // we save its info here
  interruptId?: string;
  interruptData?: any;

  checkpoint?: Checkpoint;

  // cached result for completed fork threads.
  // wrapped in an object to distinguish "no result" from "result is undefined".
  result?: { result: any };

  // Live AbortController for per-branch cancellation (used by race mode to
  // abort losing branches when the winner resolves). NOT serialized — only
  // meaningful within a single execution.
  abortController?: AbortController;

  // Live-only flag: true iff this branch's stack has already had its
  // inherited (parent-owned) guard references prepended in the current
  // execution. Reset to undefined automatically on deserialize because
  // it's never serialized. Used by `rehydrateInheritedGuards` in
  // runBatch.ts to avoid double-prepending on multiple runBatch
  // re-entries in the same run.
  guardsRehydrated?: boolean;

  /** Per-branch GlobalStore snapshot, captured by `runInBranchAlsFrame`
   *  when the branch body settles as an `Interrupt[]`. Persisted on
   *  serialization so that on resume the branch sees the same globals
   *  it had pre-interrupt instead of a fresh clone of the parent's
   *  (now-possibly-stale) values. Populated for `shareGlobals: false`
   *  branches that interrupt; absent for `shareGlobals: true` callers
   *  (runPrompt's tool dispatch and user `shared: true`), which
   *  pointer-share the parent's globals at every re-entry. */
  globalsJSON?: GlobalStoreJSON;

  /** Per-branch `activeStack` snapshot, captured alongside
   *  `globalsJSON`. The threads registry itself is shared across
   *  branches and serialized once on the top-level frame; only the
   *  active-thread pointer is per-branch. Restored into a fresh
   *  `ThreadView` on resume so unguarded `llm()` / `userMessage()`
   *  calls inside a resumed branch resume against the same subthread
   *  they were writing to before the interrupt. */
  activeStack?: string[];
};

export type BranchStateJSON = {
  stack: StateStackJSON;
  interruptId?: string;
  interruptData?: any;
  result?: { result: any };
  globalsJSON?: GlobalStoreJSON;
  activeStack?: string[];
};

// the state for each frame (a node, or a function call)
export class State {
  args: Record<string, any>;
  locals: Record<string, any>;
  threads: ThreadStoreJSON | null;
  step: number;
  private branches?: Record<string, BranchState>;
  private deletedBranches?: Set<string>;
  scopedCallbacks?: Array<{ name: string; fn: any }>;
  /** saveDraft's best-so-far value for THIS scope. Wrapped so a saved
   *  null is distinct from "no draft". Serialized: a draft must survive
   *  interrupt/resume. Read only by this frame's own catch rung (the
   *  carry-on-abort level rule); no other code walks it. */
  savedDraft?: { value: any };
  /** The scope that CLAIMED this frame (pulled it from the stack via
   *  setupFunction/setupNode), stamped by claimFrameForScope at the
   *  claim sites: generated function/node/block preambles, runPrompt,
   *  and withResumableScope. Null means never claimed. Claiming and
   *  RUNNING are different events — a finalize Runner runs on its
   *  container's frame and must not stamp — so the Runner constructor
   *  never touches this. Always serialized; a mismatched claim on
   *  resume replay is state corruption and throws. */
  scopeName: string | null = null;

  constructor(
    opts: {
      args?: Record<string, any>;
      locals?: Record<string, any>;
      threads?: ThreadStoreJSON | null;
      step?: number;
      branches?: Record<string, BranchState>;
    } = {},
  ) {
    this.args = opts.args ?? {};
    this.locals = opts.locals ?? {};
    this.threads = opts.threads ?? null;
    this.step = opts.step ?? 0;
    if (opts.branches) this.branches = opts.branches;
  }

  /** Delete all entries in locals whose key starts with the given prefix.
   * Used by loops to reset nested tracking variables (condbranch, substep, iteration)
   * at the end of each iteration. */
  clearLocalsWithPrefix(prefix: string): void {
    for (const key of Object.keys(this.locals)) {
      if (key.startsWith(prefix)) {
        delete this.locals[key];
      }
    }
  }

  /** Reset all loop tracking state for a given loop identified by its subKey.
   * Resets the substep counter to 0 and clears all nested condbranch, substep,
   * and iteration tracking variables. Used at the end of each loop iteration
   * and before break/continue statements. */
  resetLoopIteration(subKey: string): void {
    this.locals[`__substep_${subKey}`] = 0;
    this.clearLocalsWithPrefix(`__condbranch_${subKey}.`);
    this.clearLocalsWithPrefix(`__substep_${subKey}.`);
    this.clearLocalsWithPrefix(`__iteration_${subKey}.`);
  }

  removeDebugFlags(): void {
    this.clearLocalsWithPrefix("__dbg_");
  }

  /** The sanctioned way to register a scoped callback on this frame. Initializes
   *  the array on first call so frames with no callbacks pay no overhead. */
  addScopedCallback(name: string, fn: any): void {
    if (!this.scopedCallbacks) this.scopedCallbacks = [];
    this.scopedCallbacks.push({ name, fn });
  }

  newBranch(key: string): BranchState {
    if (!this.branches) this.branches = {};
    if (this.branches[key]) {
      throw new Error(`Branch with key ${key} already exists`);
    }
    const branch: BranchState = { stack: new StateStack() };
    this.branches[key] = branch;
    return branch;
  }

  getBranch(key: string): BranchState | undefined {
    if (!this.branches) return undefined;
    if (this.deletedBranches?.has(key)) {
      throw new Error(
        `Tried to access branch with key ${key}, but it has been deleted`,
      );
    }
    return this.branches[key];
  }

  getOrCreateBranch(key: string): BranchState {
    const existing = this.getBranch(key);
    if (existing) return existing;
    return this.newBranch(key);
  }

  getBranchOrThrow(key: string): BranchState {
    const branch = this.getBranch(key);
    if (!branch) {
      throw new Error(`Branch with key ${key} does not exist`);
    }
    return branch;
  }

  deleteBranch(key: string): void {
    if (this.branches) {
      this.deletedBranches = this.deletedBranches || new Set<string>();
      this.deletedBranches.add(key);
      delete this.branches[key];
    }
  }

  setResultOnBranch(key: string, result: any): void {
    const branch = this.getBranchOrThrow(key);
    branch.result = { result };
  }

  setInterruptOnBranch(
    key: string,
    interruptId: string,
    interruptData: any,
    checkpoint?: Checkpoint,
  ): void {
    const branch = this.getBranchOrThrow(key);
    branch.interruptId = interruptId;
    branch.interruptData = interruptData;
    if (checkpoint) {
      branch.checkpoint = checkpoint;
    }
  }

  popBranches(): void {
    this.branches = {};
    this.deletedBranches = new Set<string>();
  }

  deserializeMode(): void {
    if (this.branches) {
      for (const branch of Object.values(this.branches)) {
        branch.stack.deserializeMode();
      }
    }
  }

  /** Visit every branch stack hanging off this frame. Branches are
   *  private; this is the read path for walks that must cover the whole
   *  branch subtree (StateStack.assertNoExecutingHandlers). */
  forEachBranchStack(fn: (stack: StateStack) => void): void {
    if (this.branches) {
      for (const branch of Object.values(this.branches)) {
        fn(branch.stack);
      }
    }
  }

  toJSON(): StateJSON {
    const json: StateJSON = {
      args: deepClone(this.args),
      locals: deepClone(this.locals),
      threads: this.threads ? deepClone(this.threads) : null,
      step: this.step,
      scopeName: this.scopeName,
    };
    if (this.scopedCallbacks && this.scopedCallbacks.length > 0) {
      // Pass `fn` through as a reference — the outer serializer (with
      // nativeTypeReplacer) handles AgencyFunctions correctly via the
      // functionRef registry. deepClone-ing here would lose plain functions.
      json.scopedCallbacks = this.scopedCallbacks.map((cb) => ({
        name: cb.name,
        fn: cb.fn,
      }));
    }
    if (this.savedDraft !== undefined) {
      json.savedDraft = deepClone(this.savedDraft);
    }
    if (this.branches) {
      json.branches = {};
      for (const [key, branch] of Object.entries(this.branches)) {
        const branchJson: Partial<BranchStateJSON> = {};

        if (branch.checkpoint) {
          branchJson.stack = branch.checkpoint.stack;
        } else {
          branchJson.stack = branch.stack.toJSON();
        }

        if (branch.interruptId) branchJson.interruptId = branch.interruptId;
        if (branch.interruptData)
          branchJson.interruptData = branch.interruptData;
        if (branch.result !== undefined)
          branchJson.result = deepClone(branch.result);
        // Per-branch globals + activeStack snapshots captured by
        // `runInBranchAlsFrame` so a resumed branch sees its own
        // pre-interrupt state instead of a freshly-cloned parent.
        // Absent for pointer-shared dials: `shareGlobals: true`
        // (runPrompt tool dispatch + user `shared: true`) skips the
        // globals snapshot; `shareThreads: true` (runPrompt only)
        // skips the activeStack snapshot.
        if (branch.globalsJSON !== undefined)
          branchJson.globalsJSON = branch.globalsJSON;
        if (branch.activeStack !== undefined)
          branchJson.activeStack = branch.activeStack;
        json.branches[key] = branchJson as BranchStateJSON;
      }
    }
    return json;
  }

  static fromJSON(json: StateJSON): State {
    const state = new State({
      args: json.args,
      locals: json.locals,
      threads: json.threads,
      step: json.step,
    });
    state.scopeName = json.scopeName ?? null;
    if (json.scopedCallbacks && json.scopedCallbacks.length > 0) {
      state.scopedCallbacks = json.scopedCallbacks.map((cb) => ({
        name: cb.name,
        fn: cb.fn,
      }));
    }
    if (json.savedDraft !== undefined) {
      state.savedDraft = json.savedDraft;
    }
    if (json.branches) {
      state.branches = {};
      for (const [key, branch] of Object.entries(json.branches)) {
        const branchState: BranchState = {
          stack: StateStack.fromJSON(branch.stack),
        };
        if (branch.interruptId) branchState.interruptId = branch.interruptId;
        if (branch.interruptData)
          branchState.interruptData = branch.interruptData;
        if (branch.result !== undefined) branchState.result = branch.result;
        // Per-branch globals + activeStack snapshots captured by
        // `runInBranchAlsFrame` before the interrupt. On re-entry
        // the resumed branch restores them instead of cloning fresh
        // from the parent, so writes made before the interrupt are
        // preserved across the resume boundary.
        if (branch.globalsJSON !== undefined)
          branchState.globalsJSON = branch.globalsJSON;
        if (branch.activeStack !== undefined)
          branchState.activeStack = branch.activeStack;
        state.branches[key] = branchState;
      }
    }
    return state;
  }
}

export type StateJSON = {
  args: Record<string, any>;
  locals: Record<string, any>;
  threads: ThreadStoreJSON | null;
  step: number;
  scopeName: string | null;
  branches?: Record<string, BranchStateJSON>;
  scopedCallbacks?: Array<{ name: string; fn: any }>;
  savedDraft?: { value: any };
};

/** Stamp-or-check a frame claim. First claim stamps; a mismatched later
 *  claim means resume replay handed this frame to the wrong function —
 *  state corruption, so throw (house precedent: the guard-stack drift
 *  throw in cloneForBranch below). Claiming and RUNNING are different
 *  events — finalize Runners run on their container's frame and must
 *  not stamp — so this is called from frame-claim sites only, never
 *  the Runner constructor. Empty names never stamp: they mean a claim
 *  site forgot its name (Runner defaults scopeName to "").
 *  The statelog emit is not redundant with the throw: throws convert
 *  to Failures at def boundaries and can be laundered downstream; the
 *  event is the signal that survives. Best-effort via the ALS pattern
 *  (no store in bare unit tests means no emit; the throw still fires). */
export function claimFrameForScope(frame: State, scopeName: string): void {
  if (!scopeName) return;
  if (frame.scopeName === null || frame.scopeName === undefined) {
    frame.scopeName = scopeName;
    return;
  }
  if (frame.scopeName !== scopeName) {
    const msg =
      `Resume desync: function "${scopeName}" tried to claim the saved ` +
      `state of "${frame.scopeName}". This is a compiler/runtime bug — ` +
      `please report it with the program that produced it.`;
    agencyStore.getStore()?.ctx?.statelogClient?.error?.({
      errorType: "runtimeError",
      message: msg,
      functionName: scopeName,
    });
    throw new Error(msg);
  }
}

export type StateStackJSON = {
  stack: StateJSON[];
  mode: "serialize" | "deserialize";
  other: Record<string, any>;
  deserializeStackLength: number;
  nodesTraversed: string[];
  localCost?: number;
  localTokens?: number;
  seedCost?: number;
  seedTokens?: number;
  /** Branch-owned guards only. Inherited (parent-owned) guards are
   *  serialized on the parent's snapshot and re-prepended at resume by
   *  `runBatch`. See StateStack.guards. */
  guards?: GuardJSON[];
  /** Number of parent-owned guard references that were prepended onto
   *  this stack's `guards` at branch creation. NOT a count of entries
   *  in the serialized `guards` array (those are branch-owned only).
   *  Used by `StateStack.rehydrateInheritedGuardsFrom` on resume to
   *  validate that the parent's guard stack hasn't drifted. Always 0
   *  for the root stack. */
  inheritedGuardCount?: number;
  /** Inherited TIME guards, serialized WITH the branch. Unlike cost
   *  guards (shared references, correctly re-attached by re-cloning
   *  from the parent on resume), a time clone is branch-OWNED state:
   *  its accrued working time and remaining budget would reset if
   *  resume re-cloned it. `rehydrateInheritedGuardsFrom` adopts these
   *  by guardId instead of calling cloneForBranch. */
  inheritedTimeGuards?: GuardJSON[];
};

export class StateStack {
  stack: State[] = [];
  mode: "serialize" | "deserialize" = "serialize";
  lockOwnerId?: string;

  other: Record<string, any> = {};
  deserializeStackLength: number = 0;

  /** Queue an attachment for the model (backs std::thread.attachToReply).
   *  Branch-local: each parallel tool call runs on its own branch stack,
   *  so queues cannot mix; the entry lives in `other`, which serializes,
   *  so a mid-round interrupt cannot drop it. The tool loop drains it at
   *  invocation completion — see lib/runtime/replyAttachments.ts. */
  queueReplyAttachment(part: ReplyAttachmentPart): void {
    this.other.pendingReplyAttachments ??= [];
    (this.other.pendingReplyAttachments as ReplyAttachmentPart[]).push(part);
  }

  /** Drain (return and clear) the attachments queued on this stack by
   *  queueReplyAttachment. Called by the tool loop exactly once per tool
   *  invocation, at completion. */
  drainPendingReplyAttachments(): ReplyAttachmentPart[] {
    const queued = (this.other.pendingReplyAttachments ??
      []) as ReplyAttachmentPart[];
    delete this.other.pendingReplyAttachments;
    return queued;
  }
  nodesTraversed: string[] = [];

  // currently not serialized, but used to track if we've hit an interrupt in the current branch
  interrupted: boolean = false;
  hasChildInterrupts: boolean = false;

  /** Handler entries executing on this branch, innermost last. The
   *  dispatcher (runHandlerChain) pushes before a handler body runs and
   *  pops after. This list serves the PAUSE side of issue #616 only:
   *  the guard-trip refusals and the interrupt-pause checkpoint
   *  assertions read it. Self-exclusion (a handler never hears its own
   *  raises) does NOT read it — that stays on the executingHandlers.ts
   *  ALS, because exclusion needs per-lineage precision this per-branch
   *  list cannot give (a concurrent sibling dispatch must still reach a
   *  handler another dispatch is executing). Lives on the stack rather
   *  than an AsyncLocalStorage so every pause-side reader reaches it
   *  through a plain object reference it already holds — there is no
   *  ambient lookup to lose. Never serialized: no interrupt-pause
   *  checkpoint may exist while it is non-empty
   *  (assertNoExecutingHandlers), so a deserialized stack correctly
   *  starts empty.
   *  See docs/superpowers/specs/2026-07-19-issue-616-no-pause-inside-handlers-design.md */
  executingHandlerEntries: HandlerEntry[] = [];

  /** Snapshot the parent mark into this branch stack. runBatch calls
   *  this alongside guard rehydration for every branch it starts: a
   *  branch created while a handler executes runs while that handler
   *  executes (all runBatch modes join before returning), so it
   *  inherits the exclusion identity and the no-pause refusal. A
   *  snapshot, not a shared reference — the parent pops its entries on
   *  handler exit and the branch must not observe that mid-flight. */
  adoptExecutingHandlersFrom(parent: StateStack): void {
    this.executingHandlerEntries = [...parent.executingHandlerEntries];
  }

  /** Throw if any handler is executing on this stack or any branch
   *  under it. Called at the interrupt-pause checkpoint sites: handlers
   *  have no step address, so a pause taken mid-handler could never be
   *  resumed. Walks branches because a mark can live on a branch stack
   *  whose parent is unmarked (a tool-call branch created inside a
   *  handler). */
  assertNoExecutingHandlers(): void {
    if (this.executingHandlerEntries.length > 0) {
      throw new Error(
        "Cannot pause the run while a handler function is executing: " +
          "handlers have no step address, so this checkpoint could never " +
          "be resumed. This is a runtime bug — an in-handler pause path " +
          "was reached. See issue #616.",
      );
    }
    for (const frame of this.stack) {
      frame.forEachBranchStack((branchStack) =>
        branchStack.assertNoExecutingHandlers(),
      );
    }
  }

  // Per-branch abort signal. Set by Runner.runRace / Runner.runForkAll on each
  // branch's stack. When the parent fork/race aborts a losing branch, this
  // signal fires; runtime checks (ctx.isCancelled, smoltalk's HTTP signal)
  // observe it and stop work in the affected branch only.
  // NOT serialized — purely a live execution concept.
  /** The branch's cancellation signal, DERIVED: the base signal (set by
   *  non-guard machinery — a fork/race branch's composed parent+controller
   *  signal, Esc handling, tests) composed with every armed guard's own
   *  signal. Guards no longer mutate this field; they expose
   *  `armedSignal()` and the stack composes on demand.
   *
   *  Why derived instead of accumulated: the old design had each TimeGuard
   *  save `previousSignal` and overwrite the field with
   *  `AbortSignal.any([previous, mine])` — order-dependent mutable state
   *  whose re-arm (needed when a trip is APPROVED) meant restore-then-
   *  recompose in exactly the right order, rebuilding every composition
   *  layered above the tripped guard. Deriving deletes the whole problem:
   *  re-arm is "the guard is armed again; rebuild".
   *
   *  Freshness is structural, not a vigilance rule: an operation captures
   *  the signal when it starts, and an operation holding a PRE-rebuild
   *  composite was, by definition, in flight when the trip fired — which
   *  makes it exactly the operation the trip cancelled. New work reads
   *  the getter and sees the live composite. */
  get abortSignal(): AbortSignal | undefined {
    return this.composedAbortSignal ?? this.baseAbortSignal;
  }

  set abortSignal(signal: AbortSignal | undefined) {
    this.baseAbortSignal = signal;
    this.rebuildAbortSignal();
  }

  private baseAbortSignal?: AbortSignal;
  private composedAbortSignal?: AbortSignal;

  /** Recompose from the base plus every armed guard. Called by the
   *  setter, by pushGuard/popGuard, by TimeGuard when it (re)mints its
   *  controller, and by GuardScope.extend after an approve re-arms a
   *  tripped guard. Mints a NEW composite each time (an aborted
   *  AbortSignal cannot be un-aborted). */
  rebuildAbortSignal(): void {
    const armed = this.guards
      .map((g) => g.armedSignal())
      .filter((s): s is AbortSignal => s !== undefined);
    if (armed.length === 0) {
      this.composedAbortSignal = undefined;
      return;
    }
    const sources = this.baseAbortSignal
      ? [this.baseAbortSignal, ...armed]
      : armed;
    this.composedAbortSignal =
      sources.length === 1 ? sources[0] : AbortSignal.any(sources);
  }

  // Per-branch cumulative LLM cost (USD) and tokens. Seeded from the parent
  // stack's value when this stack is created as a fork/race branch; otherwise
  // starts at 0. LLM calls in runPrompt add their cost/tokens here. On join,
  // each branch's delta (branch.localCost - branch.seedCost) propagates back
  // to the parent stack. See docs/superpowers/specs/2026-05-20-thread-
  // builtins-and-stdlib-design.md for the full model.
  localCost: number = 0;
  localTokens: number = 0;

  // Immutable baseline captured at branch-creation time: the parent's
  // localCost/localTokens at the moment this branch was seeded. Used by
  // Runner.propagateBranchCost to compute the branch's delta independently
  // of the parent's *current* totals — important when other sibling
  // branches' deltas have already been folded into the parent (e.g., race
  // losers propagated at interrupt time, winner propagated later on resume).
  seedCost: number = 0;
  seedTokens: number = 0;

  // Active guard scopes on this stack, innermost last. Walked after
  // every LLM cost accumulation in prompt.ts (CostGuard) and on every
  // Runner.shouldSkip (TimeGuard) to enforce limits.
  // Serialized so guards survive interrupt/resume cycles. Each guard
  // decides whether it gets cloned into fork/race branches via
  // `cloneForBranch` — see lib/runtime/guard.ts.
  //
  // For child branches (fork/race), entries at index < inheritedGuardCount
  // are SHARED REFERENCES to parent-owned guards (CostGuard.cloneForBranch
  // returns `this`). Entries at index >= inheritedGuardCount were pushed
  // by the branch itself (e.g. a `guard(...)` block opened inside the
  // branch body). Serialization writes only the branch-owned guards; on
  // resume the runtime re-prepends live references to the parent's guards.
  // This is what makes real-time mid-fork enforcement work without
  // double-serializing shared state.
  guards: Guard[] = [];
  inheritedGuardCount: number = 0;
  /** Deserialized inherited TIME clones awaiting adoption by
   *  `rehydrateInheritedGuardsFrom` (matched to parent guards by
   *  guardId). Live-only staging — never re-serialized; cleared once
   *  rehydrate consumes it. See StateStackJSON.inheritedTimeGuards.
   *
   *  INVARIANT: adoption is MANDATORY. A resume path that deserializes
   *  a branch stack and runs user code without calling
   *  `rehydrateInheritedGuardsFrom` would silently drop the inherited
   *  time budget (no enforcement, no error). All branch re-entry goes
   *  through runBatch today (startInvoke / runRaceResume), which
   *  rehydrates; `chargeGuards`/`enforceGuards` assert this so a
   *  future path that skips rehydrate fails loudly at its first
   *  enforcement point instead. */
  parkedInheritedTimeGuards: Guard[] = [];

  /** Throw if deserialized inherited time clones were never adopted —
   *  see the invariant on `parkedInheritedTimeGuards`. */
  private assertNoParkedGuards(): void {
    if (this.parkedInheritedTimeGuards.length > 0) {
      throw new Error(
        "StateStack: inherited time-guard clones were deserialized but " +
          "never adopted — a resume path skipped " +
          "rehydrateInheritedGuardsFrom, so this branch would run with " +
          "no time enforcement. This is a runtime bug.",
      );
    }
  }

  /** Lazy accessor for the frame array, creating it on first push.
   *  Created with sentinel-marking semantics: once the array exists
   *  (even if popped to empty), `hasMemoryFrameStack()` returns true,
   *  which distinguishes "user explicitly disabled memory" from
   *  "stack restored from a pre-memoryFrames checkpoint". */
  private memoryFramesArr(): MemoryFrame[] | undefined {
    return this.other.memoryFrames as MemoryFrame[] | undefined;
  }

  /** True iff the memory-frame stack has been touched on this
   *  StateStack (push or pop has run at least once). Returns false
   *  for stacks restored from pre-memoryFrames checkpoints, which is
   *  the only legitimate trigger for the JSON-config re-seed back
   *  in `getActiveMemoryManager`. */
  hasMemoryFrameStack(): boolean {
    return this.memoryFramesArr() !== undefined;
  }

  /**
   * Push a memory frame onto this stack. Frames live in `other.memoryFrames`
   * so they serialize and fork-clone for free via the existing
   * `other` deepClone path. Callers MUST NOT touch the underlying
   * array directly — go through these methods.
   *
   * Same-`configKey` as the active frame is a no-op so the common
   * pattern `static const _ = enableMemory(...)` + an
   * `enableMemory(...)` in `main()` doesn't double-stack the same
   * frame. Different-dir pushes stack on top; pop with
   * `popMemoryFrame()` or use the `memory(){}` block for lexical
   * scoping.
   *
   * Returns `true` if the frame was actually pushed, `false` if
   * deduped. The block form (`memory(){}` in stdlib/memory.agency)
   * pairs this with `popMemoryFrame()` so a no-op push doesn't
   * unbalance the pop. ALWAYS materializes `other.memoryFrames` (even
   * on dedup) so `hasMemoryFrameStack()` flips true on first push —
   * checkpoints from this point on are recognised as "memory-aware".
   */
  pushMemoryFrame(frame: MemoryFrame): boolean {
    const existing = this.memoryFramesArr() ?? [];
    if (this.memoryFramesArr() === undefined) {
      // Materialize so hasMemoryFrameStack() flips true; protects
      // against the dedup-no-push case looking identical to a fresh
      // stack on a future resume.
      this.other.memoryFrames = existing;
    }
    const top = this.activeMemoryFrame();
    if (top && MemoryFrame.equals(top, frame)) return false;
    existing.push(frame);
    return true;
  }

  /**
   * Seed this stack's memory state (active id + frame stack) from a
   * parent stack at fork time, so a branch INHERITS the run-wide memory
   * config while its own later `setMemoryId` / `enableMemory` /
   * `disableMemory` affect only this branch. The frame stack is
   * shallow-copied (a fresh array sharing the immutable `MemoryFrame`
   * refs) so push/pop on the branch can't mutate the parent's array;
   * `memoryId` is a string copy. Caller must only invoke this on a FRESH
   * branch — see `inheritBranchMemory` in `runBatch.ts`, which guards on
   * the branch not yet having its own memory state so a resumed branch
   * keeps its serialized frames/id.
   */
  inheritMemoryFrom(parent: StateStack): void {
    const pid = parent.other.memoryId;
    if (typeof pid === "string") {
      this.other.memoryId = pid;
    }
    const pframes = parent.memoryFramesArr();
    if (pframes !== undefined) {
      this.other.memoryFrames = [...pframes];
    }
    // Run-wide LLM defaults set via `std::llm` (setLlmOptions/setModel)
    // ride the same branch inheritance: a fork branch inherits the
    // parent's defaults at fork time, then its own setLlmOptions mutates
    // this shallow copy — never the parent's object.
    const pllm = parent.other.llmDefaults;
    if (pllm !== undefined) {
      this.other.llmDefaults = { ...pllm };
    }
  }

  /** Pop the top memory frame, including the JSON-seeded bottom frame.
   *  Returns the popped frame or `undefined` if the stack is already
   *  empty.
   *
   *  When the last frame is popped the array stays present (but
   *  empty) so `activeMemoryFrame()` returns `undefined` and the
   *  old-checkpoint re-seed in `getActiveMemoryManager()` knows the
   *  user explicitly disabled memory rather than restored an
   *  ancient snapshot. */
  popMemoryFrame(): MemoryFrame | undefined {
    return this.memoryFramesArr()?.pop();
  }

  /** The active memory frame, or `undefined` if memory is currently off. */
  activeMemoryFrame(): MemoryFrame | undefined {
    return this.memoryFramesArr()?.at(-1);
  }

  pushGuard(guard: Guard): void {
    // Push BEFORE install: the derived abort signal composes from
    // `this.guards`, so the guard must be in the array when install's
    // controller mint triggers the rebuild.
    this.guards.push(guard);
    guard.install(this);
    this.rebuildAbortSignal();
  }

  popGuard(): Guard | undefined {
    const guard = this.guards.pop();
    if (guard) guard.uninstall(this);
    // Recomposing WITHOUT the popped guard is what the old design's
    // previousSignal-restore achieved, minus the ordering hazards.
    this.rebuildAbortSignal();
    return guard;
  }

  /**
   * Walk active guards innermost-first and throw the first
   * `GuardExceededError` returned by `guard.check(this)`. Used by
   * `prompt.ts` as both the pre-call gate (refuse to issue a request
   * we're already over budget for) and the post-call check (trip after
   * the response cost has been billed).
   *
   * Innermost-first means the most recently pushed guard reports its
   * trip first. This is a stable, scope-local rule rather than a
   * global-minimum search; a shallower outer guard with a tighter
   * budget would still trip on a later LLM call if the inner doesn't
   * fail first.
   */
  enforceGuards(): void {
    this.assertNoParkedGuards();
    const err = this.detectTrippedGuard();
    if (err) throw err;
  }

  /** THE guard-trip walk: innermost-first, suspension-aware. Every
   *  caller that asks "did a guard trip?" goes through here —
   *  `enforceGuards` (the throwing form) and `Runner.shouldSkip` (which
   *  re-throws an undelivered trip at step boundaries). One walk, one
   *  suspension rule: a walk that skipped the `suspendedGuardIds`
   *  consult would let a suspended, over-budget CostGuard throw its
   *  trip out of the very handler that suspended it (CostGuard's
   *  object-level suspend() is a deliberate no-op — see guard.ts — so
   *  the object cannot decline on its own). Returns the trip error
   *  instead of throwing so callers keep their own throw semantics.
   *  This is also the detection sibling the resumable-guards plan's
   *  PR 2 raise sites need. */
  /** Side-effect-free probe: is any unsuspended guard over budget and
   *  armed right now? Unlike detectTrippedGuard, this never calls
   *  check() — TimeGuard's check consumes its one-shot trip latch, so
   *  probing through it would eat a real trip. Used to gate optional
   *  paid work (memory hooks) in the window between a crossing charge
   *  and the next guard gate. */
  anyGuardOverBudget(): boolean {
    return this.guards.some(
      (g) =>
        !this.suspendedGuardIds.includes(g.guardId) && g.overBudgetAndArmed(),
    );
  }

  /** Non-consuming probe for the runner's step-boundary raise: the
   *  innermost unsuspended, non-root guard with a live trip to ask
   *  about (Guard.raisableTripAtStep — in practice time guards only;
   *  cost belongs to the PromptRunner gates). Unlike detectTrippedGuard
   *  this never calls check() (which consumes TimeGuard's one-shot
   *  latch); the raise machinery itself produces the error via the
   *  consuming walk once it commits. */
  firstRaisableTrip(): Guard | null {
    // findLast = innermost first, with no per-step array copy (this
    // probe runs at every step boundary).
    return (
      this.guards.findLast(
        (g) =>
          !g.isRootBudget &&
          !this.suspendedGuardIds.includes(g.guardId) &&
          g.raisableTripAtStep(),
      ) ?? null
    );
  }

  /** Settle the guards in `ids`: the boundary that owned them
   *  (_runGuarded) has produced its result, so their trips are moot for
   *  the one remaining step before _popGuard removes them. suspend()
   *  is exactly the needed off-switch — it pauses the clock, cancels
   *  the armed timer, and makes raisableTripAtStep and check() decline.
   *  CostGuard.suspend() is a deliberate no-op, which is also correct:
   *  cost guards are never step-raisable, and a SHARED cost guard must
   *  keep metering sibling branches. */
  settleGuards(ids: string[]): void {
    this.guards
      .filter((g) => ids.includes(g.guardId))
      .forEach((g) => g.suspend());
    this.rebuildAbortSignal();
  }

  /** Reviewer feedback from `approve({message})`, waiting for this
   *  branch's next model request (resumable-guards PR 4). The queue
   *  lives in `other` so it is branch-local (each fork branch has its
   *  own StateStack) and serialized (an approve applied just before a
   *  checkpoint must not lose its message). runPrompt drains it into
   *  the thread as labeled user-role messages right before each
   *  request; a message queued outside any LLM loop simply waits for
   *  the branch's next `llm()` call. Feedback queued in a fork branch
   *  that makes no further request dies with the branch at the join —
   *  the same lifetime as the branch's reply-attachment queue. */
  queueGuardFeedback(text: string, label: string): void {
    const queue = (this.other.__guardFeedback ??= []) as Array<{
      text: string;
      label: string;
    }>;
    queue.push({ text, label });
  }

  /** Remove and return every queued feedback entry, oldest first. */
  takeGuardFeedback(): Array<{ text: string; label: string }> {
    const queue = this.other.__guardFeedback as
      | Array<{ text: string; label: string }>
      | undefined;
    if (!queue || queue.length === 0) return [];
    delete this.other.__guardFeedback;
    return queue;
  }

  /** The consuming sibling of firstRaisableTrip: check() exactly the
   *  guard the probe admits. The runner's raise path uses this instead
   *  of detectTrippedGuard so a step-boundary conversation stays scoped
   *  to step-raisable trips — a cost guard left over budget by a
   *  rejected gate question must not be re-asked from a step. check()
   *  cannot refuse here (the probe already screened every refusal), so
   *  the null-coalesce is belt and braces. */
  detectStepRaisableTrip(): GuardExceededError | null {
    return this.firstRaisableTrip()?.check(this) ?? null;
  }

  detectTrippedGuard(): GuardExceededError | null {
    for (let i = this.guards.length - 1; i >= 0; i--) {
      if (this.suspendedGuardIds.includes(this.guards[i].guardId)) continue;
      const err = this.guards[i].check(this);
      if (err) return err;
    }
    return null;
  }

  /** guardIds suspended ON THIS BRANCH while an interrupt handler runs:
   *  a handler's work is metered by the guards of its REGISTRATION site
   *  (HandlerEntry.liveGuardIds), so everything deeper is invisible to
   *  enforcement and charging for the duration of the handler call.
   *  Branch-local twice over, on purpose: never serialized (a snapshot
   *  taken mid-suspension — a handler that propagates — must revive
   *  guards that meter), and never a flag on the guard OBJECT for cost
   *  (a shared CostGuard flagged object-wide would drop SIBLING
   *  branches' charges and open their gates while one branch's handler
   *  deliberates). TimeGuard clocks are per-branch objects and pause
   *  via Guard.suspend(). */
  private suspendedGuardIds: string[] = [];

  /** The guards a handler must not see or be metered by: every
   *  installed guard that was NOT live when the handler registered.
   *  Identity-based on guardId — ids are serialized and survive resume
   *  and fork (time clones keep the parent's id), which array indices
   *  do not. Evaluated against THIS stack, the raising branch's: a
   *  handler registered in a sibling branch is still metered by shared
   *  and inherited guards that predate it, and hidden from everything
   *  branch-local here. */
  guardsHiddenFrom(entry: HandlerEntry): Guard[] {
    return this.guards.filter((g) => !entry.liveGuardIds.includes(g.guardId));
  }

  /** Suspend every installed guard NOT in `visibleGuardIds` for the
   *  duration of one bracket. Two callers: the handler chain (visible =
   *  the handler's registration-time liveGuardIds) and a guard trip's
   *  decision window (visible = the guards outside the tripped scope —
   *  GuardScope.suspendForDecision). Returns the token endSuspension
   *  needs. Save/restore (not add/remove) so NESTED brackets compose:
   *  an inner bracket suspending a guard the outer one already
   *  suspended must not un-suspend it when the inner bracket ends. Only
   *  guards newly entering / actually leaving the suspended set get
   *  their object-level suspend()/unsuspend() calls, so the TimeGuard
   *  clock pause pairs correctly across nesting. */
  beginSuspension(visibleGuardIds: string[]): string[] {
    const previous = this.suspendedGuardIds;
    const hidden = this.guards.filter(
      (g) => !visibleGuardIds.includes(g.guardId),
    );
    this.suspendedGuardIds = [
      ...previous,
      ...hidden.map((g) => g.guardId).filter((id) => !previous.includes(id)),
    ];
    for (const g of hidden) {
      if (!previous.includes(g.guardId)) g.suspend();
    }
    // Suspended guards leave the composite (armedSignal → undefined), so
    // a deliberation over a TRIPPED guard runs on a live stack.
    this.rebuildAbortSignal();
    return previous;
  }

  endSuspension(previous: string[]): void {
    const removed = this.suspendedGuardIds.filter(
      (id) => !previous.includes(id),
    );
    this.suspendedGuardIds = previous;
    for (const g of this.guards) {
      if (removed.includes(g.guardId)) g.unsuspend();
    }
    this.rebuildAbortSignal();
  }

  /**
   * Bill one paid charge to this stack: accumulate the branch-local cost
   * accumulator, charge every active guard, and — in a subprocess —
   * forward the charge to the parent so ITS cost guards see the spend
   * live. The single billing sequence every paid site runs — llm
   * (prompt.ts), addCost (cost.ts; memory and image generation pay
   * through it), and the parent-side subprocess telemetry handler
   * (ipc.ts, which is what relays grandchild spend upward in nested
   * trees). Enforcement stays at call sites because it legitimately
   * varies: prompt/addCost always enforce; the telemetry handler skips
   * enforcement once its session has settled.
   *
   * Telemetry emission lives HERE, on the fresh-paid-charge semantic —
   * not in chargeGuards — so re-applying spend to guard accumulators
   * (e.g. a future restore/reconciliation path) can never double-bill
   * the parent. Emission is per paid call and unconditional on local
   * guards existing: a mid-tier relay may have none but must still
   * forward. No-op outside IPC mode.
   */
  billCharge(amount: number): void {
    this.localCost += amount;
    this.chargeGuards(amount);
    sendCostTelemetryToParent(amount);
  }

  /**
   * Charge every active guard with this call's cost. Shared parent
   * guards (CostGuard.cloneForBranch returns `this`) accumulate
   * descendant spend in real time — this is what makes mid-fork trip
   * detection work without waiting for the fork to settle. TimeGuard's
   * charge is a no-op.
   *
   * Guard-accumulator update ONLY — no localCost, no telemetry. Paid
   * sites must go through billCharge.
   */
  chargeGuards(amount: number): void {
    this.assertNoParkedGuards();
    for (const g of this.guards) {
      if (this.suspendedGuardIds.includes(g.guardId)) continue;
      g.charge(amount);
    }
  }

  /**
   * Prepend the parent stack's inherited guard references onto this
   * (child) stack's `guards` array, and stamp `inheritedGuardCount` so
   * future serialization slices them off.
   *
   * Handles both fresh and resumed branches:
   *  - Fresh branch: `inheritedGuardCount` is 0; the recomputed count
   *    is stamped onto the stack.
   *  - Resumed branch: `inheritedGuardCount` was restored from JSON;
   *    the recomputed count is validated against it. A mismatch (e.g.
   *    parent pushed an extra guard between snapshot and resume) throws
   *    rather than silently inheriting a different set of guards.
   *
   * Invokes `guard.cloneForBranch(parent, child)` on each parent guard
   * so per-guard semantics (CostGuard returns `this`, a shared ref;
   * TimeGuard returns a remaining-budget clone) drive what gets
   * prepended — EXCEPT when a deserialized time clone for the same
   * guardId was parked by fromJSON. That clone is branch-owned state
   * (accrued working time); adopting it instead of re-cloning is what
   * lets a branch's clock survive interrupt/resume.
   *
   * Caller (runBatch) owns the per-execution idempotency check via
   * `BranchState.guardsRehydrated` — this method itself is NOT idempotent;
   * calling it twice on the same stack will double-prepend.
   */
  rehydrateInheritedGuardsFrom(parentStack: StateStack): void {
    const parked = this.parkedInheritedTimeGuards;
    this.parkedInheritedTimeGuards = [];
    const inheritedRefs = parentStack.guards
      .map((g) => {
        if (g instanceof TimeGuard) {
          const adopted = parked.find(
            (p) => p instanceof TimeGuard && p.guardId === g.guardId,
          );
          if (adopted) return adopted;
        }
        return g.cloneForBranch(parentStack, this);
      })
      .filter((g): g is Guard => g !== undefined);
    if (
      this.inheritedGuardCount > 0 &&
      inheritedRefs.length !== this.inheritedGuardCount
    ) {
      throw new Error(
        `Inherited guard count mismatch on resume: snapshot recorded ` +
          `inheritedGuardCount=${this.inheritedGuardCount} parent-owned ` +
          `guards, but parent now yields ${inheritedRefs.length} via ` +
          `cloneForBranch. Parent's guard stack drifted between snapshot ` +
          `and resume — state corruption.`,
      );
    }
    this.guards = [...inheritedRefs, ...this.guards];
    this.inheritedGuardCount = inheritedRefs.length;
  }

  constructor(
    stack: State[] = [],
    mode: "serialize" | "deserialize" = "serialize",
  ) {
    this.stack = stack;
    this.mode = mode;
  }

  getNewState(): State {
    if (this.mode === "deserialize" && this.deserializeStackLength <= 0) {
      // console.log("Forcing mode to serialize, nothing left to deserialize");
      this.mode = "serialize";
    }
    if (this.mode === "serialize") {
      const newState = new State();
      this.stack.push(newState);
      return newState;
    } else if (this.mode === "deserialize") {
      this.deserializeStackLength -= 1;
      const item = this.stack.shift();
      if (item === undefined) {
        throw new Error(
          `Tried to deserialize state but stack is empty. This likely means there is a bug in the serialization/deserialization logic. Stack: ${JSON.stringify(this.toJSON())}`,
        );
      }
      this.stack.push(item);
      return item;
    }
    throw new Error(`Invalid mode: ${this.mode}`);
  }

  deserializeMode(): void {
    this.mode = "deserialize";
    this.deserializeStackLength = this.stack.length;
    this.stack.forEach((frame) => frame.deserializeMode());
  }

  pop(): State | undefined {
    return this.stack.pop();
  }

  lastFrame(): State {
    return this.stack[this.stack.length - 1];
  }

  /** The frame one below the top. Top is the "current" frame for whatever code
   *  is running right now; the caller's frame is what owns scoped registrations
   *  made by the current call. Falls back to the root frame at the top level. */
  callerFrame(): State {
    if (this.stack.length === 0) {
      throw new Error("callerFrame() called on empty stack");
    }
    return this.stack.length >= 2
      ? this.stack[this.stack.length - 2]
      : this.stack[0];
  }

  /** True when the only frame on the stack is the currently-running call's own
   *  frame (i.e. there is no caller). This happens during module-level
   *  initialization (e.g. inside `__initializeGlobals`) where calls like
   *  `callback(...)` have no real caller frame to register against. */
  isGlobalContext(): boolean {
    return this.stack.length <= 1;
  }

  /** Record a saveDraft value on the CALLER's frame — the Agency scope
   *  that called saveDraft (saveDraft is itself an Agency def, so the top
   *  frame is saveDraft's own). The value is deep-cloned so later
   *  mutation cannot change the salvage, and so a live-trip salvage
   *  matches a post-resume one. Throws in global context: a draft saved
   *  at module top level has no scope to salvage it and would silently
   *  do nothing. */
  setSavedDraft(value: unknown): void {
    if (this.isGlobalContext()) {
      throw new Error(
        "saveDraft() can only be called inside a function, node, or block — " +
          "there is no enclosing scope at module top level to save a draft for.",
      );
    }
    this.callerFrame().savedDraft = { value: deepClone(value) };
  }

  /** All scoped callbacks registered anywhere in the active stack for this hook,
   *  ordered innermost first (deepest frame's callbacks come first). */
  collectScopedCallbacks(name: string): any[] {
    const out: any[] = [];
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const cbs = this.stack[i].scopedCallbacks;
      if (!cbs) continue;
      for (const cb of cbs) {
        if (cb.name === name) out.push(cb.fn);
      }
    }
    return out;
  }

  static lastFrameJSON(json: StateStackJSON): StateJSON {
    return json.stack[json.stack.length - 1];
  }

  currentNodeId(): string | undefined {
    return this.nodesTraversed[this.nodesTraversed.length - 1];
  }

  /**
   * Advance the step or substep counter for a given step path so that on
   * interrupt resume we skip past the current debug step block.
   *
   * - stepPath "3"     → top-level step → increment stack.step
   * - stepPath "4.0"   → substep inside step 4 → set __substep_4 = 0 + 1
   * - stepPath "4.0.2" → sub-substep → set __substep_4.0 = 2 + 1
   *
   * The naming convention matches the builder's generated code:
   * all segments except the last form the substep variable name (__substep_X.Y),
   * and the value is set to lastSegment + 1 to advance past it.
   */
  advanceDebugStep(stepPath: string): void {
    const frame = this.lastFrame();
    if (!frame) return;

    const segments = stepPath.split(".").map(Number);
    if (segments.length === 1) {
      // Top-level step
      frame.step++;
    } else {
      // Substep: variable name is __substep_ + all segments except last, joined by .
      const parentSegments = segments.slice(0, -1);
      const varName = `__substep_${parentSegments.join(".")}`;
      const lastSegment = segments[segments.length - 1];
      frame.locals[varName] = lastSegment + 1;
    }
  }

  toJSON(): StateStackJSON {
    const json: StateStackJSON = {
      stack: this.stack.map((frame) => frame.toJSON()),
      other: deepClone(this.other),
      mode: this.mode,
      deserializeStackLength: this.deserializeStackLength,
      nodesTraversed: [...this.nodesTraversed],
      localCost: this.localCost,
      localTokens: this.localTokens,
      seedCost: this.seedCost,
      seedTokens: this.seedTokens,
      // Serialize only branch-owned guards. Inherited guards are
      // parent-owned (shared references like CostGuard) and MUST NOT
      // be re-serialized on every descendant — doing so would
      // duplicate the JS object on deserialize, defeating the whole
      // shared-counter model (sibling A and sibling B would each
      // charge a different OUTER clone).
      //
      // Invariant this relies on: every descendant branch is re-entered
      // on resume through `runBatch` (the only code path that creates
      // branches in the first place), which calls
      // `StateStack.rehydrateInheritedGuardsFrom(parentStack)` to
      // re-prepend live references to the parent's guards before any
      // user code on that branch reads `stack.guards`. The parent
      // itself is restored either:
      //   - directly from the top-level checkpoint (root stack), or
      //   - by being rehydrated via the same chain from ITS parent
      //     (deeper nesting), so a depth-N branch sees the same
      //     OUTER reference all the way up to root after N successive
      //     `rehydrateInheritedGuardsFrom` calls.
      //
      // Concretely: a checkpoint stamped on a non-root stack (e.g.
      // nested `runBatch`, or `pr.step` inside a fork branch) will
      // drop its inherited guards from this snapshot. That is safe
      // ONLY because the OUTER runBatch chain always re-stamps with
      // its own parent stack on the way up, and the final resume
      // root is always a stack whose `inheritedGuardCount === 0`.
      guards: this.guards.slice(this.inheritedGuardCount).map((g) => g.toJSON()),
      inheritedGuardCount: this.inheritedGuardCount,
    };
    // EXCEPTION to the slice rule above: inherited TIME guards are
    // branch-owned clones (remaining budget + accrued working time),
    // not shared references. Re-cloning them from the parent on
    // resume would reset the branch's clock, so they serialize with
    // the branch and rehydrate adopts them by guardId.
    const inheritedTime = this.guards
      .slice(0, this.inheritedGuardCount)
      .filter((g) => g instanceof TimeGuard);
    if (inheritedTime.length > 0) {
      json.inheritedTimeGuards = inheritedTime.map((g) => g.toJSON());
    }
    return json;
  }

  static fromJSON(json: StateStackJSON): StateStack {
    const stateStack = new StateStack([], "serialize");
    stateStack.stack = (json.stack || []).map((frame) => State.fromJSON(frame));
    stateStack.nodesTraversed = json.nodesTraversed || [];
    stateStack.other = json.other || {};
    stateStack.mode = json.mode || "serialize";
    stateStack.deserializeStackLength = json.deserializeStackLength || 0;
    stateStack.localCost = json.localCost ?? 0;
    stateStack.localTokens = json.localTokens ?? 0;
    stateStack.seedCost = json.seedCost ?? 0;
    stateStack.seedTokens = json.seedTokens ?? 0;
    // Nullish coalesce handles checkpoints written before the
    // `guards` field existed (back-compat with pre-guard snapshots).
    // We do NOT call install() on deserialized guards — install effects
    // (e.g. composing abort signals) are runtime state and will be
    // re-established by resume() at the first runner step.
    //
    // For child branch stacks: only branch-owned guards were serialized.
    // `inheritedGuardCount` is preserved but guards.length will be less
    // than inheritedGuardCount until `runBatch` re-prepends live
    // references to the parent's guards (see rehydrateInheritedGuards
    // in runBatch.ts). This intermediate state is safe because nothing
    // reads child stack guards between deserialize and the runBatch
    // re-entry that reactivates the branch.
    stateStack.guards = (json.guards ?? []).map(guardFromJSON);
    stateStack.inheritedGuardCount = json.inheritedGuardCount ?? 0;
    // Park deserialized inherited time clones for rehydrate to adopt.
    // Live-only: consumed (and cleared) by rehydrateInheritedGuardsFrom.
    stateStack.parkedInheritedTimeGuards = (json.inheritedTimeGuards ?? []).map(
      guardFromJSON,
    );
    return stateStack;
  }
}

/** Seed a child branch's `localCost` / `localTokens` from the parent stack
 *  unless they're already populated (e.g. restored from a checkpoint on
 *  resume). Idempotent — a branch is "fresh" iff it has zero cost AND zero
 *  tokens. Also records the immutable `seedCost` / `seedTokens` baseline so
 *  `propagateBranchCost` can compute this branch's delta independently of
 *  the parent's later mutations (sibling branches may fold their spend into
 *  the parent first). Shared by `Runner` (fork/parallel/race) and
 *  `PromptRunner` (LLM tool dispatch) so `getCost()`/`getTokens()` are
 *  cumulative across ALL child branches, including subagent tools. */
export function seedBranchCost(
  branchStack: StateStack,
  parentStack: StateStack,
): void {
  const isFresh =
    branchStack.localCost === 0 && branchStack.localTokens === 0;
  if (!isFresh) return;
  branchStack.localCost = parentStack.localCost;
  branchStack.localTokens = parentStack.localTokens;
  branchStack.seedCost = parentStack.localCost;
  branchStack.seedTokens = parentStack.localTokens;
}

/** Propagate cost/token deltas from a set of branches back to the parent
 *  stack. Delta = `branch.localCost - branch.seedCost` (the baseline
 *  captured at seed time). Using the per-branch seed rather than the
 *  parent's current totals keeps the math correct when sibling branches
 *  already folded their spend in. Call BEFORE popBranches/deleteBranch. */
export function propagateBranchCost(
  branches: BranchState[],
  parentStack: StateStack,
): void {
  let costDelta = 0;
  let tokensDelta = 0;
  for (const branch of branches) {
    costDelta += branch.stack.localCost - branch.stack.seedCost;
    tokensDelta += branch.stack.localTokens - branch.stack.seedTokens;
  }
  parentStack.localCost += costDelta;
  parentStack.localTokens += tokensDelta;
}
