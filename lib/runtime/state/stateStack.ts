import { deepClone } from "../utils.js";
import { ThreadStoreJSON } from "./threadStore.js";

export type BranchState = {
  stack: StateStack;
  interrupt_id?: string;
  interruptData?: any;
};

export type BranchStateJSON = {
  stack: StateStackJSON;
  interrupt_id?: string;
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

export type StateStackJSON = {
  stack: State[];
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
    const serializedStack = this.stack.map(frame => {
      const serializedFrame: any = {
        args: deepClone(frame.args),
        locals: deepClone(frame.locals),
        threads: frame.threads ? deepClone(frame.threads) : null,
        step: frame.step,
      };
      if (frame.branches) {
        serializedFrame.branches = {};
        for (const [key, branch] of Object.entries(frame.branches)) {
          serializedFrame.branches[key] = {
            stack: branch.stack.toJSON(),
            ...(branch.interrupt_id ? { interrupt_id: branch.interrupt_id } : {}),
            ...(branch.interruptData ? { interruptData: deepClone(branch.interruptData) } : {}),
          };
        }
      }
      return serializedFrame;
    });

    return {
      stack: serializedStack,
      other: deepClone(this.other),
      mode: this.mode,
      deserializeStackLength: this.deserializeStackLength,
      nodesTraversed: [...this.nodesTraversed],
    };
  }

  static fromJSON(json: StateStackJSON): StateStack {
    const stateStack = new StateStack([], "serialize");
    stateStack.stack = (json.stack || []).map(frame => {
      const restoredFrame: State = {
        args: frame.args,
        locals: frame.locals,
        threads: frame.threads,
        step: frame.step,
      };
      if ((frame as any).branches) {
        restoredFrame.branches = {};
        for (const [key, branch] of Object.entries((frame as any).branches as Record<string, BranchStateJSON>)) {
          restoredFrame.branches[Number(key)] = {
            stack: StateStack.fromJSON(branch.stack),
            ...(branch.interrupt_id ? { interrupt_id: branch.interrupt_id } : {}),
            ...(branch.interruptData ? { interruptData: branch.interruptData } : {}),
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
