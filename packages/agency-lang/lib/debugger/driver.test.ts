import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../cli/commands.js";
import { freshImport, fixtureDir } from "./testHelpers.js";
import { DebuggerTestSession } from "./testSession.js";

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

const allCompiled = [
  stepTestCompiled,
  fnCallCompiled,
  interruptCompiled,
  loopCompiled,
  ifElseCompiled,
  nestedCompiled,
];

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
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

// --- Helper: collect checkpoints by stepping through step-test to completion ---

async function collectCheckpoints() {
  const mod = await freshImport(stepTestCompiled);
  const session = await DebuggerTestSession.create({ mod });
  await session.press("s", { times: 20 });
  return session.driver.debuggerState.getCheckpoints();
}

// ============================================================================
// Stepping
// ============================================================================

describe("Debugger stepping", () => {
  it("steps through each statement and returns correct result", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    // step-test.agency: x = 1, y = 2, z = x + y, return z
    await session.press("s", { times: 10 });
    const result = await session.quit();
    expect(result).toBe(3);
  });

  it("continue runs to completion", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("c");
    const result = await session.quit();
    expect(result).toBe(3);
  });

  it("after program finishes, blocks forward stepping", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("c"); // run to completion
    await session.press("s"); // should be blocked

    const log = session.ui.state.getActivityLog();
    expect(log).toContainEqual("Already at end of execution.");
  });

  it("after program finishes, can step back to an earlier state", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("c"); // run to completion
    await session.press("up"); // stepBack (up arrow on source pane)

    const log = session.ui.state.getActivityLog();
    expect(log).not.toContainEqual("Already at earliest checkpoint");
  });

  it("after stepping back, can step forward again", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("c"); // run to completion
    await session.press("up"); // stepBack
    await session.press("s"); // should work now

    const log = session.ui.state.getActivityLog();
    expect(log).not.toContainEqual("Already at end of execution.");
  });
});

// ============================================================================
// Print and checkpoint
// ============================================================================

describe("Debugger print and checkpoint", () => {
  it("print looks up a local variable", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // past x = 1
    await session.press("p");
    await session.type("x");

    const log = session.ui.state.getActivityLog();
    expect(log).toContainEqual("x = 1");
  });

  it("print reports not found for nonexistent variable", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("p");
    await session.type("doesNotExist");

    const log = session.ui.state.getActivityLog();
    expect(log).toContainEqual("doesNotExist = (not found)");
  });

  it("checkpoint pins with a label", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s");
    await session.press("k");
    await session.type("my-label");

    const log = session.ui.state.getActivityLog();
    expect(log.some((l) => l.includes("Pinned checkpoint") && l.includes('"my-label"'))).toBe(true);

    const checkpoints = session.driver.debuggerState.getCheckpoints();
    const pinned = checkpoints.filter((cp) => cp.pinned);
    expect(pinned.length).toBeGreaterThan(0);
    expect(pinned.some((cp) => cp.label === "my-label")).toBe(true);
  });

  it("checkpoint pins without a label", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s");
    await session.press("k");
    await session.press("enter"); // empty label

    const checkpoints = session.driver.debuggerState.getCheckpoints();
    const pinned = checkpoints.filter((cp) => cp.pinned);
    expect(pinned.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Function calls (stepIn, next, stepOut)
// ============================================================================

describe("Debugger stepping with function calls", () => {
  it("stepIn enters a function call", async () => {
    const mod = await freshImport(fnCallCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // x = 1
    await session.press("s"); // at y = add(x, 2)
    await session.press("i"); // stepIn to add()
    await session.press("s", { times: 10 }); // step through add + rest

    const result = await session.quit();
    expect(result).toBe(17);
  });

  it("next steps over a function call", async () => {
    const mod = await freshImport(fnCallCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // x = 1
    await session.press("n"); // next — step OVER add()
    await session.press("s", { times: 10 }); // step through rest

    const result = await session.quit();
    expect(result).toBe(17);
  });

  it("stepOut exits a function back to caller", async () => {
    const mod = await freshImport(fnCallCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // x = 1
    await session.press("i"); // stepIn to add()
    await session.press("s"); // inside add: result = a + b
    await session.press("o"); // stepOut back to main
    await session.press("s", { times: 10 }); // step through rest

    const result = await session.quit();
    expect(result).toBe(17);
  });
});

// ============================================================================
// Variable overrides (set)
// ============================================================================

describe("Debugger set (variable overrides)", () => {
  it("set overrides a local variable and affects execution", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    // step-test: x = 1, y = 2, z = x + y, return z
    // Step past x = 1, set x = 10, then continue.
    // z should be 10 + 2 = 12 instead of 1 + 2 = 3.
    await session.press("s"); // past x = 1
    await session.press(":"); // command mode
    await session.type("set x = 10");
    await session.press("c");

    const result = await session.quit();
    expect(result).toBe(12);
  });
});

// ============================================================================
// User interrupt handling
// ============================================================================

describe("Debugger user interrupt handling", () => {
  it("resolve provides a value for an interrupted variable", async () => {
    const mod = await freshImport(interruptCompiled);
    const session = await DebuggerTestSession.create({ mod });

    // interrupt-test: x = 1, y = interrupt("check value"), z = x + y, return z
    await session.press("s"); // past x = 1
    await session.press("s"); // hits interrupt — promptForInput opens
    // The prompt "approve / reject / resolve <value>" appears as text input
    await session.type("resolve 5");
    await session.press("s", { times: 10 });

    const result = await session.quit();
    expect(result).toBe(6);
  });

  // TODO: reject hangs — the interrupt prompt timing needs investigation
  it.skip("reject causes the function to return a failure", async () => {
    const mod = await freshImport(interruptCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // past x = 1
    await session.press("s"); // hits interrupt — promptForInput opens
    await session.type("reject");
    // After reject, the program returns a failure result.
    // Step through remaining debug pauses then quit.
    await session.press("s", { times: 10 });

    const result = await session.quit();
    expect(result).toMatchObject({
      success: false,
      error: "interrupt rejected",
      retryable: false,
    });
  }, 15000);
});

// ============================================================================
// StepBack and rewind
// ============================================================================

describe("Debugger stepBack and rewind", () => {
  it("stepBack at earliest checkpoint does not move", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("up"); // stepBack at earliest
    await session.press("c");

    const result = await session.quit();
    expect(result).toBe(3);

    const log = session.ui.state.getActivityLog();
    expect(log).toContainEqual("Already at earliest checkpoint");
  });

  it("stepBack with preserveOverrides keeps pending overrides", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    // step-test: x = 1, y = 2, z = x + y, return z
    // Step past x=1 and y=2, override x=10, then stepBack with preserveOverrides.
    await session.press("s"); // past x = 1
    await session.press("s"); // past y = 2
    await session.press(":"); // command mode
    await session.type("set x = 10");
    await session.press("up", { shift: true }); // stepBack with preserveOverrides
    await session.press("s", { times: 10 }); // step forward — x override applied

    const result = await session.quit();
    // x was overridden to 10, so z = 10 + 2 = 12
    expect(result).toBe(12);
  });

  it("rewind cancelled by escape stays put", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s");
    await session.press("r"); // open rewind selector
    await session.press("escape"); // cancel
    await session.press("c");

    const result = await session.quit();
    expect(result).toBe(3);
  });
});

// ============================================================================
// Loops
// ============================================================================

describe("Debugger with loops", () => {
  it("steps through a for loop and returns correct result", async () => {
    // loop-test: sum = 0, for i in range(3) { sum = sum + i }, return sum
    const mod = await freshImport(loopCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s", { times: 30 });

    const result = await session.quit();
    expect(result).toBe(3);
  });

  it("continue runs through the entire loop", async () => {
    const mod = await freshImport(loopCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("c");

    const result = await session.quit();
    expect(result).toBe(3);
  });
});

// ============================================================================
// If/else
// ============================================================================

describe("Debugger with if/else", () => {
  it("steps through the then branch when condition is true", async () => {
    const mod = await freshImport(ifElseCompiled);
    const session = await DebuggerTestSession.create({ mod, args: [5] });

    await session.press("s", { times: 20 });

    const result = await session.quit();
    expect(result).toBe("positive");
  });

  it("steps through the else branch when condition is false", async () => {
    const mod = await freshImport(ifElseCompiled);
    const session = await DebuggerTestSession.create({ mod, args: [-1] });

    await session.press("s", { times: 20 });

    const result = await session.quit();
    expect(result).toBe("non-positive");
  });
});

// ============================================================================
// Nested function calls
// ============================================================================

describe("Debugger with nested function calls", () => {
  // nested-calls-test:
  //   def double(n) { result = n * 2; return result }
  //   def addAndDouble(a, b) { sum = a + b; result = double(sum); return result }
  //   node main() { x = addAndDouble(1, 2); return x }
  // Expected: double(1 + 2) = double(3) = 6

  it("stepIn reaches the innermost function", async () => {
    const mod = await freshImport(nestedCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("i"); // main → enter addAndDouble
    await session.press("s"); // addAndDouble: sum = a + b
    await session.press("s"); // past sum = a + b
    await session.press("i"); // enter double
    await session.press("s", { times: 20 });

    const result = await session.quit();
    expect(result).toBe(6);
  });

  it("next at top level skips all nested calls", async () => {
    const mod = await freshImport(nestedCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("n"); // step OVER addAndDouble (and double inside it)
    await session.press("s", { times: 10 });

    const result = await session.quit();
    expect(result).toBe(6);
  });

  it("stepOut from innermost function returns to middle function", async () => {
    const mod = await freshImport(nestedCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("i"); // enter addAndDouble
    await session.press("s"); // addAndDouble: before sum = a + b
    await session.press("i"); // enter double
    await session.press("s"); // inside double: result = n * 2
    await session.press("o"); // stepOut → back in addAndDouble
    await session.press("s", { times: 20 });

    const result = await session.quit();
    expect(result).toBe(6);
  });
});

// ============================================================================
// Loaded trace checkpoints
// ============================================================================

describe("Debugger with loaded trace checkpoints", () => {
  it("starts at the last checkpoint and can interact", async () => {
    const checkpoints = await collectCheckpoints();
    expect(checkpoints.length).toBeGreaterThan(0);

    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod, checkpoints });

    // Should have rendered — we can inspect the frame
    const frame = session.frame();
    expect(frame).toBeDefined();
  });

  it("blocks forward stepping at end of execution", async () => {
    const checkpoints = await collectCheckpoints();
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod, checkpoints });

    await session.press("s"); // should be blocked

    const log = session.ui.state.getActivityLog();
    expect(log).toContainEqual("Already at end of execution.");
  });

  it("can print variables from loaded checkpoints", async () => {
    const checkpoints = await collectCheckpoints();
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod, checkpoints });

    await session.press("p");
    await session.type("z");

    const log = session.ui.state.getActivityLog();
    expect(log).toContainEqual("z = 3");
  });

  it("can step back and then step forward (clears programFinished)", async () => {
    const checkpoints = await collectCheckpoints();
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod, checkpoints });

    await session.press("up"); // stepBack
    await session.press("s"); // step forward (re-executes)

    // Should not see "Already at end" since stepBack cleared programFinished
    const log = session.ui.state.getActivityLog();
    expect(log).not.toContainEqual("Already at end of execution.");
  });
});

// ============================================================================
// Loaded single checkpoint
// ============================================================================

describe("Debugger with loaded single checkpoint", () => {
  it("loads a single checkpoint and renders it", async () => {
    const checkpoints = await collectCheckpoints();
    const midpoint = checkpoints[Math.floor(checkpoints.length / 2)];

    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({
      mod,
      checkpoints: [midpoint],
    });

    const frame = session.frame();
    expect(frame).toBeDefined();
  });

  it("can step back and forward from a single loaded checkpoint", async () => {
    const checkpoints = await collectCheckpoints();
    const firstCp = checkpoints[0];

    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({
      mod,
      checkpoints: [firstCp],
    });

    await session.press("up"); // stepBack — clears programFinished
    await session.press("s"); // step forward

    // Should have rendered at least a couple frames
    expect(session.recorder.frames.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// Save and load
// (Kept as .skip — the save/load commands require `:save <path>` and
// `:load <path>` which need file paths typed into the command bar.
// The original test was also .skip.)
// ============================================================================

describe.skip("Debugger save and load", () => {
  const saveFile = path.join(fixtureDir, "__test-checkpoint.json");

  afterAll(() => {
    try { fs.unlinkSync(saveFile); } catch { /* ignore */ }
  });

  it("save and load preserves overridden variable state", async () => {
    // First run: step forward, override x, save
    const mod1 = await freshImport(stepTestCompiled);
    const session1 = await DebuggerTestSession.create({ mod: mod1 });

    await session1.press("s"); // past x = 1
    await session1.press(":"); await session1.type("set x = 10");
    await session1.press("s"); // resume with override
    await session1.press(":"); await session1.type(`save ${saveFile}`);

    expect(fs.existsSync(saveFile)).toBe(true);

    // Second run: load and continue
    const mod2 = await freshImport(stepTestCompiled);
    const session2 = await DebuggerTestSession.create({ mod: mod2 });

    await session2.press(":"); await session2.type(`load ${saveFile}`);
    await session2.press("s", { times: 10 });

    const result = await session2.quit();
    expect(result).toBe(12);
  });
});
