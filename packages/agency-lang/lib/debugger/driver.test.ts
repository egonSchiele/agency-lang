import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { DebuggerCommand } from "./types.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";
import { compile } from "../cli/commands.js";
import { createDebugInterrupt } from "@/runtime/interrupts.js";
import {
  TestDebuggerIO,
  freshImport,
  makeDriver,
  getInitialResult,
  fixtureDir,
} from "./testHelpers.js";

const stepTestAgency = path.join(fixtureDir, "step-test.agency");
const stepTestCompiled = path.join(fixtureDir, "step-test.ts");

const fnCallAgency = path.join(fixtureDir, "function-call-test.agency");
const fnCallCompiled = path.join(fixtureDir, "function-call-test.ts");

const interruptAgency = path.join(fixtureDir, "interrupt-test.agency");
const interruptCompiled = path.join(fixtureDir, "interrupt-test.ts");

const loopAgency = path.join(fixtureDir, "loop-test.agency");
const loopCompiled = path.join(fixtureDir, "loop-test.ts");

const ifElseAgency = path.join(fixtureDir, "if-else-test.agency");
const ifElseCompiled = path.join(fixtureDir, "if-else-test.ts");

const nestedAgency = path.join(fixtureDir, "nested-calls-test.agency");
const nestedCompiled = path.join(fixtureDir, "nested-calls-test.ts");

// Compile all fixtures once, clean up after all tests
const allCompiled = [
  stepTestCompiled,
  fnCallCompiled,
  interruptCompiled,
  loopCompiled,
  ifElseCompiled,
  nestedCompiled,
];

const RUN_ID = "test-run-id";

beforeAll(() => {
  compile({ debugger: true }, stepTestAgency, stepTestCompiled, { ts: true });
  compile({ debugger: true }, fnCallAgency, fnCallCompiled, { ts: true });
  compile({ debugger: true }, interruptAgency, interruptCompiled, { ts: true });
  compile({ debugger: true }, loopAgency, loopCompiled, { ts: true });
  compile({ debugger: true }, ifElseAgency, ifElseCompiled, { ts: true });
  compile({ debugger: true }, nestedAgency, nestedCompiled, { ts: true });
});

afterAll(() => {
  for (const f of allCompiled) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});
// TODO: Skipped pending interrupt template migration to ctx.getInterruptResponse()
describe.skip("DebuggerDriver stepping", () => {
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
    expect(firstStep.stepPath).toBe("0");

    // Steps are consecutive (no interleaved debug steps with the Runner)
    expect(secondStep.stepPath).toBe("1");
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

    const firstStep = testUI.renderCalls[0];
    const secondStep = testUI.renderCalls[1];
    expect(firstStep.stepPath).toBe("0");

    // Steps are consecutive (no interleaved debug steps with the Runner)
    expect(secondStep.stepPath).toBe("1");
  });

  it("continue runs to completion without further pauses", async () => {
    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [{ type: "continue" }];
    const testUI = new TestDebuggerIO(commands);

    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    // Program should complete with return value 3
    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(3);

    // Only the initial pause, then program runs to completion with no more pauses.
    // One more pause at the end, because once the program finishes, we restore
    // the last interrupt, and render it again
    expect(testUI.renderCalls.length).toBe(2);
  });

  it("after program finishes, blocks forward stepping", async () => {
    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [
      { type: "continue" }, // run to completion
      { type: "step" }, // should be blocked
    ];
    const testUI = new TestDebuggerIO(commands);

    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    await driver.run(initialResult, { interceptConsole: false });

    // 3 renders: initial pause, restored interrupt after finish, blocked step re-render
    expect(testUI.renderCalls.length).toBe(3);

    // The last two renders should be identical — the blocked step didn't advance
    const beforeStep = testUI.renderCalls[1].getCurrentFrame();
    const afterStep = testUI.renderCalls[2].getCurrentFrame();
    expect(beforeStep?.locals).toEqual(afterStep?.locals);
    expect(beforeStep?.step).toBe(afterStep?.step);
  });

  it("after program finishes, can step back to an earlier state", async () => {
    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [
      { type: "continue" }, // run to completion
      { type: "stepBack", preserveOverrides: false }, // step back
    ];
    const testUI = new TestDebuggerIO(commands);

    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    await driver.run(initialResult, { interceptConsole: false });

    // After continue: initial render + restored-last-interrupt render = 2
    // After stepBack: rewind re-executes, producing at least 1 more render
    expect(testUI.renderCalls.length).toBeGreaterThanOrEqual(3);

    // The last render should have z=3 (re-execution from nearby checkpoint
    // lands at the same final state), but the stepBack should have succeeded
    // (no "Already at earliest checkpoint" message)
    const log = testUI.state.getActivityLog();
    expect(log).not.toContainEqual("Already at earliest checkpoint");
  });

  it("after program finishes and stepping back, can step forward again", async () => {
    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [
      { type: "continue" }, // run to completion
      { type: "stepBack", preserveOverrides: false }, // step back (clears programFinished)
      { type: "step" }, // should work now
    ];
    const testUI = new TestDebuggerIO(commands);

    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    await driver.run(initialResult, { interceptConsole: false });

    // Step forward should NOT be blocked after stepping back
    const log = testUI.state.getActivityLog();
    expect(log).not.toContainEqual("Already at end of execution.");
  });
});

describe.skip("DebuggerDriver print and checkpoint", () => {
  it("print looks up a local variable", async () => {
    const mod = await freshImport(stepTestCompiled);
    // Step past x = 1, then print x
    const commands: DebuggerCommand[] = [
      { type: "step" }, // past x = 1
      { type: "print", varName: "x" }, // should find x = 1
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
    expect(
      log.some(
        (l) => l.includes("Pinned checkpoint") && l.includes('"my-label"'),
      ),
    ).toBe(true);

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

describe.skip("DebuggerDriver stepping with function calls", () => {
  it("stepIn enters a function call", async () => {
    const fnMod = await freshImport(fnCallCompiled);
    // Step until we reach the add() call line, then stepIn.
    // We need to step through: x = 1, then y = add(x, 2).
    // The debug steps are interleaved, so we step a few times
    // then use stepIn to enter the function.
    const commands: DebuggerCommand[] = [
      { type: "step" }, // x = 1
      { type: "step" }, // x = 1
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
    const addRenders = testUI.renderCalls.filter(
      (cp) => cp.scopeName === "add",
    );
    expect(addRenders.length).toBe(3); // 3 lines + one empty
    expect(addRenders.map((cp) => cp.stepPath)).toEqual(["0", "1", "2"]);
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
      { type: "step" }, // x = 1
      { type: "stepIn" }, // y = add(x, 2) — step into add()
      { type: "step" }, // inside add: result = a + b
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
    const addRenders = testUI.renderCalls.filter(
      (cp) => cp.scopeName === "add",
    );
    expect(addRenders.length).toBe(2);
    expect(addRenders.map((cp) => cp.stepPath)).toEqual(["0", "1"]);

    // After the last add pause, remaining renders should be in main
    const scopeNames = testUI.renderCalls.map((cp) => cp.scopeName);
    const addIndex = scopeNames.lastIndexOf("add");
    const afterStepOut = scopeNames.slice(addIndex + 1);
    expect(afterStepOut.length).toBeGreaterThan(0);
    expect(afterStepOut.every((s) => s === "main")).toBe(true);
  });
});

describe.skip("DebuggerDriver set (variable overrides)", () => {
  it("set overrides a local variable and affects execution", async () => {
    const mod = await freshImport(stepTestCompiled);
    // step-test: x = 1, y = 2, z = x + y, return z
    // Step past x = 1, set x = 10, then continue.
    // z should be 10 + 2 = 12 instead of 1 + 2 = 3.
    const commands: DebuggerCommand[] = [
      { type: "step" }, // past x = 1
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

describe.skip("DebuggerDriver user interrupt handling", () => {
  it("resolve provides a value for an interrupted variable", async () => {
    const intMod = await freshImport(interruptCompiled);
    // interrupt-test: x = 1, y = interrupt("check value"), z = x + y, return z
    // Step past x = 1, step to the interrupt, resolve y with 5.
    // z should be 1 + 5 = 6.
    const commands: DebuggerCommand[] = [
      { type: "step" }, // past x = 1
      { type: "step" }, // hits interrupt("check value")
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

  it("reject causes the function to return a failure", async () => {
    const intMod = await freshImport(interruptCompiled);
    // When rejected, the function returns a failure result.
    const commands: DebuggerCommand[] = [
      { type: "step" }, // past x = 1
      { type: "step" }, // hits interrupt("check value")
      { type: "reject" }, // reject the interrupt → return failure
      ...Array(10).fill({ type: "step" }),
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(intMod, testUI);
    const initialResult = await getInitialResult(intMod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toMatchObject({
      success: false,
      error: "interrupt rejected",
      retryable: false,
    });
  });
});

describe.skip("DebuggerDriver stepBack and rewind", () => {
  it.skip("stepBack returns to the previous debug pause", async () => {
    const mod = await freshImport(stepTestCompiled);
    // step-test: x = 1, y = 2, z = x + y, return z
    // Step forward once (to y = 2), then stepBack to x = 1.
    const commands: DebuggerCommand[] = [
      { type: "step" }, // past x = 1 → at y = 2
      { type: "stepBack", preserveOverrides: false }, // back to x = 1
      ...Array(10).fill({ type: "step" }), // step through rest
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(3);

    const steps = testUI.renderCalls.map((cp) => cp.stepPath);
    expect(steps[0]).toBe("0"); // initial
    expect(steps[1]).toBe("1"); // after step
    expect(steps[2]).toBe("0"); // after stepBack — back to step 0
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

  it.skip("rewind to a specific checkpoint re-executes from that point", async () => {
    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [
      { type: "step" }, // past x = 1
      { type: "step" }, // past y = 2
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
    // After stepping to 1, 2, then rewinding to earliest, we should
    // re-visit step 0 (the earliest checkpoint).
    expect(steps[0]).toBe("0"); // initial
    expect(steps[1]).toBe("1"); // after first step
    expect(steps[2]).toBe("2"); // after second step
    expect(steps[3]).toBe("0"); // after rewind to earliest
  });

  it("stepBack with preserveOverrides keeps pending overrides", async () => {
    const mod = await freshImport(stepTestCompiled);
    // step-test: x = 1, y = 2, z = x + y, return z
    // Step past x=1 and y=2, override x=10, then stepBack with preserveOverrides.
    // StepBack goes to step 3 (after x=1, before y=2). The override x=10 is
    // preserved as a pending override. On the next step forward, it gets applied.
    // Since x=1 already executed, x stays overridden to 10. z = 10 + 2 = 12.
    const commands: DebuggerCommand[] = [
      { type: "step" }, // past x = 1 → at step 3
      { type: "step" }, // past y = 2 → at step 5
      { type: "set", varName: "x", value: 10 }, // override x = 10
      { type: "stepBack", preserveOverrides: true }, // back to step 3, keep override
      ...Array(10).fill({ type: "step" }), // step forward — x override applied
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    // x was overridden to 10, so z = 10 + 2 = 12
    expect(returnValue).toBe(12);
  });

  it.skip("rewind to a pinned checkpoint", async () => {
    const mod = await freshImport(stepTestCompiled);
    // Step forward, pin a checkpoint, step more, then rewind to the pinned one.
    const commands: DebuggerCommand[] = [
      { type: "step" }, // past x = 1
      { type: "checkpoint", label: "saved" }, // pin at step 2
      { type: "step" }, // past y = 2
      { type: "rewind" }, // rewind selector picks pinned checkpoint
    ];
    const testUI = new TestDebuggerIO(commands);
    testUI.rewindSelector = (checkpoints) => {
      const pinned = checkpoints.find(
        (cp) => cp.pinned && cp.label === "saved",
      );
      return pinned ? pinned.id : null;
    };
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    /* const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(3); */

    const steps = testUI.renderCalls.map((cp) => cp.stepPath);
    // initial:0, step:1 (pinned here), step:2, rewind to pinned:1
    expect(steps[0]).toBe("0");
    expect(steps[1]).toBe("1");
    expect(steps[2]).toBe("2");
    expect(steps[3]).toBe("1"); // after rewind to pinned
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

describe.skip("DebuggerDriver save and load", () => {
  const saveFile = path.join(fixtureDir, "__test-checkpoint.json");

  afterAll(() => {
    try {
      fs.unlinkSync(saveFile);
    } catch {
      /* ignore */
    }
  });

  it.skip("save and load preserves overridden variable state", async () => {
    // First run: step forward, override x, save checkpoint, then quit.
    // step-test: x = 1, y = 2, z = x + y, return z
    const mod1 = await freshImport(stepTestCompiled);
    const saveCommands: DebuggerCommand[] = [
      { type: "step" }, // past x = 1
      { type: "set", varName: "x", value: 10 }, // override x = 10
      { type: "step" }, // resume with override applied
      { type: "save", path: saveFile }, // save checkpoint (x = 10 in state)
    ];
    const saveUI = new TestDebuggerIO(saveCommands);
    const driver1 = makeDriver(mod1, saveUI);
    const initialResult1 = await getInitialResult(mod1, driver1);
    await driver1.run(initialResult1, { interceptConsole: false });

    expect(fs.existsSync(saveFile)).toBe(true);

    // Second run: load the saved checkpoint and continue.
    // The loaded state should have x = 10, so z = 10 + 2 = 12.
    const mod2 = await freshImport(stepTestCompiled);
    const loadCommands: DebuggerCommand[] = [
      { type: "load", path: saveFile },
      ...Array(10).fill({ type: "step" }),
    ];
    const loadUI = new TestDebuggerIO(loadCommands);
    const driver2 = makeDriver(mod2, loadUI);
    const initialResult2 = await getInitialResult(mod2, driver2);
    const result = await driver2.run(initialResult2, {
      interceptConsole: false,
    });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(12);
  });
});

describe.skip("DebuggerDriver with loops", () => {
  it("steps through a for loop, pausing on each iteration", async () => {
    // loop-test: sum = 0, for i in range(3) { sum = sum + i }, return sum
    // Expected result: 0 + 1 + 2 = 3
    const mod = await freshImport(loopCompiled);
    const commands: DebuggerCommand[] = Array(30).fill({ type: "step" });
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(3);

    // We should have multiple renders — the loop body executes 3 times,
    // so there should be repeated step paths from inside the loop.
    expect(testUI.renderCalls.length).toBeGreaterThan(3);
  });

  it("continue runs through the entire loop without pausing", async () => {
    const mod = await freshImport(loopCompiled);
    const commands: DebuggerCommand[] = [{ type: "continue" }];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(3);

    // 2 renders: the initial pause, then continue runs to completion,
    // then the last interrupt is restored so the user can still interact
    expect(testUI.renderCalls.length).toBe(2);
  });
});

describe.skip("DebuggerDriver with if/else", () => {
  it("steps through the then branch when condition is true", async () => {
    // if-else-test: if (x > 0) { result = "positive" } else { result = "non-positive" }
    const mod = await freshImport(ifElseCompiled);
    const commands: DebuggerCommand[] = Array(20).fill({ type: "step" });
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver, 5);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe("positive");
  });

  it("steps through the else branch when condition is false", async () => {
    const mod = await freshImport(ifElseCompiled);
    const commands: DebuggerCommand[] = Array(20).fill({ type: "step" });
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver, -1);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe("non-positive");
  });
});

describe.skip("DebuggerDriver with nested function calls", () => {
  // nested-calls-test:
  //   def double(n) { result = n * 2; return result }
  //   def addAndDouble(a, b) { sum = a + b; result = double(sum); return result }
  //   node main() { x = addAndDouble(1, 2); return x }
  // Expected: double(1 + 2) = double(3) = 6

  it("stepIn reaches the innermost function", async () => {
    const mod = await freshImport(nestedCompiled);
    const commands: DebuggerCommand[] = [
      { type: "stepIn" }, // main → enter addAndDouble (addAndDouble:1)
      { type: "step" }, // addAndDouble: sum = a + b (addAndDouble:3)
      { type: "step" }, // past sum = a + b (addAndDouble:5)
      { type: "stepIn" }, // addAndDouble: result = double(sum) → enter double
      ...Array(20).fill({ type: "step" }),
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(6);

    const scopeNames = testUI.renderCalls.map((cp) => cp.scopeName);
    // Should visit all three scopes
    expect(scopeNames).toContain("main");
    expect(scopeNames).toContain("addAndDouble");
    expect(scopeNames).toContain("double");
  });

  it("next at top level skips all nested calls", async () => {
    const mod = await freshImport(nestedCompiled);
    const commands: DebuggerCommand[] = [
      { type: "next" }, // main: x = addAndDouble(1, 2) → step OVER
      ...Array(10).fill({ type: "step" }),
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(6);

    const scopeNames = testUI.renderCalls.map((cp) => cp.scopeName);
    // Should only visit main — both addAndDouble and double are skipped
    expect(scopeNames).not.toContain("addAndDouble");
    expect(scopeNames).not.toContain("double");
  });

  it("stepOut from innermost function returns to middle function", async () => {
    const mod = await freshImport(nestedCompiled);
    const commands: DebuggerCommand[] = [
      { type: "stepIn" }, // main → enter addAndDouble (addAndDouble:1)
      { type: "step" }, // addAndDouble:3 (before sum = a + b)
      { type: "stepIn" }, // addAndDouble:5 (before result = double(sum)) → enter double
      { type: "step" }, // inside double: result = n * 2
      { type: "stepOut" }, // exit double → back in addAndDouble
      ...Array(20).fill({ type: "step" }),
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI);
    const initialResult = await getInitialResult(mod, driver);
    const result = await driver.run(initialResult, { interceptConsole: false });

    const returnValue = result?.data !== undefined ? result.data : result;
    expect(returnValue).toBe(6);

    const scopeNames = testUI.renderCalls.map((cp) => cp.scopeName);
    expect(scopeNames).toContain("double");

    // After stepOut from double, we should be back in addAndDouble
    const lastDoubleIdx = scopeNames.lastIndexOf("double");
    const afterStepOut = scopeNames.slice(lastDoubleIdx + 1);
    expect(afterStepOut.length).toBeGreaterThan(0);
    // Should see addAndDouble (and eventually main) but NOT double again
    expect(afterStepOut).not.toContain("double");
    expect(afterStepOut).toContain("addAndDouble");
  });
});

// Helper: run step-test to completion and collect all checkpoints
async function collectCheckpoints(): Promise<Checkpoint[]> {
  const mod = await freshImport(stepTestCompiled);
  const commands: DebuggerCommand[] = Array(20).fill({ type: "step" });
  const testUI = new TestDebuggerIO(commands);
  const driver = makeDriver(mod, testUI);
  const initialResult = await getInitialResult(mod, driver);
  await driver.run(initialResult, { interceptConsole: false });
  return testUI.renderCalls;
}

describe.skip("DebuggerDriver with loaded trace checkpoints", () => {
  it("starts at the last checkpoint and renders it", async () => {
    const checkpoints = await collectCheckpoints();
    expect(checkpoints.length).toBeGreaterThan(0);

    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI, { checkpoints });

    const lastCp = checkpoints[checkpoints.length - 1];
    const interrupt = createDebugInterrupt(
      undefined,
      lastCp.id,
      lastCp,
      RUN_ID,
    );
    await driver.run({ data: interrupt }, { interceptConsole: false });

    // Should have rendered the last checkpoint
    expect(testUI.renderCalls.length).toBe(1);
    expect(testUI.renderCalls[0].id).toBe(lastCp.id);
  });

  it("blocks forward stepping at end of execution", async () => {
    const checkpoints = await collectCheckpoints();
    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [
      { type: "step" }, // should be blocked
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI, { checkpoints });

    const lastCp = checkpoints[checkpoints.length - 1];
    const interrupt = createDebugInterrupt(
      undefined,
      lastCp.id,
      lastCp,
      RUN_ID,
    );
    await driver.run({ data: interrupt }, { interceptConsole: false });

    // Should see "Already at end of execution" in the activity log
    const log = testUI.state.getActivityLog();
    expect(log).toContainEqual("Already at end of execution.");
  });

  it.skip("can rewind to an earlier checkpoint with different state", async () => {
    const checkpoints = await collectCheckpoints();
    // Find an early checkpoint where z is not yet defined
    const earlyCp = checkpoints.find((cp) => {
      const frame = cp.stack.stack[cp.stack.stack.length - 1];
      return !("z" in frame.locals);
    });
    expect(earlyCp).toBeDefined();

    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [{ type: "rewind" }];
    const testUI = new TestDebuggerIO(commands);
    testUI.rewindSelector = () => earlyCp!.id;
    const driver = makeDriver(mod, testUI, { checkpoints });

    const lastCp = checkpoints[checkpoints.length - 1];
    const interrupt = createDebugInterrupt(
      undefined,
      lastCp.id,
      lastCp,
      RUN_ID,
    );
    await driver.run({ data: interrupt }, { interceptConsole: false });

    // First render: last checkpoint (has z=3)
    const firstFrame =
      testUI.renderCalls[0].stack.stack[
        testUI.renderCalls[0].stack.stack.length - 1
      ];
    expect(firstFrame.locals.z).toBe(3);

    // After rewind to an early checkpoint, re-execution pauses before z is set
    expect(testUI.renderCalls.length).toBeGreaterThan(1);
    const secondFrame =
      testUI.renderCalls[1].stack.stack[
        testUI.renderCalls[1].stack.stack.length - 1
      ];
    expect("z" in secondFrame.locals).toBe(false);
  });

  it("can print variables from loaded checkpoints", async () => {
    const checkpoints = await collectCheckpoints();
    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [{ type: "print", varName: "z" }];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI, { checkpoints });

    // Use the last checkpoint which should have z = 3
    const lastCp = checkpoints[checkpoints.length - 1];
    const interrupt = createDebugInterrupt(
      undefined,
      lastCp.id,
      lastCp,
      RUN_ID,
    );
    await driver.run({ data: interrupt }, { interceptConsole: false });

    const log = testUI.state.getActivityLog();
    expect(log).toContainEqual("z = 3");
  });

  it("can rewind and then step forward (clears programFinished)", async () => {
    const checkpoints = await collectCheckpoints();
    const mod = await freshImport(stepTestCompiled);
    // Rewind to an earlier checkpoint, then step forward — this should
    // re-execute from that checkpoint since programFinished is cleared
    const commands: DebuggerCommand[] = [
      { type: "stepBack", preserveOverrides: false }, // go back
      { type: "step" }, // step forward (re-executes)
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI, { checkpoints });

    const lastCp = checkpoints[checkpoints.length - 1];
    const interrupt = createDebugInterrupt(
      undefined,
      lastCp.id,
      lastCp,
      RUN_ID,
    );
    await driver.run({ data: interrupt }, { interceptConsole: false });

    // After rewind + step, we should have more than 2 renders
    // (initial render, rewind render, then step forward render)
    expect(testUI.renderCalls.length).toBeGreaterThanOrEqual(3);
  });
});

describe.skip("DebuggerDriver with loaded single checkpoint", () => {
  it("loads a single checkpoint and renders it", async () => {
    const checkpoints = await collectCheckpoints();
    // Pick a checkpoint from the middle that has some state
    const midpoint = checkpoints[Math.floor(checkpoints.length / 2)];

    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI, { checkpoints: [midpoint] });

    const interrupt = createDebugInterrupt(
      undefined,
      midpoint.id,
      midpoint,
      RUN_ID,
    );
    await driver.run({ data: interrupt }, { interceptConsole: false });

    expect(testUI.renderCalls.length).toBe(1);
    expect(testUI.renderCalls[0].id).toBe(midpoint.id);
  });

  it("can step forward from a single loaded checkpoint", async () => {
    const checkpoints = await collectCheckpoints();
    // Pick the first checkpoint — stepping forward should re-execute
    const firstCp = checkpoints[0];

    const mod = await freshImport(stepTestCompiled);
    const commands: DebuggerCommand[] = [
      { type: "stepBack", preserveOverrides: false }, // rewind clears programFinished
      { type: "step" }, // now we can step forward
    ];
    const testUI = new TestDebuggerIO(commands);
    const driver = makeDriver(mod, testUI, { checkpoints: [firstCp] });

    const interrupt = createDebugInterrupt(
      undefined,
      firstCp.id,
      firstCp,
      RUN_ID,
    );
    await driver.run({ data: interrupt }, { interceptConsole: false });

    // Should have at least the initial render + rewind attempt + step
    expect(testUI.renderCalls.length).toBeGreaterThanOrEqual(1);
  });
});
