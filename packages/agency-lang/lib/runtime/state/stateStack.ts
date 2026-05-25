import type { Guard, GuardJSON } from "../guard.js";
import { guardFromJSON } from "../guard.js";
import { Checkpoint } from "../index.js";
import { deepClone } from "../utils.js";
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
};

export type BranchStateJSON = {
  stack: StateStackJSON;
  interruptId?: string;
  interruptData?: any;
  result?: { result: any };
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
  /** Number of leading entries in `guards` that are inherited from the
   *  parent stack. Always 0 for the root stack. */
  inheritedGuardCount?: number;
};

export class StateStack {
  stack: State[] = [];
  mode: "serialize" | "deserialize" = "serialize";

  other: Record<string, any> = {};
  deserializeStackLength: number = 0;
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

  pushGuard(guard: Guard): void {
    guard.install(this);
    this.guards.push(guard);
  }

  popGuard(): Guard | undefined {
    const guard = this.guards.pop();
    if (guard) guard.uninstall(this);
    return guard;
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
      // parent-owned (shared references like CostGuard); they're
      // serialized exactly once on the parent's snapshot and
      // re-prepended at resume by `runBatch`.
      guards: this.guards.slice(this.inheritedGuardCount).map((g) => g.toJSON()),
      inheritedGuardCount: this.inheritedGuardCount,
    };
  }

  private branchToJSON(branch: BranchState): BranchStateJSON {
    const json: BranchStateJSON = {
      stack: branch.stack.toJSON(),
    };
    if (branch.interruptId) {
      json.interruptId = branch.interruptId;
    }
    if (branch.interruptData) {
      json.interruptData = deepClone(branch.interruptData);
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
    return stateStack;
  }
}
