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

  // cached result for completed fork threads.
  // wrapped in an object to distinguish "no result" from "result is undefined".
  result?: { result: any };
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
  branches?: Record<string, BranchState>;

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

  toJSON(): StateJSON {
    const json: StateJSON = {
      args: deepClone(this.args),
      locals: deepClone(this.locals),
      threads: this.threads ? deepClone(this.threads) : null,
      step: this.step,
    };
    if (this.branches) {
      json.branches = {};
      for (const [key, branch] of Object.entries(this.branches)) {
        json.branches[key] = {
          stack: branch.stack.toJSON(),
          ...(branch.interruptId ? { interruptId: branch.interruptId } : {}),
          ...(branch.interruptData
            ? { interruptData: branch.interruptData }
            : {}),
          ...(branch.result !== undefined
            ? { result: deepClone(branch.result) }
            : {}),
        };
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
    if (json.branches) {
      state.branches = {};
      for (const [key, branch] of Object.entries(json.branches)) {
        state.branches[key] = {
          stack: StateStack.fromJSON(branch.stack),
          ...(branch.interruptId ? { interruptId: branch.interruptId } : {}),
          ...(branch.interruptData
            ? { interruptData: branch.interruptData }
            : {}),
          ...(branch.result !== undefined ? { result: branch.result } : {}),
        };
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
};

export type StateStackJSON = {
  stack: StateJSON[];
  mode: "serialize" | "deserialize";
  other: Record<string, any>;
  deserializeStackLength: number;
  nodesTraversed: string[];
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
  }

  pop(): State | undefined {
    return this.stack.pop();
  }

  lastFrame(): State {
    return this.stack[this.stack.length - 1];
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
      stack: this.stack.map((frame) => this.stackToJSON(frame)),
      other: deepClone(this.other),
      mode: this.mode,
      deserializeStackLength: this.deserializeStackLength,
      nodesTraversed: [...this.nodesTraversed],
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

  private stackToJSON(state: State): StateJSON {
    return state.toJSON();
  }

  static fromJSON(json: StateStackJSON): StateStack {
    const stateStack = new StateStack([], "serialize");
    stateStack.stack = (json.stack || []).map((frame) => State.fromJSON(frame));
    stateStack.nodesTraversed = json.nodesTraversed || [];
    stateStack.other = json.other || {};
    stateStack.mode = json.mode || "serialize";
    stateStack.deserializeStackLength = json.deserializeStackLength || 0;
    return stateStack;
  }
}
