// A debugger installed on a program that a TypeScript caller is running.
// Every test calls the compiled node function the way a TypeScript program
// would and checks that the caller never sees a debug stop: it gets the
// program's own interrupts and the final value, while the attached driver
// answers the stops in between. See
// docs/superpowers/specs/2026-10-20-attach-to-a-running-program.md.
import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { DebuggerDriver } from "./driver.js";
import { TestDebuggerIO, fixtureDir, freshImport, withLLMMocks } from "./testHelpers.js";
import type { DebuggerCommand } from "./types.js";
import { hasInterrupts, isDebugger } from "@/runtime/interrupts.js";
import { isPaused } from "@/runtime/pause.js";
import * as helper from "../../tests/debugger/waiter.js";

const fixtures = {
  stepTest: "step-test",
  awaitsHelper: "awaits-helper",
  topLevelInterrupt: "top-level-interrupt",
  policyEffect: "policy-effect",
  mixedBatch: "mixed-batch",
  llmAfterStep: "llm-after-step",
  agentShaped: "agent-shaped",
};

function compiledPath(name: string): string {
  return path.join(fixtureDir, `${name}.ts`);
}

beforeAll(() => {
  for (const name of Object.values(fixtures)) {
    compile({}, path.join(fixtureDir, `${name}.agency`), compiledPath(name), { ts: true });
  }
});

/** A driver in attached mode on `mod`, installed, with `commands` as the
 *  person's answers. When the commands run out the IO answers `quit`,
 *  which attached means detach. */
function attachTo(mod: any, commands: DebuggerCommand[], io = new TestDebuggerIO(commands)) {
  const driver = new DebuggerDriver({
    mod: {
      respondToInterrupts: mod.respondToInterrupts,
      rewindFrom: mod.rewindFrom,
      __setDebugger: mod.__setDebugger,
      __getCheckpoints: mod.__getCheckpoints,
    },
    rewindSize: 30,
    ui: io,
    attached: true,
  });
  driver.attach();
  return { driver, io };
}

/** A caller must never be handed a debug stop. */
function expectNoStop(result: any): void {
  if (hasInterrupts(result?.data)) {
    expect(result.data.some((intr: unknown) => isDebugger(intr))).toBe(false);
  }
}

describe("a debugger attached to a program a TypeScript caller runs", () => {
  it("attached before the call, the caller gets only the final value", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    const { io } = attachTo(mod, [{ type: "step" }, { type: "step" }, { type: "continue" }]);

    const result = await mod.main();

    expectNoStop(result);
    expect(result.data).toBe(3);
    expect(io.renderCalls.length).toBeGreaterThanOrEqual(3);
    expect(io.logLines).toContainEqual("Program finished. Return value: 3");
  });

  it("attached while the program runs, it stops at the next statement", async () => {
    const mod = await freshImport(compiledPath(fixtures.awaitsHelper));
    const running = mod.main();
    await helper.untilWaiting();

    const { io } = attachTo(mod, [{ type: "step" }, { type: "continue" }]);
    helper.releaseWaiter();
    const result = await running;

    expectNoStop(result);
    expect(result.data).toBe(2);
    // The stop after the helper returned, and the one after `step`.
    expect(io.renderCalls.length).toBeGreaterThanOrEqual(2);
    expect(io.renderCalls[0]!.scopeName).toBe("main");
  });

  it("attached between two legs, the new leg stops", async () => {
    const mod = await freshImport(compiledPath(fixtures.policyEffect));
    const first = await mod.main();
    expect(hasInterrupts(first.data)).toBe(true);
    expect(first.data[0].effect).toBe("test::secret");

    const { io } = attachTo(mod, [{ type: "step" }, { type: "continue" }]);
    const final = await mod.respondToInterrupts(first.data, [{ type: "approve" }]);

    expectNoStop(final);
    expect(final.data).toBe("the secret");
    // The stop after the approved read, and the one after `step`.
    expect(io.renderCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("the policy the caller started the run with still rejects after a step", async () => {
    const mod = await freshImport(compiledPath(fixtures.policyEffect));
    attachTo(mod, [{ type: "step" }, { type: "step" }, { type: "continue" }]);

    const result = await mod.main({ policy: { "test::secret": [{ action: "reject" }] } });

    expectNoStop(result);
    expect(result.data).toBe("rejected");
  });

  it("two runs stopped at once each resume with their own policy", async () => {
    const mod = await freshImport(compiledPath(fixtures.policyEffect));
    attachTo(mod, [{ type: "continue" }, { type: "continue" }]);

    const [rejecting, approving] = await Promise.all([
      mod.main({ policy: { "test::secret": [{ action: "reject" }] } }),
      mod.main({ policy: { "test::secret": [{ action: "approve" }] } }),
    ]);

    expectNoStop(rejecting);
    expectNoStop(approving);
    expect(rejecting.data).toBe("rejected");
    expect(approving.data).toBe("the secret");
  });

  it("the caller's answer to a tool's interrupt survives attaching between legs", async () => {
    // The tool call was in progress when the caller's leg paused, so the
    // resume re-enters it with the answer. A stop before the call would
    // start a leg without that answer, and the tool would ask again.
    await withLLMMocks(
      [{ toolCall: { name: "confirm", args: { note: "x" } } }, { return: "done" }],
      async () => {
        const mod = await freshImport(compiledPath(fixtures.agentShaped));
        const paused = await mod.main("task");
        expect(hasInterrupts(paused.data)).toBe(true);
        expect(paused.data[0].message).toBe("confirm x?");

        attachTo(mod, [{ type: "continue" }]);
        const final = await mod.respondToInterrupts(paused.data, [{ type: "approve" }]);

        expectNoStop(final);
        expect(final.data).toBe("done");
      },
    );
  });

  it("without the policy the same program asks the caller", async () => {
    const mod = await freshImport(compiledPath(fixtures.policyEffect));
    attachTo(mod, [{ type: "step" }, { type: "step" }, { type: "continue" }]);

    const paused = await mod.main();

    expect(hasInterrupts(paused.data)).toBe(true);
    expect(paused.data).toHaveLength(1);
    expect(paused.data[0].effect).toBe("test::secret");
  });

  it("the caller's callbacks and the driver's both fire from a leg the debugger ran", async () => {
    // onAgentEnd fires only for a run that finishes in its first leg, with
    // or without a debugger, so the model call is the event to watch: it
    // happens in the leg after the step, and both halves of the composed
    // callbacks must see it.
    await withLLMMocks([{ return: "hi" }], async () => {
      const mod = await freshImport(compiledPath(fixtures.llmAfterStep));
      const { io } = attachTo(mod, [{ type: "step" }, { type: "continue" }]);
      const calls: string[] = [];

      const result = await mod.main({
        callbacks: { onLLMCallEnd: () => calls.push("caller") },
      });

      expect(result.data).toBe("hi");
      expect(calls).toEqual(["caller"]);
      expect(io.logLines.some((line) => line.startsWith("LLM returned"))).toBe(true);
    });
  });

  it("the caller's usage is the same run's usage with no debugger, however many steps", async () => {
    const plain = await withLLMMocks([{ return: "hi" }], async () => {
      const mod = await freshImport(compiledPath(fixtures.llmAfterStep));
      return await mod.main();
    });
    expect(plain.usage.tokens.totalTokens).toBeGreaterThan(0);

    await withLLMMocks([{ return: "hi" }], async () => {
      const mod = await freshImport(compiledPath(fixtures.llmAfterStep));
      // Two more stops after the model call: each leg reports the run's
      // total so far, and the figure must not grow with the stepping.
      attachTo(mod, [{ type: "step" }, { type: "step" }, { type: "step" }, { type: "continue" }]);

      const result = await mod.main();

      expectNoStop(result);
      expect(result.data).toBe("hi");
      expect(result.usage.tokens).toEqual(plain.usage.tokens);
      expect(result.usage.cost).toEqual(plain.usage.cost);
    });
  });

  it("the caller's onAgentEnd fires once with the final value when the debugger ran the last leg", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    attachTo(mod, [{ type: "step" }, { type: "continue" }]);
    const ended: unknown[] = [];

    const result = await mod.main({
      callbacks: { onAgentEnd: (data: any) => ended.push(data.result.data) },
    });

    expect(result.data).toBe(3);
    expect(ended).toEqual([3]);
  });

  it("the caller's onAgentEnd fires once when the debugger ran no leg", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    const { driver } = attachTo(mod, []);
    driver.debuggerState.running();
    const ended: unknown[] = [];

    const result = await mod.main({
      callbacks: { onAgentEnd: (data: any) => ended.push(data.result.data) },
    });

    expect(result.data).toBe(3);
    expect(ended).toEqual([3]);
  });

  it("a second run on the same driver steps from its own first stop", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    const { driver, io } = attachTo(mod, [
      { type: "continue" },
      { type: "step" },
      { type: "continue" },
    ]);

    expect((await mod.main()).data).toBe(3);
    const rendersInFirstRun = io.renderCalls.length;
    driver.debuggerState.stepping();
    expect((await mod.main()).data).toBe(3);

    expect(io.logLines).not.toContain("Already at end of execution.");
    // The second run's first stop and the one after `step`.
    expect(io.renderCalls.length).toBe(rendersInFirstRun + 2);
  });

  it("a rewind from the attached driver keeps the run's usage", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    attachTo(mod, [{ type: "step" }, { type: "step" }, { type: "stepBack" }, { type: "continue" }]);

    const result = await mod.main();

    expectNoStop(result);
    expect(result.data).toBe(3);
    expect(result.usage).toBeDefined();
    expect(result.usage.tokens.totalTokens).toBe(0);
  });

  it("a resume from a paused checkpoint settles its stops too", async () => {
    const mod = await freshImport(compiledPath(fixtures.awaitsHelper));
    const pause = new AbortController();
    const running = mod.main({ pauseSignal: pause.signal });
    await helper.untilWaiting();
    pause.abort();
    helper.releaseWaiter();
    const paused = await running;
    expect(isPaused(paused.data)).toBe(true);

    const { io } = attachTo(mod, [{ type: "step" }, { type: "continue" }]);
    const final = await mod.resumeFromCheckpoint(paused.data);

    expectNoStop(final);
    expect(final.data).toBe(2);
    expect(io.renderCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("a batch that mixes a stop and a program interrupt reaches the caller without the stop", async () => {
    const mod = await freshImport(compiledPath(fixtures.mixedBatch));
    const { io } = attachTo(mod, [{ type: "continue" }]);

    const paused = await mod.main();

    expect(hasInterrupts(paused.data)).toBe(true);
    expect(paused.data).toHaveLength(1);
    expect(isDebugger(paused.data[0])).toBe(false);
    expect(paused.data[0].message).toBe("ask?");

    const final = await mod.respondToInterrupts(paused.data, [{ type: "approve" }]);

    expectNoStop(final);
    expect(final.data).toBe(3);
    // The first stop (before `parallel`) was shown; the dropped one was not.
    expect(io.renderCalls).toHaveLength(1);
  });

  it("set from the attached debugger changes a local the program returns", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    attachTo(mod, [
      { type: "step" }, // past x = 1
      { type: "set", varName: "x", value: 10 },
      { type: "continue" },
    ]);

    const result = await mod.main();

    expect(result.data).toBe(12);
  });

  it("detaching while stopped lets the program finish", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    // After one step the IO never answers; the test detaches instead.
    let atSecondStop: () => void = () => {};
    const secondStop = new Promise<void>((resolve) => {
      atSecondStop = resolve;
    });
    const io = new (class extends TestDebuggerIO {
      private answered = false;
      override async waitForCommand(): Promise<DebuggerCommand> {
        if (!this.answered) {
          this.answered = true;
          return { type: "step" };
        }
        atSecondStop();
        return await new Promise(() => {});
      }
    })([]);
    const { driver } = attachTo(mod, [], io);

    const running = mod.main();
    await secondStop;
    const rendersBeforeDetach = io.renderCalls.length;
    driver.detach();
    const result = await running;

    expect(result.data).toBe(3);
    expect(rendersBeforeDetach).toBe(2);
    expect(io.renderCalls.length).toBe(rendersBeforeDetach);
    expect(driver.debuggerState.attached).toBeUndefined();
  });

  it("detaching while the program runs costs nothing from then on", async () => {
    const mod = await freshImport(compiledPath(fixtures.awaitsHelper));
    const { driver, io } = attachTo(mod, [{ type: "continue" }]);

    const running = mod.main();
    await helper.untilWaiting();
    // Back to stepping, as a pause key will do, so the next statement
    // would stop and record a checkpoint if the debugger were still there.
    driver.debuggerState.stepping();
    driver.detach();
    const rendersAtDetach = io.renderCalls.length;
    const checkpointsAtDetach = driver.debuggerState.getCheckpoints().length;
    helper.releaseWaiter();
    const result = await running;

    expect(result.data).toBe(2);
    expect(io.renderCalls.length).toBe(rendersAtDetach);
    expect(driver.debuggerState.getCheckpoints().length).toBe(checkpointsAtDetach);
    expect(driver.debuggerState.attached).toBeUndefined();
  });

  it("quit detaches and the program runs on", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    const { driver, io } = attachTo(mod, [{ type: "step" }, { type: "quit" }]);

    const result = await mod.main();

    expect(result.data).toBe(3);
    expect(io.renderCalls).toHaveLength(2);
    expect(driver.debuggerState.attached).toBeUndefined();
  });
});
