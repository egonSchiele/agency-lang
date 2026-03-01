import { MessageJSON, ToolCallJSON, ToolMessageJSON } from "smoltalk";
import { deepClone } from "../utils.js";
import { ThreadStoreJSON } from "./threadStore.js";

// the state for each frame (a node, or a function call)
export type State = {
  args: Record<string, any>;
  locals: Record<string, any>;
  threads: ThreadStoreJSON | null;
  step: number;
};

export type StateStackJSON = {
  stack: State[];
  mode: "serialize" | "deserialize";
  globals: Record<string, any>;
  other: Record<string, any>;
  deserializeStackLength: number;
  nodesTraversed: string[];
};

export class StateStack {
  stack: State[] = [];
  mode: "serialize" | "deserialize" = "serialize";

  // a statestack almost never keeps track of globals...
  // those live on the global state stack.
  // but it might temporarily store them for an interrupt,
  // so it can later restore them.
  globals: Record<string, any> = {};
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

  toJSON(): StateStackJSON {
    return deepClone({
      stack: this.stack,
      globals: this.globals,
      other: this.other,
      mode: this.mode,
      deserializeStackLength: this.deserializeStackLength,
      nodesTraversed: this.nodesTraversed,
    });
  }

  static fromJSON(json: StateStackJSON): StateStack {
    const stateStack = new StateStack([], "serialize");
    stateStack.stack = json.stack || [];
    stateStack.nodesTraversed = json.nodesTraversed || [];
    stateStack.globals = json.globals || {};
    stateStack.other = json.other || {};
    stateStack.mode = json.mode || "serialize";
    stateStack.deserializeStackLength = json.deserializeStackLength || 0;
    return stateStack;
  }

  // tokens should be tracked on runtime context
  static createWithTokenStats(): StateStack {
    const stateStack = new StateStack();
    stateStack.globals.__tokenStats = {
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
      },
      cost: {
        inputCost: 0,
        outputCost: 0,
        totalCost: 0,
        currency: "USD",
      },
    };
    return stateStack;
  }
}
