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
};

export type BranchStateJSON = {
  stack: StateStackJSON;
  interruptId?: string;
  interruptData?: any;
};

// the state for each frame (a node, or a function call)
export type State = {
  args: Record<string, any>;
  locals: Record<string, any>;
  threads: ThreadStoreJSON | null;
  step: number;
  branches?: Record<number, BranchState>;
};

export type StateJSON = {
  args: Record<string, any>;
  locals: Record<string, any>;
  threads: ThreadStoreJSON | null;
  step: number;
  branches?: Record<number, BranchStateJSON>;
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
      console.log("Forcing mode to serialize, nothing left to deserialize");
      this.mode = "serialize";
    }
    if (this.mode === "serialize") {
      const newState = {
        args: {},
        locals: {},
        threads: null,
        step: 0,
      };
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

  currentNodeId(): string | undefined {
    return this.nodesTraversed[this.nodesTraversed.length - 1];
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
    const json: StateJSON = {
      args: deepClone(state.args),
      locals: deepClone(state.locals),
      threads: state.threads ? deepClone(state.threads) : null,
      step: state.step,
    };
    if (state.branches) {
      json.branches = {} as Record<number, BranchStateJSON>;
      for (const [key, branch] of Object.entries(state.branches)) {
        json.branches[key as unknown as number] = this.branchToJSON(branch);
      }
    }
    return json;
  }

  static fromJSON(json: StateStackJSON): StateStack {
    const stateStack = new StateStack([], "serialize");
    stateStack.stack = (json.stack || []).map((frame) => {
      const restoredFrame: State = {
        args: frame.args,
        locals: frame.locals,
        threads: frame.threads,
        step: frame.step,
      };
      if ((frame as any).branches) {
        restoredFrame.branches = {};
        for (const [key, branch] of Object.entries(
          (frame as any).branches as Record<string, BranchStateJSON>,
        )) {
          restoredFrame.branches[Number(key)] = {
            stack: StateStack.fromJSON(branch.stack),
            ...(branch.interruptId ? { interruptId: branch.interruptId } : {}),
            ...(branch.interruptData
              ? { interruptData: branch.interruptData }
              : {}),
          };
        }
      }
      return restoredFrame;
    });
    stateStack.nodesTraversed = json.nodesTraversed || [];
    stateStack.other = json.other || {};
    stateStack.mode = json.mode || "serialize";
    stateStack.deserializeStackLength = json.deserializeStackLength || 0;
    return stateStack;
  }
}
