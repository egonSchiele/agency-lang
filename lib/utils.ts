import { Message } from "smoltalk";

export function escape(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
}

export function deepCopy<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export function zip<T, U>(arr1: T[], arr2: U[]): Array<[T, U]> {
  const length = Math.min(arr1.length, arr2.length);
  const result: Array<[T, U]> = [];
  for (let i = 0; i < length; i++) {
    result.push([arr1[i], arr2[i]]);
  }
  return result;
}

export function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

class PackagedState {
  public messages?: Message[];
  public nodesTraversed?: string[];
  public toolCall?: Record<string, any>;
  public step?: number;
  public selfState?: Record<string, any>;
  public globalState?: Record<string, any>;
  public args?: any;
  constructor(state: Record<string, any>, args?: any) {
    this.messages = state.messages;
    this.nodesTraversed = state.graph?.getNodesTraversed();
    this.toolCall = state.toolCall;
    this.step = state.part;
    this.selfState = JSON.parse(JSON.stringify(state.self));
    this.globalState = JSON.parse(JSON.stringify(state.global));
    this.args = args;
  }

  toJSON() {
    return {
      messages: this.messages,
      nodesTraversed: this.nodesTraversed,
      toolCall: this.toolCall,
      step: this.step,
      selfState: this.selfState,
      globalState: this.globalState,
      args: this.args,
    };
  }
}
