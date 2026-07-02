import type { Guard, GuardJSON } from "../guard.js";
import type { ReplyAttachmentPart } from "../replyAttachments.js";
import { guardFromJSON } from "../guard.js";
import { Checkpoint } from "../index.js";
import { MemoryFrame } from "../memory/frame.js";
import { deepClone } from "../utils.js";
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

  toJSON(): StateJSON {
    const json: StateJSON = {
      args: deepClone(this.args),
      locals: deepClone(this.locals),
      threads: this.threads ? deepClone(this.threads) : null,
      step: this.step,
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
    if (json.scopedCallbacks && json.scopedCallbacks.length > 0) {
      state.scopedCallbacks = json.scopedCallbacks.map((cb) => ({
        name: cb.name,
        fn: cb.fn,
      }));
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
  branches?: Record<string, BranchStateJSON>;
  scopedCallbacks?: Array<{ name: string; fn: any }>;
};

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

  // Per-branch abort signal. Set by Runner.runRace / Runner.runForkAll on each
  // branch's stack. When the parent fork/race aborts a losing branch, this
  // signal fires; runtime checks (ctx.isCancelled, smoltalk's HTTP signal)
  // observe it and stop work in the affected branch only.
  // NOT serialized — purely a live execution concept.
  abortSignal?: AbortSignal;

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
    guard.install(this);
    this.guards.push(guard);
  }

  popGuard(): Guard | undefined {
    const guard = this.guards.pop();
    if (guard) guard.uninstall(this);
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
    for (let i = this.guards.length - 1; i >= 0; i--) {
      const err = this.guards[i].check(this);
      if (err) throw err;
    }
  }

  /**
   * Charge every active guard with this call's cost. Shared parent
   * guards (CostGuard.cloneForBranch returns `this`) accumulate
   * descendant spend in real time — this is what makes mid-fork trip
   * detection work without waiting for the fork to settle. TimeGuard's
   * charge is a no-op.
   */
  chargeGuards(amount: number): void {
    for (const g of this.guards) g.charge(amount);
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
   * Always invokes `guard.cloneForBranch(parent, child)` on each parent
   * guard so per-guard semantics (CostGuard returns `this`; TimeGuard
   * returns `undefined`) drive what gets prepended. Slicing the parent
   * by `inheritedGuardCount` would lose this filter information.
   *
   * Caller (runBatch) owns the per-execution idempotency check via
   * `BranchState.guardsRehydrated` — this method itself is NOT idempotent;
   * calling it twice on the same stack will double-prepend.
   */
  rehydrateInheritedGuardsFrom(parentStack: StateStack): void {
    const inheritedRefs = parentStack.guards
      .map((g) => g.cloneForBranch(parentStack, this))
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
    return {
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
