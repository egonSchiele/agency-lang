// A debugger installed on a program that a TypeScript caller is running.
// Every test calls the compiled node function the way a TypeScript program
// would and checks that the caller never sees a debug stop: it gets the
// program's own interrupts and the final value, while the attached driver
// answers the stops in between. See
// docs/superpowers/specs/2026-10-20-attach-to-a-running-program.md.
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { DebuggerDriver } from "./driver.js";
import { TestDebuggerIO, fixtureDir, freshImport, withLLMMocks } from "./testHelpers.js";
import type { DebuggerCommand } from "./types.js";
import { hasInterrupts, isDebugger } from "@/runtime/interrupts.js";
import { statementStepPath } from "@/runtime/promptRunner.js";
import { isPaused } from "@/runtime/pause.js";
import { debugRunOfStack } from "@/runtime/debugRun.js";
import type { Checkpoint } from "@/runtime/state/checkpointStore.js";
import type { DebugStopData } from "@/runtime/debugger.js";
import * as helper from "../../tests/debugger/waiter.js";
import type { BusyEntry } from "./types.js";

const fixtures = {
  stepTest: "step-test",
  awaitsHelper: "awaits-helper",
  topLevelInterrupt: "top-level-interrupt",
  policyEffect: "policy-effect",
  mixedBatch: "mixed-batch",
  llmAfterStep: "llm-after-step",
  agentShaped: "agent-shaped",
  echo: "echo",
  nestedRun: "nested-run",
  agentEndCallback: "agent-end-callback",
  pauses: "pauses",
  ask: "ask",
  waitingTool: "waiting-tool",
};

/** An IO that never answers: the program stays at its stop until the
 *  test does something else, such as detach or cancel. */
class SilentIO extends TestDebuggerIO {
  override async waitForCommand(): Promise<DebuggerCommand> {
    return await new Promise(() => {});
  }
}

/** An IO with one script per run, told apart by the run id of the
 *  checkpoint last rendered; the scripts go to the runs in the order
 *  their first stop is shown. */
class PerRunIO extends TestDebuggerIO {
  private runs: string[] = [];
  private shownRun = "";
  constructor(private readonly scripts: DebuggerCommand[][]) {
    super([]);
  }
  override async render(checkpoint?: Checkpoint, stop?: DebugStopData): Promise<void> {
    await super.render(checkpoint, stop);
    const runId = checkpoint?.traceId;
    if (runId !== undefined) {
      this.shownRun = runId;
      if (!this.runs.includes(runId)) {
        this.runs.push(runId);
      }
    }
  }
  override async waitForCommand(): Promise<DebuggerCommand> {
    const script = this.scripts[this.runs.indexOf(this.shownRun)] ?? [];
    return script.shift() ?? { type: "quit" };
  }
}

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
      respondToInterruptsForServe: mod.__respondToInterruptsForServe,
      rewindFrom: mod.rewindFrom,
      __setDebugger: mod.__setDebugger,
      __getDebugger: mod.__getDebugger,
      __getCheckpoints: mod.__getCheckpoints,
    },
    rewindSize: 30,
    ui: io,
    attached: true,
  });
  driver.attach();
  return { driver, io };
}

/** Resolves once `io` has rendered `count` checkpoints. */
async function untilRendered(io: TestDebuggerIO, count: number): Promise<void> {
  for (let i = 0; i < 200 && io.renderCalls.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(io.renderCalls.length).toBeGreaterThanOrEqual(count);
}

/** `promise`, or a failure when it has not settled within `ms`. */
function withinMs<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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

  it("one run at a time is debugged; another that starts meanwhile runs without stopping", async () => {
    // Both runs pass the same statements. The first to stop owns the
    // debugger; the second never stops, so a step back cannot reach it,
    // and its caller gets its own value under its own options.
    const mod = await freshImport(compiledPath(fixtures.echo));
    const io = new PerRunIO([
      [{ type: "step" }, { type: "stepBack", preserveOverrides: false }, { type: "continue" }],
      [{ type: "continue" }],
    ]);
    attachTo(mod, [], io);

    const [alice, bob] = await Promise.all([mod.main("alice"), mod.main("bob")]);

    expect(alice.data).toBe("alice");
    expect(bob.data).toBe("bob");
    expect(io.logLines.filter((line) => line.startsWith("Rewinding"))).toHaveLength(1);
    // Every stop shown was alice's: a rewind starts a new trace, so the
    // run is told by the node's argument, not the trace id.
    const shown = io.renderCalls.map((cp) => cp.getCurrentFrame()?.args?.who);
    expect(shown.length).toBeGreaterThanOrEqual(3);
    expect(shown.every((who) => who === "alice")).toBe(true);
    expect(io.logLines).toContainEqual(
      "Another run started while this one is debugged; it runs without stopping",
    );
  });

  it("two runs that share a trace id are still told apart", async () => {
    const mod = await freshImport(compiledPath(fixtures.echo));
    const io = new PerRunIO([
      [{ type: "step" }, { type: "stepBack", preserveOverrides: false }, { type: "continue" }],
      [{ type: "continue" }],
    ]);
    attachTo(mod, [], io);

    const [alice, bob] = await Promise.all([
      mod.main("alice", { traceId: "shared" }),
      mod.main("bob", { traceId: "shared" }),
    ]);

    expect(alice.data).toBe("alice");
    expect(bob.data).toBe("bob");
  });

  it("the next run starts with an empty rewind window", async () => {
    const mod = await freshImport(compiledPath(fixtures.echo));
    const { io, driver } = attachTo(mod, [
      { type: "step" },
      { type: "step" },
      { type: "continue" },
      { type: "stepBack", preserveOverrides: false },
      { type: "continue" },
    ]);

    expect((await mod.main("alice")).data).toBe("alice");
    driver.debuggerState.stepping();
    expect((await mod.main("bob")).data).toBe("bob");

    expect(io.logLines).toContainEqual("Already at earliest checkpoint");
    expect(io.logLines.some((line) => line.startsWith("Rewinding"))).toBe(false);
  });

  it("a run that hands its own interrupt to its caller lets the next run be debugged", async () => {
    const mod = await freshImport(compiledPath(fixtures.pauses));
    const { io, driver } = attachTo(mod, [
      { type: "continue" },
      { type: "step" },
      { type: "continue" },
    ]);

    const paused = await mod.main();
    expect(hasInterrupts(paused.data)).toBe(true);
    driver.debuggerState.stepping();
    const rendersBefore = io.renderCalls.length;
    const other = await mod.other();

    expect(other.data).toBe(1);
    expect(io.renderCalls.length).toBeGreaterThan(rendersBefore);
    // The caller's answer resumes the first run as a run of its own again.
    const final = await mod.respondToInterrupts(paused.data, [{ type: "approve" }]);
    expect(final.data).toBe(1);
  });

  it("a run paused by its caller's signal lets the next run be debugged", async () => {
    const mod = await freshImport(compiledPath(fixtures.awaitsHelper));
    const { io, driver } = attachTo(mod, [
      { type: "continue" },
      { type: "step" },
      { type: "continue" },
    ]);
    const pause = new AbortController();
    const first = mod.main({ pauseSignal: pause.signal });
    await helper.untilWaiting();
    pause.abort();
    helper.releaseWaiter();
    expect(isPaused((await first).data)).toBe(true);

    driver.debuggerState.stepping();
    const rendersBefore = io.renderCalls.length;
    const second = mod.main();
    await helper.untilWaiting();
    helper.releaseWaiter();

    expect((await second).data).toBe(2);
    expect(io.renderCalls.length).toBeGreaterThan(rendersBefore);
  });

  it("two resumes of one checkpoint are two runs, and each caller gets its own answer", async () => {
    const mod = await freshImport(compiledPath(fixtures.ask));
    const io = new PerRunIO([[{ type: "step" }, { type: "continue" }], [{ type: "continue" }]]);
    attachTo(mod, [], io);
    const asked = await mod.main();
    expect(hasInterrupts(asked.data)).toBe(true);
    const clone = () => JSON.parse(JSON.stringify(asked.data));

    const [alice, bob] = await Promise.all([
      mod.respondToInterrupts(clone(), [{ type: "approve", value: "alice" }]),
      mod.respondToInterrupts(clone(), [{ type: "approve", value: "bob" }]),
    ]);

    expect(alice.data).toBe("alice");
    expect(bob.data).toBe("bob");
    // The first resume to stop was debugged and the other ran through.
    expect(io.renderCalls.length).toBeGreaterThanOrEqual(1);
    expect(io.logLines).toContainEqual(
      "Another run started while this one is debugged; it runs without stopping",
    );
    const shown = io.renderCalls
      .map((cp) => cp.getCurrentFrame()?.locals?.who)
      .filter((who) => who !== undefined);
    expect(shown.every((who) => who === shown[0])).toBe(true);
  });

  it("the end of a run the debugger ignored is not reported", async () => {
    const mod = await freshImport(compiledPath(fixtures.echo));
    const io = new SilentIO([]);
    const { driver } = attachTo(mod, [], io);
    const stopped = mod.main("alice");
    await untilRendered(io, 1);

    expect((await mod.main("bob")).data).toBe("bob");

    expect(io.logLines.some((line) => line.includes('"bob"'))).toBe(false);
    driver.detach();
    expect((await stopped).data).toBe("alice");
  });

  it("a checkpoint an earlier run saved is loaded, and the run goes on from it", async () => {
    const mod = await freshImport(compiledPath(fixtures.echo));
    const file = path.join(os.tmpdir(), `agency-attached-${process.pid}-${Date.now()}.json`);
    const { io, driver } = attachTo(mod, [
      { type: "step" },
      { type: "save", path: file },
      { type: "continue" },
      { type: "load", path: file },
      { type: "continue" },
    ]);
    try {
      expect((await mod.main("alice")).data).toBe("alice");
      driver.debuggerState.stepping();
      // The second run is rewound to the first run's saved state, so it
      // returns the first run's argument, and is let go of when it ends.
      expect((await mod.main("bob")).data).toBe("alice");
      expect(io.logLines.some((line) => line.startsWith("Rewinding"))).toBe(true);
      expect(driver.debuggerState.ownedRun).toBeNull();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("after the caller answers the program's interrupt, a step back reaches before it", async () => {
    const mod = await freshImport(compiledPath(fixtures.pauses));
    // The window's checkpoint the step back lands on, and the key it
    // carries: the first run's, which the rewind must leave as it is.
    let target: Checkpoint | undefined;
    let targetRun: string | undefined;
    const io = new (class extends TestDebuggerIO {
      override async waitForCommand(): Promise<DebuggerCommand> {
        const command = await super.waitForCommand();
        if (command.type === "stepBack") {
          // The window holds the first run's checkpoint and the resumed
          // run's own, from this stop; the step back goes to the first.
          target = driver.debuggerState.getCheckpoints()[0];
          targetRun = debugRunOfStack(target?.stack);
        }
        return command;
      }
    })([
      { type: "step" },
      { type: "continue" },
      { type: "stepBack", preserveOverrides: false },
      { type: "continue" },
      { type: "continue" },
    ]);
    const { driver } = attachTo(mod, [], io);

    const asked = await mod.main();
    expect(hasInterrupts(asked.data)).toBe(true);
    driver.debuggerState.stepping();
    // The step back from the resumed run's first stop replays the
    // interrupt statement, so the caller is asked again.
    const askedAgain = await mod.respondToInterrupts(asked.data, [{ type: "approve" }]);

    expect(hasInterrupts(askedAgain.data)).toBe(true);
    // The rewind went to a copy stamped with the resumed run's key; the
    // checkpoint itself still carries the key of the run that recorded it.
    expect(targetRun).toBeDefined();
    expect(targetRun).not.toBe(debugRunOfStack(askedAgain.data[0].checkpoint?.stack));
    expect(debugRunOfStack(target?.stack)).toBe(targetRun);
    expect(io.logLines.some((line) => line.startsWith("Rewinding"))).toBe(true);
    expect(io.logLines).not.toContainEqual("Already at earliest checkpoint");
    driver.debuggerState.stepping();
    const final = await mod.respondToInterrupts(askedAgain.data, [{ type: "approve" }]);
    expect(final.data).toBe(1);
  });

  it("a rewind whose restore throws lets the next run be debugged", async () => {
    const mod = await freshImport(compiledPath(fixtures.echo));
    const io = new (class extends TestDebuggerIO {
      override async waitForCommand(): Promise<DebuggerCommand> {
        const command = await super.waitForCommand();
        if (command.type === "stepBack") {
          // As the restore sees a program whose code changed since the
          // checkpoint was recorded.
          for (const checkpoint of driver.debuggerState.getCheckpoints()) {
            checkpoint.moduleFingerprints = { changed: { hash: "0", source: "" } as never };
          }
        }
        return command;
      }
    })([{ type: "step" }, { type: "stepBack", preserveOverrides: false }, { type: "continue" }]);
    const { driver } = attachTo(mod, [], io);

    await expect(mod.main("alice")).rejects.toThrow(/changed/i);

    expect(driver.debuggerState.ownedRun).toBeNull();
    driver.debuggerState.stepping();
    const rendersBefore = io.renderCalls.length;
    expect((await mod.main("bob")).data).toBe("bob");
    expect(io.renderCalls.length).toBeGreaterThan(rendersBefore);
  });

  it("a load that fails keeps the run, and another run meanwhile runs through", async () => {
    const mod = await freshImport(compiledPath(fixtures.echo));
    const file = path.join(os.tmpdir(), `agency-attached-${process.pid}-${Date.now()}.json`);
    let keyAtStop: string | null = null;
    let otherRan = false;
    const io = new (class extends TestDebuggerIO {
      override async waitForCommand(): Promise<DebuggerCommand> {
        const command = await super.waitForCommand();
        if (command.type === "load") {
          // A file whose checkpoint the restore refuses: its code changed.
          const saved = driver.debuggerState.getCheckpoints()[0].toJSON() as {
            moduleFingerprints?: unknown;
          };
          saved.moduleFingerprints = { changed: { hash: "0", source: "" } };
          fs.writeFileSync(file, JSON.stringify(saved));
          keyAtStop = driver.debuggerState.ownedRun;
        }
        if (command.type === "continue" && !otherRan) {
          // The failed load went back to the stop, which still owns the
          // debugger, so a run that starts now is not debugged.
          otherRan = true;
          expect(driver.debuggerState.ownedRun).toBe(keyAtStop);
          const rendersBefore = this.renderCalls.length;
          expect((await mod.main("carol")).data).toBe("carol");
          expect(this.renderCalls.length).toBe(rendersBefore);
          expect(driver.debuggerState.ownedRun).toBe(keyAtStop);
        }
        return command;
      }
    })([{ type: "step" }, { type: "load", path: file }, { type: "continue" }]);
    const { driver } = attachTo(mod, [], io);

    try {
      expect((await mod.main("alice")).data).toBe("alice");
      expect(keyAtStop).not.toBeNull();
      expect(otherRan).toBe(true);
      expect(io.logLines.some((line) => line.startsWith("Failed to load"))).toBe(true);
      expect(driver.debuggerState.ownedRun).toBeNull();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("a debugger UI that throws at a stop lets the next run be debugged", async () => {
    const mod = await freshImport(compiledPath(fixtures.echo));
    const io = new (class extends TestDebuggerIO {
      private asked = 0;
      override async waitForCommand(): Promise<DebuggerCommand> {
        this.asked += 1;
        if (this.asked === 1) {
          throw new Error("the prompt could not be drawn");
        }
        return await super.waitForCommand();
      }
    })([{ type: "continue" }]);
    const { driver } = attachTo(mod, [], io);

    await expect(mod.main("alice")).rejects.toThrow("the prompt could not be drawn");

    expect(driver.debuggerState.ownedRun).toBeNull();
    driver.debuggerState.stepping();
    const rendersBefore = io.renderCalls.length;
    expect((await mod.main("bob")).data).toBe("bob");
    expect(io.renderCalls.length).toBeGreaterThan(rendersBefore);
  });

  it("when the debugged run ends, the next run to stop is debugged", async () => {
    const mod = await freshImport(compiledPath(fixtures.echo));
    const { io, driver } = attachTo(mod, [
      { type: "step" },
      { type: "continue" },
      { type: "continue" },
    ]);

    expect((await mod.main("alice")).data).toBe("alice");
    const shownForAlice = io.renderCalls.length;
    // The mode is the debugger's, not a run's: alice's `continue` left it
    // running, and stepping is what a pause key will restore.
    driver.debuggerState.stepping();
    expect((await mod.main("bob")).data).toBe("bob");

    expect(shownForAlice).toBeGreaterThanOrEqual(2);
    expect(io.renderCalls.length).toBeGreaterThan(shownForAlice);
  });

  it("a run that calls another node of the same module from its own code does not deadlock", async () => {
    const mod = await freshImport(compiledPath(fixtures.nestedRun));
    helper.setInnerModule(mod);
    attachTo(mod, [{ type: "step" }, { type: "step" }, { type: "continue" }]);

    const result = await mod.outer();

    expect(result.data).toBe(5);
  });

  it("a run that starts while another sits at an unanswered stop runs through", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    const io = new SilentIO([]);
    const { driver } = attachTo(mod, [], io);
    const stopped = mod.main();
    await untilRendered(io, 1);

    const finished = await withinMs<any>(mod.main(), 2000);

    expect(finished.data).toBe(3);
    expect(io.renderCalls).toHaveLength(1);
    driver.detach();
    expect((await stopped).data).toBe(3);
  });

  it("the caller can cancel a run that waits at a stop", async () => {
    const mod = await freshImport(compiledPath(fixtures.stepTest));
    const io = new SilentIO([]);
    attachTo(mod, [], io);
    const cancel = new AbortController();
    const running = mod.main({ abortSignal: cancel.signal });
    await untilRendered(io, 1);

    cancel.abort();

    // The cancelled leg throws; the driver hands the thrown outcome back
    // (`AttachedLegThrew`) and the public entry point throws it.
    await expect(withinMs(running, 2000)).rejects.toThrow(/cancel/i);

    // The thrown run let go of the debugger: the next run stops.
    const { io: next } = attachTo(mod, [{ type: "continue" }]);
    expect((await mod.main()).data).toBe(3);
    expect(next.renderCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("the program's own onAgentEnd callback fires, and a throwing caller's callback is logged", async () => {
    const mod = await freshImport(compiledPath(fixtures.agentEndCallback));
    helper.clearAgentEndNotes();
    attachTo(mod, [{ type: "step" }, { type: "continue" }]);

    const result = await mod.main({
      callbacks: {
        onAgentEnd: () => {
          helper.noteAgentEnd("ts");
          throw new Error("the callback failed");
        },
      },
    });

    expect(result.data).toBe(2);
    expect(helper.agentEndNotes().sort()).toEqual(["agency", "ts"]);
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
    attachTo(mod, [
      { type: "step" },
      { type: "step" },
      { type: "stepBack", preserveOverrides: false },
      { type: "continue" },
    ]);

    const result = await mod.main();

    expectNoStop(result);
    expect(result.data).toBe(3);
    expect(result.usage).toBeDefined();
    expect(result.usage.tokens.totalTokens).toBe(0);

    // The run ended in a rewound leg, which let go of the debugger too.
    const { io: next } = attachTo(mod, [{ type: "continue" }]);
    expect((await mod.main()).data).toBe(3);
    expect(next.renderCalls.length).toBeGreaterThanOrEqual(1);
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

describe("what the program is waiting on", () => {
  /** The kinds in each list the IO was handed, in order. */
  function kinds(io: TestDebuggerIO): string[][] {
    return io.busyCalls.map((entries) => entries.map((entry) => entry.kind));
  }

  it("a model request is reported while it runs, under continue", async () => {
    await withLLMMocks([{ return: "hi" }], async () => {
      const mod = await freshImport(compiledPath(fixtures.llmAfterStep));
      const { io } = attachTo(mod, [{ type: "continue" }]);

      expect((await mod.main()).data).toBe("hi");

      expect(kinds(io)).toEqual([["model"], []]);
      const entry: BusyEntry = io.busyCalls[0][0];
      expect(entry.label).toBe("round 1");
      expect(entry.location.moduleId).toContain("llm-after-step");
      expect(entry.location.scopeName).toBe("main");
      expect(entry.location.stepPath).toMatch(/^\d+\/initialLlmCall$/);
      expect(entry.location.branchPath).toEqual([]);
      expect(entry.debugRun).not.toBe("");
      expect(entry.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(typeof entry.token).toBe("number");
    });
  });

  it("a model request is reported while next runs over its statement", async () => {
    await withLLMMocks([{ return: "hi" }], async () => {
      const mod = await freshImport(compiledPath(fixtures.llmAfterStep));
      const { io } = attachTo(mod, [{ type: "step" }, { type: "next" }, { type: "continue" }]);

      expect((await mod.main()).data).toBe("hi");

      expect(kinds(io)).toContainEqual(["model"]);
    });
  });

  it("a tool call is reported in its own wait, under the llm() statement", async () => {
    const mocks = [{ toolCall: { name: "writeUp", args: { notes: "n" } } }, { return: "final" }];
    await withLLMMocks(mocks, async () => {
      const mod = await freshImport(compiledPath(fixtures.agentShaped));
      const { io } = attachTo(mod, [{ type: "continue" }]);

      expect((await mod.main("task")).data).toBe("final");

      // The request closes before the tool round opens, and the next
      // request opens after it.
      expect(kinds(io)).toEqual([["model"], [], ["tool"], [], ["model"], []]);
      const tool = io.busyCalls[2][0];
      expect(tool.label).toBe('writeUp(notes: "n")');
      expect(tool.location.stepPath).toMatch(/\/round\.0\.tool\..*\.invoke$/);
      expect(tool.location.branchPath).toHaveLength(1);
      // The same statement as the request before it.
      expect(statementStepPath(tool.location.stepPath)).toBe(
        statementStepPath(io.busyCalls[0][0].location.stepPath),
      );
    });
  });

  it("a model request inside a tool is reported with the tool, on its branch", async () => {
    const mocks = [
      { toolCall: { name: "search", args: { query: "cats", breakHere: false } } },
      { return: "a summary" },
      { return: "final" },
    ];
    await withLLMMocks(mocks, async () => {
      const mod = await freshImport(compiledPath(fixtures.agentShaped));
      const { io } = attachTo(mod, [{ type: "continue" }]);

      expect((await mod.main("task")).data).toBe("final");

      const nested = io.busyCalls.find((entries) => entries.length === 2);
      expect(nested).toBeDefined();
      expect(nested!.map((entry) => entry.kind)).toEqual(["tool", "model"]);
      expect(nested![1].location.branchPath).toEqual(nested![0].location.branchPath);
      expect(nested![1].location.depth).toBeGreaterThan(nested![0].location.depth);
    });
  });

  it("a tool resumed after the caller answers its interrupt is reported again", async () => {
    await withLLMMocks(
      [{ toolCall: { name: "confirm", args: { note: "x" } } }, { return: "done" }],
      async () => {
        const mod = await freshImport(compiledPath(fixtures.agentShaped));
        const { io } = attachTo(mod, [{ type: "continue" }, { type: "continue" }]);

        const paused = await mod.main("task");
        expect(hasInterrupts(paused.data)).toBe(true);
        // The wait closed when the tool bailed out with its interrupt.
        expect(io.busyCalls.at(-1)).toEqual([]);
        const toolListsBefore = kinds(io).filter((list) => list[0] === "tool").length;
        expect(toolListsBefore).toBe(1);

        const final = await mod.respondToInterrupts(paused.data, [{ type: "approve" }]);

        expect(final.data).toBe("done");
        expect(kinds(io).filter((list) => list[0] === "tool").length).toBe(2);
      },
    );
  });

  it("a tool whose body throws closes its wait", async () => {
    await withLLMMocks(
      [{ toolCall: { name: "failing", args: {} } }, { return: "after" }],
      async () => {
        const mod = await freshImport(compiledPath(fixtures.waitingTool));
        const { io } = attachTo(mod, [{ type: "continue" }]);

        expect((await mod.main()).data).toBe("after");

        expect(kinds(io)).toContainEqual(["tool"]);
        expect(io.busyCalls.at(-1)).toEqual([]);
      },
    );
  });

  it("at a stop inside a tool call, nothing is waiting", async () => {
    const mocks = [
      { toolCall: { name: "search", args: { query: "cats", breakHere: true } } },
      { return: "a summary" },
      { return: "final" },
    ];
    await withLLMMocks(mocks, async () => {
      const mod = await freshImport(compiledPath(fixtures.agentShaped));
      let atToolStop: BusyEntry[] | undefined;
      const io = new (class extends TestDebuggerIO {
        override async render(checkpoint?: Checkpoint, stop?: DebugStopData): Promise<void> {
          await super.render(checkpoint, stop);
          if (stop !== undefined && stop.branchPath.length > 0) {
            atToolStop = this.busyCalls.at(-1) ?? [];
          }
        }
      })([{ type: "continue" }, { type: "continue" }]);
      attachTo(mod, [], io);

      expect((await mod.main("task")).data).toBe("final");

      expect(atToolStop).toEqual([]);
    });
  });

  it("a debugger installed while a tool runs is told of the wait at once", async () => {
    await withLLMMocks(
      [{ toolCall: { name: "holdOn", args: { note: "x" } } }, { return: "done" }],
      async () => {
        const mod = await freshImport(compiledPath(fixtures.waitingTool));
        const running = mod.main();
        await helper.untilWaiting();
        await new Promise((resolve) => setTimeout(resolve, 20));

        const { io } = attachTo(mod, [{ type: "continue" }]);

        expect(io.busyCalls).toHaveLength(1);
        const [entry] = io.busyCalls[0];
        expect(entry.kind).toBe("tool");
        expect(entry.label).toBe('holdOn(note: "x")');
        expect(entry.elapsedMs).toBeGreaterThanOrEqual(20);
        helper.releaseWaiter();
        expect((await running).data).toBe("done");
        expect(io.busyCalls.at(-1)).toEqual([]);
      },
    );
  });

  it("a debugger that detaches during a tool call and attaches again is told of the wait", async () => {
    await withLLMMocks(
      [{ toolCall: { name: "holdOn", args: { note: "x" } } }, { return: "done" }],
      async () => {
        const mod = await freshImport(compiledPath(fixtures.waitingTool));
        const running = mod.main();
        await helper.untilWaiting();
        const { driver, io } = attachTo(mod, [{ type: "continue" }]);
        expect(io.busyCalls).toHaveLength(1);

        driver.detach();
        driver.attach();

        // The same wait, still open, is news to the new session.
        expect(io.busyCalls).toHaveLength(2);
        expect(io.busyCalls[1].map((entry) => entry.label)).toEqual(['holdOn(note: "x")']);
        helper.releaseWaiter();
        expect((await running).data).toBe("done");
        expect(io.busyCalls.at(-1)).toEqual([]);
      },
    );
  });

  it("another run's waits are not reported while a run is debugged", async () => {
    await withLLMMocks([{ return: "one" }, { return: "two" }], async () => {
      const mod = await freshImport(compiledPath(fixtures.llmAfterStep));
      let release: (() => void) | undefined;
      const io = new (class extends TestDebuggerIO {
        private asked = 0;
        override async waitForCommand(): Promise<DebuggerCommand> {
          this.asked += 1;
          if (this.asked === 1) {
            // Held at the first stop while the other run goes through.
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return await super.waitForCommand();
        }
      })([{ type: "continue" }]);
      attachTo(mod, [], io);

      const debugged = mod.main();
      await untilRendered(io, 1);
      const callsAtStop = io.busyCalls.length;
      expect((await mod.main()).data).toBe("one");
      // The other run's model call was reported as nothing to show.
      for (const list of io.busyCalls.slice(callsAtStop)) {
        expect(list).toEqual([]);
      }
      release!();
      expect((await debugged).data).toBe("two");
      expect(kinds(io).slice(callsAtStop)).toContainEqual(["model"]);
    });
  });
});
