import { expect } from "vitest";
import * as path from "path";
import { DebuggerDriver } from "./driver.js";
import { UIState } from "./uiState.js";
import type { DebuggerCommand, DebuggerIO } from "./types.js";
import { Checkpoint, resetGlobalCheckpointCounter } from "../runtime/state/checkpointStore.js";
import type { FunctionParameter } from "../types.js";
import { getTestDir } from "../importPaths.js";
import { isInterrupt } from "@/runtime/interrupts.js";
import { color } from "termcolors";

export const fixtureDir = path.join(getTestDir(), "debugger");

// A programmatic DebuggerIO that feeds a scripted sequence of commands
// and records all render calls for assertions.
export class TestDebuggerIO implements DebuggerIO {
  state: UIState = new UIState();
  private commands: DebuggerCommand[];
  private commandIndex = 0;
  renderCalls: Checkpoint[] = [];
  rewindSelector: ((checkpoints: Checkpoint[]) => number | null) | null = null;

  constructor(commands: DebuggerCommand[]) {
    this.commands = commands;
  }

  async render(_checkpoint?: Checkpoint): Promise<void> {
    if (_checkpoint) {
      const checkpoint = Checkpoint.fromJSON(_checkpoint);
      if (checkpoint) {
        this.renderCalls.push(checkpoint);
      }
    }
  }

  async waitForCommand(): Promise<DebuggerCommand> {
    const cmd = this.commands[this.commandIndex++];
    if (!cmd) {
      return { type: "quit" };
    }
    return cmd;
  }

  async showRewindSelector(checkpoints: Checkpoint[]): Promise<number | null> {
    if (this.rewindSelector) {
      return this.rewindSelector(checkpoints);
    }
    return null;
  }

  async promptForNodeArgs(_parameters: FunctionParameter[]): Promise<unknown[]> {
    return [];
  }

  async promptForInput(_prompt: string): Promise<string> {
    const cmd = this.commands[this.commandIndex++];
    if (!cmd) return "";
    switch (cmd.type) {
      case "approve": return "approve";
      case "reject": return "reject";
      case "resolve": return `resolve ${JSON.stringify(cmd.value)}`;
      case "modify": return `modify ${Object.entries(cmd.overrides!).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}`;
      default: return "";
    }
  }

  appendStdout(_text: string): void { }
  renderActivityOnly(): void { }
  startSpinner(): void { }
  stopSpinner(): void { }
  destroy(): void { }
}

let importCounter = 0;

// Fresh import with cache-busting to get clean module state per test.
// Also resets the global checkpoint ID counter so IDs from different
// checkpoint stores (debugger vs context) remain comparable.
export async function freshImport(compiledFile: string): Promise<any> {
  resetGlobalCheckpointCounter();
  return await import(compiledFile + `?t=${importCounter++}`);
}

export function makeDriver(mod: any, ui: DebuggerIO, opts: { checkpoints?: Checkpoint[] } = {}) {
  const driver = new DebuggerDriver({
    mod: {
      approveInterrupt: mod.approveInterrupt,
      respondToInterrupt: mod.respondToInterrupt,
      rewindFrom: mod.rewindFrom,
      __setDebugger: mod.__setDebugger,
      __getCheckpoints: mod.__getCheckpoints,
    },
    sourceMap: mod.__sourceMap ?? {},
    rewindSize: Math.max(30, opts.checkpoints?.length ?? 0),
    ui,
    checkpoints: opts.checkpoints,
  });
  mod.__setDebugger(driver.debuggerState);
  return driver;
}

export async function getInitialResult(mod: any, driver: DebuggerDriver, ...args: any[]) {
  const callbacks = driver.getCallbacks();
  const initialResult = await mod.main(...args, { callbacks });

  expect(initialResult?.data).toBeDefined();
  expect(isInterrupt(initialResult.data)).toBe(true);
  return initialResult;
}
