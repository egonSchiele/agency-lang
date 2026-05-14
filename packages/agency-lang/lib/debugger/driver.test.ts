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

// Compiled fixtures are shared across test files (testSession.test.ts,
// exportFrames.test.ts) so we compile but don't clean up — tests/debugger/*.ts
// is in .gitignore to exclude generated files from git.
beforeAll(() => {
  compile({ debugger: true }, stepTestAgency, stepTestCompiled, { ts: true });
  compile({ debugger: true }, fnCallAgency, fnCallCompiled, { ts: true });
  compile({ debugger: true }, interruptAgency, interruptCompiled, { ts: true });
  compile({ debugger: true }, loopAgency, loopCompiled, { ts: true });
  compile({ debugger: true }, ifElseAgency, ifElseCompiled, { ts: true });
  compile({ debugger: true }, nestedAgency, nestedCompiled, { ts: true });
});

// --- Helpers ---

async function collectCheckpoints() {
  const mod = await freshImport(stepTestCompiled);
  const session = await DebuggerTestSession.create({ mod });
  await session.press("s", { times: 20 });
  return session.driver.debuggerState.getCheckpoints();
}

function sourceText(session: DebuggerTestSession): string {
  return session.frame().findByKey("source")!.toPlainText();
}

function localsText(session: DebuggerTestSession): string {
  return session.frame().findByKey("locals")!.toPlainText();
}

function activityLog(session: DebuggerTestSession): string[] {
  return session.ui.state.getActivityLog();
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

    expect(activityLog(session)).toContainEqual("Already at end of execution.");
  });

  it("after program finishes, can step back to an earlier state", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("c"); // run to completion

    await session.press("up"); // stepBack

    expect(activityLog(session)).not.toContainEqual("Already at earliest checkpoint");
    // After stepping back, the source pane should still show step-test
    expect(sourceText(session)).toContain("step-test");
    // And we should be able to step forward (program not stuck)
    await session.press("s");
    expect(activityLog(session)).not.toContainEqual("Already at end of execution.");
  });

  it("after stepping back, can step forward again", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("c"); // run to completion
    await session.press("up"); // stepBack — programFinished must be cleared
    await session.press("s"); // step forward should now be unblocked

    // The contract: after stepping back from end-of-program, the
    // program is no longer "finished" and forward stepping works.
    expect(activityLog(session)).not.toContainEqual("Already at end of execution.");
  });

  it("source pane shows the correct file and current line marker", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    // Initial state — first line of main
    const src = sourceText(session);
    expect(src).toContain("step-test");
    expect(src).toContain("node main()");
    // The `>` marker should be on a line
    expect(src).toMatch(/>\s+\d+\s+/);
  });

  it("locals pane updates as variables are assigned", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    // Before any variable is assigned
    expect(localsText(session)).not.toContain("x = 1");

    await session.press("s"); // past x = 1
    expect(localsText(session)).toContain("x = 1");
    expect(localsText(session)).not.toContain("y = 2");

    await session.press("s"); // past y = 2
    expect(localsText(session)).toContain("x = 1");
    expect(localsText(session)).toContain("y = 2");

    await session.press("s"); // past z = x + y
    expect(localsText(session)).toContain("z = 3");
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

    expect(activityLog(session)).toContainEqual("x = 1");
  });

  it("print reports not found for nonexistent variable", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("p");
    await session.type("doesNotExist");

    expect(activityLog(session)).toContainEqual("doesNotExist = (not found)");
  });

  it("checkpoint pins with a label", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s");
    await session.press("k");
    await session.type("my-label");

    const log = activityLog(session);
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
  it("stepIn enters a function call and shows function locals", async () => {
    const mod = await freshImport(fnCallCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // x = 1
    await session.press("s"); // at y = add(x, 2)
    await session.press("i"); // stepIn to add()

    // After stepping in, the source should show the add function body
    expect(sourceText(session)).toContain("result = a + b");
    // Locals should show add's parameters, not main's
    const locals = localsText(session);
    expect(locals).toContain("a = 1");
    expect(locals).toContain("b = 2");

    await session.press("s", { times: 10 });
    const result = await session.quit();
    expect(result).toBe(17);
  });

  it("next steps over a function call without entering it", async () => {
    const mod = await freshImport(fnCallCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // x = 1
    // Before next, we're at the line calling add()
    await session.press("n"); // next — step OVER add()

    // After stepping over, we should NOT see add's parameters
    const locals = localsText(session);
    expect(locals).not.toContain("a = 1");
    expect(locals).not.toContain("b = 2");
    // We should still be in the main function's source
    expect(sourceText(session)).toContain("node main()");

    await session.press("s", { times: 10 });
    const result = await session.quit();
    expect(result).toBe(17);
  });

  it("stepOut exits a function back to caller", async () => {
    const mod = await freshImport(fnCallCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // x = 1
    await session.press("i"); // stepIn to add()
    // Verify we're inside add
    expect(localsText(session)).toContain("a = 1");

    await session.press("s"); // inside add: result = a + b
    await session.press("o"); // stepOut back to main

    // After stepOut, we should be back in main (no more add params)
    const locals = localsText(session);
    expect(locals).not.toContain("a = 1");
    expect(sourceText(session)).toContain("node main()");

    await session.press("s", { times: 10 });
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
    await session.type("resolve 5");
    await session.press("s", { times: 10 });

    const result = await session.quit();
    expect(result).toBe(6);
  });

  it("reject causes the function to return a failure", async () => {
    const mod = await freshImport(interruptCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // past x = 1
    await session.press("s"); // hits interrupt — promptForInput opens
    await session.type("reject");
    await session.press("s", { times: 10 });

    const result = await session.quit();
    expect(result).toMatchObject({
      success: false,
      error: "interrupt rejected",
      retryable: false,
    });
  });
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

    expect(activityLog(session)).toContainEqual("Already at earliest checkpoint");
  });

  it("stepBack moves to an earlier execution state", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // past x = 1
    await session.press("s"); // past y = 2
    // Now we should see y = 2 in locals
    expect(localsText(session)).toContain("y = 2");

    await session.press("up"); // stepBack
    // After stepping back, y should no longer be 2 (earlier state)
    // or at minimum we should be at a different execution point
    expect(activityLog(session)).not.toContainEqual("Already at earliest checkpoint");
  });

  it("stepBack with preserveOverrides keeps pending overrides", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // past x = 1
    await session.press("s"); // past y = 2
    await session.press(":"); // command mode
    await session.type("set x = 10");
    await session.press("up", { shift: true }); // stepBack with preserveOverrides
    await session.press("s", { times: 10 });

    const result = await session.quit();
    expect(result).toBe(12);
  });

  it("stepBack actually rewinds: locals reflect an earlier state", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // past x = 1
    await session.press("s"); // past y = 2
    expect(localsText(session)).toContain("x = 1");
    expect(localsText(session)).toContain("y = 2");

    await session.press("up"); // stepBack one checkpoint
    // We should be back to a state where y is no longer set
    expect(localsText(session)).not.toContain("y = 2");
  });

  it("stepBack then step forward replays correctly", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    // step-test: x = 1, y = 2, z = x + y, return z
    await session.press("s"); // past x = 1
    await session.press("s"); // past y = 2
    await session.press("s"); // past z = x + y
    expect(localsText(session)).toContain("z = 3");

    await session.press("up"); // back to before z = x + y
    expect(localsText(session)).not.toContain("z = 3");

    await session.press("s"); // step forward — z should be 3 again
    expect(localsText(session)).toContain("z = 3");
  });

  it("rewind cancelled by escape stays put", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s");
    const localsBefore = localsText(session);
    await session.press("r"); // open rewind selector
    await session.press("escape"); // cancel
    const localsAfter = localsText(session);

    // Locals should be unchanged after cancelling rewind
    expect(localsAfter).toBe(localsBefore);

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
    // Should see addAndDouble's source/params
    expect(sourceText(session)).toContain("sum = a + b");
    expect(localsText(session)).toContain("a = 1");

    await session.press("s"); // addAndDouble: sum = a + b
    await session.press("s"); // past sum = a + b
    await session.press("i"); // enter double

    // Should now see double's source/params
    expect(sourceText(session)).toContain("result = n * 2");
    expect(localsText(session)).toContain("n = 3");

    await session.press("s", { times: 20 });
    const result = await session.quit();
    expect(result).toBe(6);
  });

  it("next at top level skips all nested calls", async () => {
    const mod = await freshImport(nestedCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("n"); // step OVER addAndDouble (and double inside it)

    // Should still be in main, never see addAndDouble or double params
    const locals = localsText(session);
    expect(locals).not.toContain("a = 1");
    expect(locals).not.toContain("n = 3");
    expect(sourceText(session)).toContain("node main()");

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
    // Verify we're in double
    expect(localsText(session)).toContain("n = 3");

    await session.press("s"); // inside double: result = n * 2
    await session.press("o"); // stepOut → back in addAndDouble

    // Should be back in addAndDouble, not in double
    const locals = localsText(session);
    expect(locals).not.toContain("n = 3");
    // Should see addAndDouble's source
    expect(sourceText(session)).toContain("sum = a + b");

    await session.press("s", { times: 20 });
    const result = await session.quit();
    expect(result).toBe(6);
  });
});

// ============================================================================
// Loaded trace checkpoints
// ============================================================================

describe("Debugger with loaded trace checkpoints", () => {
  it("starts at the last checkpoint with correct state", async () => {
    const checkpoints = await collectCheckpoints();
    expect(checkpoints.length).toBeGreaterThan(0);

    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod, checkpoints });

    // Should have rendered with the final program state
    expect(sourceText(session)).toContain("step-test");
    // The final checkpoint should have z = 3
    expect(localsText(session)).toContain("z = 3");
  });

  it("blocks forward stepping at end of execution", async () => {
    const checkpoints = await collectCheckpoints();
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod, checkpoints });

    await session.press("s"); // should be blocked

    expect(activityLog(session)).toContainEqual("Already at end of execution.");
  });

  it("can print variables from loaded checkpoints", async () => {
    const checkpoints = await collectCheckpoints();
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod, checkpoints });

    await session.press("p");
    await session.type("z");

    expect(activityLog(session)).toContainEqual("z = 3");
  });

  it("can step back and then step forward (clears programFinished)", async () => {
    const checkpoints = await collectCheckpoints();
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod, checkpoints });

    // Verify we start at end of execution
    await session.press("s");
    expect(activityLog(session)).toContainEqual("Already at end of execution.");

    await session.press("up"); // stepBack
    await session.press("s"); // step forward — should NOT be blocked now

    // The last log entry should NOT be "Already at end" — stepping worked
    const log = activityLog(session);
    const lastEndIdx = log.lastIndexOf("Already at end of execution.");
    // If there is a second "Already at end", the step didn't work
    const endCount = log.filter((l) => l === "Already at end of execution.").length;
    expect(endCount).toBe(1); // only the first attempt, not after stepBack+step
  });
});

// ============================================================================
// Loaded single checkpoint
// ============================================================================

describe("Debugger with loaded single checkpoint", () => {
  it("loads a single checkpoint and renders correct state", async () => {
    const checkpoints = await collectCheckpoints();
    const midpoint = checkpoints[Math.floor(checkpoints.length / 2)];

    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({
      mod,
      checkpoints: [midpoint],
    });

    // Should show step-test source
    expect(sourceText(session)).toContain("step-test");
    // Frame should be renderable
    const frame = session.frame();
    expect(frame.findByKey("locals")).toBeDefined();
    expect(frame.findByKey("source")).toBeDefined();
  });

  it("can step back from a loaded checkpoint with multiple checkpoints", async () => {
    const checkpoints = await collectCheckpoints();
    expect(checkpoints.length).toBeGreaterThan(2);

    const mod = await freshImport(stepTestCompiled);
    // Load the last two checkpoints so stepBack has somewhere to go
    const lastTwo = checkpoints.slice(-2);
    const session = await DebuggerTestSession.create({
      mod,
      checkpoints: lastTwo,
    });

    await session.press("up"); // stepBack — clears programFinished
    await session.press("s"); // step forward

    expect(activityLog(session)).not.toContainEqual("Already at end of execution.");
    expect(session.recorder.frames.length).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================================
// UI interaction: focus, zoom, text input
// ============================================================================

describe("Debugger UI interactions", () => {
  it("tab cycles focus between panes", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    // Initially source pane is focused (index 0)
    // After tab, next pane should be focused
    await session.press("tab");

    // The focused pane should have a white border — check that
    // the frame rendered successfully (focus is internal state,
    // but we can verify the render didn't crash)
    const frame = session.frame();
    expect(frame).toBeDefined();

    // Tab again to cycle further
    await session.press("tab");
    const frame2 = session.frame();
    expect(frame2).toBeDefined();
  });

  it("number keys jump to specific panes", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    // Press "2" to jump to locals pane (index 1)
    await session.press("2");
    // Press "up" — should scroll locals, not stepBack (source-only behavior)
    // This verifies focus actually moved away from source
    await session.press("up");
    // If source were focused, "up" would trigger stepBack and we'd see the log message
    expect(activityLog(session)).not.toContainEqual("Already at earliest checkpoint");
  });

  it("zoom toggles a pane to full screen and back", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    const frameBefore = session.frame();
    // Source, locals, globals, callStack, activity, stdout should all be present
    expect(frameBefore.findByKey("source")).toBeDefined();
    expect(frameBefore.findByKey("locals")).toBeDefined();
    expect(frameBefore.findByKey("activity")).toBeDefined();

    // Zoom the source pane
    await session.press("z");
    const frameZoomed = session.frame();
    // Source should still be present
    expect(frameZoomed.findByKey("source")).toBeDefined();
    // Other panes should NOT be present in zoomed mode
    expect(frameZoomed.findByKey("locals")).toBeUndefined();
    expect(frameZoomed.findByKey("activity")).toBeUndefined();

    // Unzoom
    await session.press("z");
    const frameUnzoomed = session.frame();
    // All panes should be back
    expect(frameUnzoomed.findByKey("source")).toBeDefined();
    expect(frameUnzoomed.findByKey("locals")).toBeDefined();
    expect(frameUnzoomed.findByKey("activity")).toBeDefined();
  });

  it("escape during text input cancels without executing", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // past x = 1
    // Start print prompt then cancel with escape
    await session.press("p"); // opens text input
    await session.press("escape"); // cancel

    // Print was cancelled — no "x = ..." entry in the log
    const log = activityLog(session);
    expect(log.every((l) => !l.match(/^\w+ = /))).toBe(true);

    // The debugger should still be functional
    await session.press("c");
    const result = await session.quit();
    expect(result).toBe(3);
  });

  it("command bar shows key bindings", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    const cmdBar = session.frame().findByKey("commandBar");
    expect(cmdBar).toBeDefined();
    const cmdText = cmdBar!.toPlainText();
    expect(cmdText).toContain("step");
    expect(cmdText).toContain("continue");
    expect(cmdText).toContain("quit");
  });
});

// ============================================================================
// Checkpoints panel (d key)
// ============================================================================

describe("Debugger checkpoints panel", () => {
  it("opens and closes with escape", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // step to create some checkpoints
    await session.press("s");
    await session.press("d"); // open checkpoints panel

    // The panel should render — we just verify no crash
    const frame = session.frame();
    expect(frame).toBeDefined();

    await session.press("escape"); // close panel

    // Should be back to normal view with all panes
    const frameAfter = session.frame();
    expect(frameAfter.findByKey("source")).toBeDefined();
    expect(frameAfter.findByKey("locals")).toBeDefined();
  });
});

// ============================================================================
// Invalid commands
// ============================================================================

describe("Debugger invalid commands", () => {
  it("invalid : command does not crash", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press(":");
    await session.type("not a real command");

    // Should not crash — the debugger should still be functional
    await session.press("c");
    const result = await session.quit();
    expect(result).toBe(3);
  });
});

// ============================================================================
// Save and load
// ============================================================================

describe("Debugger save and load", () => {
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
