import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { DebuggerDriver } from "./driver.js";
import { UIState } from "./uiState.js";
import type { DebuggerCommand, DebuggerIO } from "./types.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";
import type { FunctionParameter } from "../types.js";
import { compile } from "../cli/commands.js";
import { getTestDir } from "../importPaths.js";
import { isInterrupt } from "@/runtime/interrupts.js";

// A programmatic DebuggerIO that feeds a scripted sequence of commands
// and records all render calls for assertions.
class TestDebuggerIO implements DebuggerIO {
  state: UIState = new UIState();
  private commands: DebuggerCommand[];
  private commandIndex = 0;
  renderCalls: Checkpoint[] = [];

  constructor(commands: DebuggerCommand[]) {
    this.commands = commands;
  }

  async render(_checkpoint?: Checkpoint): Promise<void> {
    if (_checkpoint) {
      const checkpoint = Checkpoint.fromJSON(_checkpoint);
      if (!checkpoint) {
        throw new Error("Failed to parse checkpoint in render");
      }
      this.renderCalls.push(checkpoint);
    }
  }

  async waitForCommand(): Promise<DebuggerCommand> {
    const cmd = this.commands[this.commandIndex++];
    if (!cmd) {
      // Safety: if we run out of commands, quit
      return { type: "quit" };
    }
    return cmd;
  }

  async showRewindSelector(_checkpoints: Checkpoint[]): Promise<number | null> {
    return null;
  }

  async promptForNodeArgs(_parameters: FunctionParameter[]): Promise<unknown[]> {
    return [];
  }

  async promptForInput(_prompt: string): Promise<string> {
    return "";
  }

  appendStdout(_text: string): void { }

  renderActivityOnly(): void { }

  destroy(): void { }
}

const fixtureDir = path.join(getTestDir(), "debugger");

const stepTestAgency = path.join(fixtureDir, "step-test.agency");
const stepTestCompiled = path.join(fixtureDir, "step-test.ts");

const fnCallAgency = path.join(fixtureDir, "function-call-test.agency");
const fnCallCompiled = path.join(fixtureDir, "function-call-test.ts");

function makeDriver(mod: any, ui: DebuggerIO) {
  const driver = new DebuggerDriver({
    mod: {
      approveInterrupt: mod.approveInterrupt,
      respondToInterrupt: mod.respondToInterrupt,
      rewindFrom: mod.rewindFrom,
      __setDebugger: mod.__setDebugger,
      __getCheckpoints: mod.__getCheckpoints,
    },
    sourceMap: mod.__sourceMap ?? {},
    rewindSize: 30,
    ui,
  });
  mod.__setDebugger(driver.debuggerState);
  return driver;
}

async function getInitialResult(mod: any, driver: DebuggerDriver) {
  const callbacks = driver.getCallbacks();
  const initialResult = await mod.main({ callbacks });

  // The initial call should have hit a debugStep and returned an interrupt
  expect(initialResult?.data).toBeDefined();
  expect(isInterrupt(initialResult.data)).toBe(true);
  return initialResult;
}
let mod: any;
describe("DebuggerDriver stepping", () => {
  beforeAll(async () => {
    compile({ debugger: true }, stepTestAgency, stepTestCompiled, { ts: true });
    mod = await import(stepTestCompiled);
  });

  afterAll(() => {
    try {
      fs.unlinkSync(stepTestCompiled);
    } catch {
      // ignore
    }
  });

  it("takes a single step", async () => {
    // Feed enough step commands to walk through every debug pause,
    // then continue to let the program finish.
    const commands: DebuggerCommand[] = [{ type: "step" }];
    const testUI = new TestDebuggerIO(commands);

    const driver = makeDriver(mod, testUI);

    const initialResult = await getInitialResult(mod, driver);

    const result = await driver.run(initialResult, { interceptConsole: false });

    // The program should have returned 3 (1 + 2)
    // const returnValue = result?.data !== undefined ? result.data : result;

    // the program hasn't finished yet,
    // so we're still waiting for commands
    expect(result).toBe(undefined);

    // We started at the first step, then stepped once
    expect(testUI.renderCalls.length).toEqual(2);
    const firstStep = testUI.renderCalls[0];
    const secondStep = testUI.renderCalls[1];
    expect(firstStep.stepPath).toBe("1");

    // one step in the middle is for the debugStep call,
    // so the actual steps are every other step
    expect(secondStep.stepPath).toBe("3");
  });

  it("steps through each statement and returns the correct result", async () => {
    // Feed enough step commands to walk through every debug pause,
    // then continue to let the program finish.
    const commands: DebuggerCommand[] = Array(10).fill({ type: "step" });
    const testUI = new TestDebuggerIO(commands);

    const driver = makeDriver(mod, testUI);

    const initialResult = await getInitialResult(mod, driver);

    const result = await driver.run(initialResult, { interceptConsole: false });

    // The program should have returned 3 (1 + 2)
    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(3);

    // We started at the first step, then stepped 10 times
    //expect(testUI.renderCalls.length).toEqual(11);
    const firstStep = testUI.renderCalls[0];
    const secondStep = testUI.renderCalls[1];
    expect(firstStep.stepPath).toBe("1");

    // one step in the middle is for the debugStep call,
    // so the actual steps are every other step
    expect(secondStep.stepPath).toBe("3");
  });

  it("continue runs to completion without further pauses", async () => {
    const commands: DebuggerCommand[] = [
      { type: "continue" },
    ];
    const testUI = new TestDebuggerIO(commands);

    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    // Program should complete with return value 3
    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(3);

    // Only the initial pause, then program runs to completion with no more pauses.
    expect(testUI.renderCalls.length).toBe(1);
  });
});

let fnMod: any;
describe("DebuggerDriver stepping with function calls", () => {
  beforeAll(async () => {
    compile({ debugger: true }, fnCallAgency, fnCallCompiled, { ts: true });
    fnMod = await import(fnCallCompiled);
  });

  afterAll(() => {
    try {
      fs.unlinkSync(fnCallCompiled);
    } catch {
      // ignore
    }
  });

  it("stepIn enters a function call", async () => {
    // Step until we reach the add() call line, then stepIn.
    // We need to step through: x = 1, then y = add(x, 2).
    // The debug steps are interleaved, so we step a few times
    // then use stepIn to enter the function.
    const commands: DebuggerCommand[] = [
      { type: "step" },   // x = 1
      { type: "stepIn" }, // y = add(x, 2) — step into add()
      ...Array(10).fill({ type: "step" }), // step through add + rest
    ];
    const testUI = new TestDebuggerIO(commands);

    const driver = makeDriver(fnMod, testUI);
    const initialResult = await getInitialResult(fnMod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(17);

    // After stepping into add(), we should step through all 3 debug pauses in add
    const addRenders = testUI.renderCalls.filter((cp) => cp.scopeName === "add");
    expect(addRenders.length).toBe(3);
    expect(addRenders.map((cp) => cp.stepPath)).toEqual(["1", "3", "5"]);
  });

  it("next steps over a function call", async () => {
    // Step until we reach the add() call line, then next (step over).
    const commands: DebuggerCommand[] = [
      { type: "step" }, // x = 1
      { type: "next" }, // y = add(x, 2) — step OVER add()
      ...Array(10).fill({ type: "step" }), // step through rest
    ];
    const testUI = new TestDebuggerIO(commands);

    const driver = makeDriver(fnMod, testUI);
    const initialResult = await getInitialResult(fnMod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(17);

    // No render call should be in the "add" scope — we stepped over it
    const scopeNames = testUI.renderCalls.map((cp) => cp.scopeName);
    expect(scopeNames).not.toContain("add");
  });

  it("stepOut exits a function back to caller", async () => {
    // Step into add(), step once inside it, then stepOut to return to main
    const commands: DebuggerCommand[] = [
      { type: "step" },    // x = 1
      { type: "stepIn" },  // y = add(x, 2) — step into add()
      { type: "step" },    // inside add: result = a + b
      { type: "stepOut" }, // inside add: step out back to main
      ...Array(10).fill({ type: "step" }), // step through rest
    ];
    const testUI = new TestDebuggerIO(commands);

    const driver = makeDriver(fnMod, testUI);
    const initialResult = await getInitialResult(fnMod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(17);

    // stepOut should skip remaining add statements. With stepping only
    // (as in the stepIn test), we'd pause 3 times in add (steps 1, 3, 5).
    // With stepOut after step 3, we should only pause twice (steps 1, 3).
    const addRenders = testUI.renderCalls.filter((cp) => cp.scopeName === "add");
    expect(addRenders.length).toBe(2);
    expect(addRenders.map((cp) => cp.stepPath)).toEqual(["1", "3"]);

    // After the last add pause, remaining renders should be in main
    const scopeNames = testUI.renderCalls.map((cp) => cp.scopeName);
    const addIndex = scopeNames.lastIndexOf("add");
    const afterStepOut = scopeNames.slice(addIndex + 1);
    expect(afterStepOut.length).toBeGreaterThan(0);
    expect(afterStepOut.every((s) => s === "main")).toBe(true);
  });
});
