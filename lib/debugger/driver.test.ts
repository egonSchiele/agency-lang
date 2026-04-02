import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { DebuggerDriver } from "./driver.js";
import { UIState } from "./uiState.js";
import type { DebuggerCommand, DebuggerIO } from "./types.js";
import { Checkpoint, resetGlobalCheckpointCounter } from "../runtime/state/checkpointStore.js";
import type { FunctionParameter } from "../types.js";
import { compile, resetCompilationCache } from "../cli/commands.js";
import { getTestDir } from "../importPaths.js";
import { isInterrupt } from "@/runtime/interrupts.js";

// A programmatic DebuggerIO that feeds a scripted sequence of commands
// and records all render calls for assertions.
class TestDebuggerIO implements DebuggerIO {
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
      // Safety: if we run out of commands, quit
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

const interruptAgency = path.join(fixtureDir, "interrupt-test.agency");
const interruptCompiled = path.join(fixtureDir, "interrupt-test.ts");

// Fresh import with cache-busting to get clean module state per test.
// Also resets the global checkpoint ID counter so IDs from different
// checkpoint stores (debugger vs context) remain comparable.
let importCounter = 0;
async function freshImport(compiledFile: string): Promise<any> {
  resetGlobalCheckpointCounter();
  return await import(compiledFile + `?t=${importCounter++}`);
}

// Compile all fixtures once, clean up after all tests
beforeAll(() => {
  compile({ debugger: true }, stepTestAgency, stepTestCompiled, { ts: true });
  compile({ debugger: true }, fnCallAgency, fnCallCompiled, { ts: true });
  compile({ debugger: true }, interruptAgency, interruptCompiled, { ts: true });
});

afterAll(() => {
  for (const f of [stepTestCompiled, fnCallCompiled, interruptCompiled]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

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
describe("DebuggerDriver stepping", () => {
  it("takes a single step", async () => {
    const mod = await freshImport(stepTestCompiled);
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
    const mod = await freshImport(stepTestCompiled);
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
    const mod = await freshImport(stepTestCompiled);
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

describe("DebuggerDriver print and checkpoint", () => {
  it("print looks up a local variable", async () => {
    const mod = await freshImport(stepTestCompiled);
    // Step past x = 1, then print x
    const commands: DebuggerCommand[] = [
      { type: "step" },                    // past x = 1
      { type: "print", varName: "x" },     // should find x = 1
      { type: "continue" },
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    await driver.run(initialResult, { interceptConsole: false });

    const log = testUI.state.getActivityLog();
    expect(log).toContainEqual("x = 1");
  });

  it("print reports not found for nonexistent variable", async () => {
    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [
      { type: "print", varName: "doesNotExist" },
      { type: "continue" },
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    await driver.run(initialResult, { interceptConsole: false });

    const log = testUI.state.getActivityLog();
    expect(log).toContainEqual("doesNotExist = (not found)");
  });

  it("checkpoint pins a checkpoint with a label", async () => {
    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [
      { type: "step" },
      { type: "checkpoint", label: "my-label" },
      { type: "continue" },
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    await driver.run(initialResult, { interceptConsole: false });

    const log = testUI.state.getActivityLog();
    expect(log.some((l) => l.includes("Pinned checkpoint") && l.includes('"my-label"'))).toBe(true);

    // The pinned checkpoint should exist in the debugger state
    const checkpoints = driver.debuggerState.getCheckpoints();
    const pinned = checkpoints.filter((cp) => cp.pinned);
    expect(pinned.length).toBeGreaterThan(0);
    expect(pinned.some((cp) => cp.label === "my-label")).toBe(true);
  });

  it("checkpoint pins without a label", async () => {
    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [
      { type: "step" },
      { type: "checkpoint" },
      { type: "continue" },
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    await driver.run(initialResult, { interceptConsole: false });

    const checkpoints = driver.debuggerState.getCheckpoints();
    const pinned = checkpoints.filter((cp) => cp.pinned);
    expect(pinned.length).toBeGreaterThan(0);
  });
});

describe("DebuggerDriver stepping with function calls", () => {
  it("stepIn enters a function call", async () => {
    const fnMod = await freshImport(fnCallCompiled);
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
    const fnMod = await freshImport(fnCallCompiled);
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
    const fnMod = await freshImport(fnCallCompiled);
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

describe("DebuggerDriver set (variable overrides)", () => {
  it("set overrides a local variable and affects execution", async () => {
    const mod = await freshImport(stepTestCompiled);
    // step-test: x = 1, y = 2, z = x + y, return z
    // Step past x = 1, set x = 10, then continue.
    // z should be 10 + 2 = 12 instead of 1 + 2 = 3.
    const commands: DebuggerCommand[] = [
      { type: "step" },                       // past x = 1
      { type: "set", varName: "x", value: 10 },
      { type: "continue" },
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(12);
  });
});

describe("DebuggerDriver user interrupt handling", () => {
  it("resolve provides a value for an interrupted variable", async () => {
    const intMod = await freshImport(interruptCompiled);
    // interrupt-test: x = 1, y = interrupt("check value"), z = x + y, return z
    // Step past x = 1, step to the interrupt, resolve y with 5.
    // z should be 1 + 5 = 6.
    const commands: DebuggerCommand[] = [
      { type: "step" },              // past x = 1
      { type: "step" },              // hits interrupt("check value")
      { type: "resolve", value: 5 }, // resolve y = 5
      ...Array(10).fill({ type: "step" }),
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(intMod, testUI);
    const initialResult = await getInitialResult(intMod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(6);
  });

  it("reject sets the interrupted variable to false", async () => {
    const intMod = await freshImport(interruptCompiled);
    // When rejected, the interrupted variable (y) is set to false.
    // z = x + y = 1 + false = 1 (JS coercion).
    const commands: DebuggerCommand[] = [
      { type: "step" },   // past x = 1
      { type: "step" },   // hits interrupt("check value")
      { type: "reject" }, // reject the interrupt → y = false
      ...Array(10).fill({ type: "step" }),
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(intMod, testUI);
    const initialResult = await getInitialResult(intMod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(1);
  });
});

describe("DebuggerDriver stepBack and rewind", () => {
  it("stepBack returns to the previous debug pause", async () => {
    const mod = await freshImport(stepTestCompiled);
    // step-test: x = 1, y = 2, z = x + y, return z
    // Step forward once (to y = 2), then stepBack to x = 1.
    const commands: DebuggerCommand[] = [
      { type: "step" },                                // past x = 1 → at y = 2
      { type: "stepBack", preserveOverrides: false },  // back to x = 1
      ...Array(10).fill({ type: "step" }),             // step through rest
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(3);

    const steps = testUI.renderCalls.map((cp) => cp.stepPath);
    expect(steps[0]).toBe("1"); // initial
    expect(steps[1]).toBe("3"); // after step
    expect(steps[2]).toBe("1"); // after stepBack — back to step 1
  });

  it("stepBack at earliest checkpoint does not move", async () => {
    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [
      { type: "stepBack", preserveOverrides: false },
      { type: "continue" },
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(3);

    const log = testUI.state.getActivityLog();
    expect(log).toContainEqual("Already at earliest checkpoint");
  });

  it("rewind to a specific checkpoint re-executes from that point", async () => {
    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [
      { type: "step" },   // past x = 1
      { type: "step" },   // past y = 2
      { type: "rewind" }, // rewind selector picks first checkpoint
      ...Array(10).fill({ type: "step" }),
    ];
    const testUI = new TestDebuggerIO(commands);
    // Pick the first (earliest) checkpoint from the list
    testUI.rewindSelector = (checkpoints) => {
      return checkpoints.length > 0 ? checkpoints[0].id : null;
    };
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(3);

    const steps = testUI.renderCalls.map((cp) => cp.stepPath);
    // After stepping to 3, 5, then rewinding to earliest, we should
    // re-visit step 1 (the earliest checkpoint).
    expect(steps[0]).toBe("1"); // initial
    expect(steps[1]).toBe("3"); // after first step
    expect(steps[2]).toBe("5"); // after second step
    expect(steps[3]).toBe("1"); // after rewind to earliest
  });

  it("rewind cancelled by selector returns null and stays put", async () => {
    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [
      { type: "step" },
      { type: "rewind" }, // selector returns null (cancelled)
      { type: "continue" },
    ];
    const testUI = new TestDebuggerIO(commands);
    // Return null = user cancelled
    testUI.rewindSelector = () => null;
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    // Program should still complete normally
    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(3);
  });
});
