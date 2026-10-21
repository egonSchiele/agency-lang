import { expect } from "vitest";
import * as path from "path";
import { DebuggerDriver } from "./driver.js";
import type { BusyEntry, DebuggerCommand, DebuggerIO, DebuggerMode } from "./types.js";
import { Checkpoint, resetGlobalCheckpointCounter } from "../runtime/state/checkpointStore.js";
import type { FunctionParameter } from "../types.js";
import { getTestDir } from "../importPaths.js";
import { isInterrupt, hasInterrupts } from "@/runtime/interrupts.js";
import { color } from "@/utils/termcolors.js";
import type { LLMMock } from "../runtime/deterministicClient.js";
import type { DebugStopData } from "../runtime/debugger.js";
import type { GuardTripData } from "./guardAnswer.js";
import type { InterruptResponse } from "../runtime/interrupts.js";

export const fixtureDir = path.join(getTestDir(), "debugger");

// A programmatic DebuggerIO that feeds a scripted sequence of commands
// and records all render calls for assertions.
export class TestDebuggerIO implements DebuggerIO {
  /** Every line the driver logged, in order. */
  logLines: string[] = [];
  mode: DebuggerMode = "stepping";
  overrides: Record<string, unknown> = {};
  /** Every list `setBusy` received, in order. */
  busyCalls: BusyEntry[][] = [];
  private pauseListeners: (() => void)[] = [];
  private commands: DebuggerCommand[];
  private commandIndex = 0;
  renderCalls: Checkpoint[] = [];
  rewindSelector: ((checkpoints: Checkpoint[]) => number | null) | null = null;

  constructor(commands: DebuggerCommand[]) {
    this.commands = commands;
  }

  log(line: string): void {
    this.logLines.push(line);
  }

  setMode(mode: DebuggerMode): void {
    this.mode = mode;
  }

  setOverrides(overrides: Record<string, unknown>): void {
    this.overrides = { ...overrides };
  }

  setBusy(entries: BusyEntry[]): void {
    this.busyCalls.push(entries);
  }

  onPause(listener: () => void): void {
    this.pauseListeners.push(listener);
  }

  /** The person pressed the pause key. */
  pause(): void {
    for (const listener of this.pauseListeners) {
      listener();
    }
  }

  async render(
    _checkpoint?: Checkpoint,
    _stop?: DebugStopData,
    _interruptId?: string,
  ): Promise<void> {
    if (_checkpoint) {
      const checkpoint = Checkpoint.fromJSON(_checkpoint);
      if (checkpoint) {
        this.renderCalls.push(checkpoint);
        // console.log(JSON.stringify(checkpoint, null, 2));
        // console.log(color.green("[DBG]"), checkpoint.getLocation());
      }
    }
  }

  async waitForCommand(): Promise<DebuggerCommand> {
    const cmd = this.commands[this.commandIndex++];
    // console.log(color.green("[DBG]"), "Command", cmd);
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
      case "approve":
        return "approve";
      case "reject":
        return "reject";
      case "resolve":
        return `resolve ${JSON.stringify(cmd.value)}`;
      case "modify":
        return `modify ${Object.entries(cmd.overrides!)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(" ")}`;
      default:
        return "";
    }
  }

  async answerGuardTrip(_data: GuardTripData): Promise<InterruptResponse> {
    return { type: "reject" };
  }

  async showCheckpointsPanel(_checkpoints: Checkpoint[]): Promise<void> {}
  appendStdout(_text: string): void {}
  renderActivityOnly(): void {}
  startSpinner(): void {}
  stopSpinner(): void {}
  destroy(): void {}
}

let importCounter = 0;

// Fresh import with cache-busting to get clean module state per test.
// Also resets the global checkpoint ID counter so IDs from different
// checkpoint stores (debugger vs context) remain comparable.
export async function freshImport(compiledFile: string): Promise<any> {
  resetGlobalCheckpointCounter();
  // eslint-disable-next-line no-restricted-syntax -- cache-busting dynamic import is required for fresh module state per test
  return await import(compiledFile + `?t=${importCounter++}`);
}

export function makeDriver(mod: any, ui: DebuggerIO, opts: { checkpoints?: Checkpoint[] } = {}) {
  const driver = new DebuggerDriver({
    mod: {
      respondToInterrupts: mod.respondToInterrupts,
      rewindFrom: mod.rewindFrom,
      __setDebugger: mod.__setDebugger,
      __getCheckpoints: mod.__getCheckpoints,
    },
    rewindSize: Math.max(30, opts.checkpoints?.length ?? 0),
    ui,
    checkpoints: opts.checkpoints,
  });
  mod.__setDebugger(driver.debuggerState);
  return driver;
}

export async function getInitialResult(mod: any, driver: DebuggerDriver, ...args: any[]) {
  const callbacks = driver.getCallbacks();
  const initialResult = await mod.main(...args, { callbacks, ...driver.invocation });

  expect(initialResult?.data).toBeDefined();
  expect(hasInterrupts(initialResult.data)).toBe(true);
  return initialResult;
}

/** Run `fn` with every `llm()` call answered from `mocks`, in order, by
 *  the deterministic client. `fn` must import the module itself: the
 *  client is built from `AGENCY_LLM_MOCKS` when the module is imported,
 *  and one queue then serves the whole session, resumes and rewinds
 *  included. */
/** One resume the driver sent: how many interrupts it answered, and the
 *  responses in the batch's order. */
export type RecordedResume = { interrupts: number; responses: unknown[] };

/** A copy of a compiled module whose `respondToInterrupts` records every
 *  resume into `resumes` before forwarding it. */
export function recordingResumes(mod: any, resumes: RecordedResume[]): any {
  return {
    ...mod,
    respondToInterrupts: (interrupts: unknown[], responses: unknown[], opts: unknown) => {
      resumes.push({ interrupts: interrupts.length, responses });
      return mod.respondToInterrupts(interrupts, responses, opts);
    },
  };
}

export async function withLLMMocks<T>(mocks: LLMMock[], fn: () => Promise<T>): Promise<T> {
  const previous = process.env.AGENCY_LLM_MOCKS;
  process.env.AGENCY_LLM_MOCKS = JSON.stringify(mocks);
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.AGENCY_LLM_MOCKS;
    } else {
      process.env.AGENCY_LLM_MOCKS = previous;
    }
  }
}
