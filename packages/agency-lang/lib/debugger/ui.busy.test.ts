// The debugger UI while the program runs: the stats bar names what the
// program is waiting on, the command bar names the keys that work, and
// the source pane marks the line. Frame tests
// around a real `DebuggerUI`, fed a wait the runtime really reported.
import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { FrameRecorder, Screen, type KeyEvent } from "@/tui/index.js";
import type { Checkpoint } from "../runtime/state/checkpointStore.js";
import type { DebugStopData } from "../runtime/debugger.js";
import { DebuggerDriver } from "./driver.js";
import { TestInput } from "./testSession.js";
import { TestDebuggerIO, fixtureDir, freshImport, withLLMMocks } from "./testHelpers.js";
import { DebuggerUI } from "./ui.js";
import type { BusyEntry, DebuggerCommand } from "./types.js";

const fixture = "llm-after-step";
const compiled = path.join(fixtureDir, `${fixture}.ts`);

beforeAll(() => {
  compile({}, path.join(fixtureDir, `${fixture}.agency`), compiled, { ts: true });
});

/** A wait the runtime reported for the fixture's model call, and the
 *  stops the driver showed on the way: the second is at the `llm()`
 *  statement. */
async function captured(): Promise<{
  entry: BusyEntry;
  stops: { checkpoint: Checkpoint; stop: DebugStopData }[];
}> {
  return await withLLMMocks([{ return: "hi" }], async () => {
    const mod = await freshImport(compiled);
    const stops: { checkpoint: Checkpoint; stop: DebugStopData }[] = [];
    const io = new (class extends TestDebuggerIO {
      override async render(checkpoint?: Checkpoint, stop?: DebugStopData): Promise<void> {
        await super.render(checkpoint, stop);
        if (checkpoint && stop) stops.push({ checkpoint, stop });
      }
    })([{ type: "step" }, { type: "continue" }] as DebuggerCommand[]);
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
    await mod.main();
    const entry = io.busyCalls.find((entries) => entries.length === 1)![0];
    return { entry: { ...entry, elapsedMs: 0 }, stops };
  });
}

type Screenful = {
  ui: DebuggerUI;
  recorder: FrameRecorder;
  input: TestInput;
  clock: { now: number };
};

function screenful(): Screenful {
  const clock = { now: 1_000_000 };
  const recorder = new FrameRecorder();
  const input = new TestInput();
  const screen = new Screen({ input, output: recorder, width: 120, height: 40 });
  const ui = new DebuggerUI(screen, { now: () => clock.now });
  return { ui, recorder, input, clock };
}

function lastFrame(recorder: FrameRecorder): string {
  return recorder.frames[recorder.frames.length - 1].frame.toPlainText();
}

/** The latest frame once `wanted` is in it, within a second and a half. */
async function untilFrame(recorder: FrameRecorder, wanted: string): Promise<string> {
  for (let i = 0; i < 150; i++) {
    if (recorder.frames.length > 0 && lastFrame(recorder).includes(wanted)) {
      return lastFrame(recorder);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no frame with ${JSON.stringify(wanted)}; last:\n${lastFrame(recorder)}`);
}

describe("the UI while the program is waiting", () => {
  it("names the wait in the bar, with its elapsed time, and marks its line", async () => {
    const { entry } = await captured();
    const { ui, recorder, clock } = screenful();
    try {
      ui.startSpinner();
      ui.setBusy([entry]);

      // The line arrives when the module's source map has loaded.
      const first = await untilFrame(recorder, "llm-after-step.agency:5 · 0ms");
      expect(first).toContain(
        "waiting: in llm() at llm-after-step.agency:5 · 0ms · round 1, waiting on model",
      );
      expect(first).toContain("▶ running · (space)pause (q)quit");
      expect(first).toMatch(/▶\s+5\s+const reply = llm\("say hi"\)/);

      clock.now += 4200;
      const later = await untilFrame(recorder, "· 4s ·");
      expect(later).toContain("llm-after-step.agency:5 · 4s · round 1");
    } finally {
      ui.destroy();
    }
  });

  it("before any stop, shows the wait it attached to with the time it has already run", async () => {
    const { entry } = await captured();
    const { ui, recorder, clock } = screenful();
    try {
      // What the driver does at attach: the spinner first, then the
      // waits the install reports.
      ui.startSpinner();
      ui.setBusy([{ ...entry, elapsedMs: 42_000 }]);

      const first = await untilFrame(recorder, "llm-after-step.agency:5 · 42s");
      expect(first).toContain("waiting: in llm() at llm-after-step.agency:5 · 42s · round 1");
      expect(first).toMatch(/▶\s+5\s+const reply = llm\("say hi"\)/);

      clock.now += 4000;
      await untilFrame(recorder, "· 46s ·");
    } finally {
      ui.destroy();
    }
  });

  it("says how many more waits are open", async () => {
    const { entry } = await captured();
    const { ui, recorder } = screenful();
    try {
      ui.startSpinner();
      ui.setBusy([entry, { ...entry, token: entry.token + 1 }]);

      const frame = await untilFrame(recorder, "+1 more");
      expect(frame).toContain("waiting on model · +1 more");
    } finally {
      ui.destroy();
    }
  });

  it("reads running with nothing open, and the mark goes when the wait closes", async () => {
    const { entry } = await captured();
    const { ui, recorder } = screenful();
    try {
      ui.startSpinner();
      const idle = await untilFrame(recorder, "▶ running");
      expect(idle).not.toContain("in llm()");

      ui.setBusy([entry]);
      await untilFrame(recorder, "waiting on model");
      ui.setBusy([]);
      const after = await untilFrame(recorder, "▶ running");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(lastFrame(recorder)).not.toContain("in llm()");
      expect(after).not.toMatch(/▶\s+5\s+const reply/);
    } finally {
      ui.destroy();
    }
  });

  it("at a stop, the stop's highlight wins and the stats bar names the wait", async () => {
    const { entry, stops } = await captured();
    const atLlm = stops[1];
    const { ui, recorder } = screenful();
    try {
      await ui.render(atLlm.checkpoint, atLlm.stop);
      ui.setBusy([entry]);

      const frame = await untilFrame(recorder, "waiting: in llm()");
      expect(frame).toMatch(/>\s+5\s+const reply = llm\("say hi"\)/);
      expect(frame).not.toMatch(/▶\s+5\s+const reply/);
      expect(frame).toContain("waiting: in llm() at llm-after-step.agency:5");
    } finally {
      ui.destroy();
    }
  });
});

describe("the pause key", () => {
  it("space while the program runs reaches the listener, and the bar says so", async () => {
    const { ui, recorder, input } = screenful();
    let paused = 0;
    ui.onPause(() => paused++);
    try {
      ui.startSpinner();
      await untilFrame(recorder, "▶ running");
      input.feedKey({ key: " " });

      const frame = await untilFrame(recorder, "pausing at the next statement");
      expect(frame).toContain("▶ pausing at the next statement");
      expect(paused).toBe(1);
    } finally {
      ui.destroy();
    }
  });

  it("q while the program runs quits at once, and the bar says so", async () => {
    const { ui, recorder, input } = screenful();
    let paused = 0;
    let quit = 0;
    ui.onPause(() => paused++);
    ui.onQuit(() => quit++);
    try {
      ui.startSpinner();
      const frame = await untilFrame(recorder, "▶ running");
      expect(frame).toContain("▶ running · (space)pause (q)quit");
      input.feedKey({ key: "q" });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(quit).toBe(1);
      expect(paused).toBe(0);
    } finally {
      ui.destroy();
    }
  });

  it("at 80 columns, attached, the wait has a row of its own and is not clipped", async () => {
    const { entry } = await captured();
    const clock = { now: 1_000_000 };
    const recorder = new FrameRecorder();
    const screen = new Screen({ input: new TestInput(), output: recorder, width: 80, height: 40 });
    const ui = new DebuggerUI(screen, { now: () => clock.now });
    ui.attachedTo({ type: "hello", pid: 12345, program: "research-agent.js", node: "main" });
    try {
      ui.startSpinner();
      ui.setBusy([entry]);

      const frame = await untilFrame(recorder, "llm-after-step.agency:5 · 0ms");
      const lines = frame.split("\n");
      const figures = lines.find((line) => line.includes("tokens:"))!;
      expect(figures).toContain("attached to 12345 research-agent.js");
      expect(figures).not.toContain("waiting:");
      expect(lines).toContain(
        "  waiting: in llm() at llm-after-step.agency:5 · 0ms · round 1, waiting on model".padEnd(
          80,
        ),
      );
      expect(frame).toContain("▶ running · (space)pause (q)detach");
    } finally {
      ui.destroy();
    }
  });

  it("attached, the bar says q detaches, and the pausing bar keeps it", async () => {
    const { ui, recorder, input } = screenful();
    ui.attachedTo({ type: "hello", pid: 1234, program: "agent.js", node: "main" });
    try {
      ui.startSpinner();
      const running = await untilFrame(recorder, "▶ running");
      expect(running).toContain("▶ running · (space)pause (q)detach");
      input.feedKey({ key: "s" });
      const pausing = await untilFrame(recorder, "pausing at the next statement");
      expect(pausing).toContain("▶ pausing at the next statement · (q)detach");
      expect(pausing).not.toContain("(space)pause");
    } finally {
      ui.destroy();
    }
  });

  it("c while the program runs is kept for the stop", async () => {
    const { ui, recorder, input } = screenful();
    try {
      ui.startSpinner();
      await untilFrame(recorder, "▶ running");
      input.feedKey({ key: "c" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      ui.stopSpinner();

      expect(await ui.waitForCommand()).toEqual({ type: "continue" });
    } finally {
      ui.destroy();
    }
  });

  it("a read the input cancels is armed again on the next tick", async () => {
    // What `TerminalInput.nextKey` does when `nextLine` takes the
    // terminal: the pending read rejects.
    const input = new (class extends TestInput {
      private cancelled = false;
      override nextKey(): Promise<KeyEvent> {
        if (!this.cancelled) {
          this.cancelled = true;
          return Promise.reject(new Error("nextKey() cancelled by nextLine()"));
        }
        return super.nextKey();
      }
    })();
    const recorder = new FrameRecorder();
    const screen = new Screen({ input, output: recorder, width: 120, height: 40 });
    const ui = new DebuggerUI(screen);
    let paused = 0;
    ui.onPause(() => paused++);
    try {
      ui.startSpinner();
      await untilFrame(recorder, "▶ running");
      await new Promise((resolve) => setTimeout(resolve, 100));
      input.feedKey({ key: "s" });

      await untilFrame(recorder, "pausing at the next statement");
      expect(paused).toBe(1);
    } finally {
      ui.destroy();
    }
  });

  it("s while the program runs is a pause too", async () => {
    const { ui, recorder, input } = screenful();
    let paused = 0;
    ui.onPause(() => paused++);
    try {
      ui.startSpinner();
      await untilFrame(recorder, "▶ running");
      input.feedKey({ key: "s" });
      await untilFrame(recorder, "pausing at the next statement");
      expect(paused).toBe(1);
    } finally {
      ui.destroy();
    }
  });

  it("s at a stop is a step, not a pause", async () => {
    const { ui, input } = screenful();
    let paused = 0;
    ui.onPause(() => paused++);
    try {
      const pending = ui.waitForCommand();
      input.feedKey({ key: "s" });

      expect(await pending).toEqual({ type: "step" });
      expect(paused).toBe(0);
    } finally {
      ui.destroy();
    }
  });
});

describe("the UI between attaching and the first stop", () => {
  it("says it is connected and waiting, with the time so far, until the run reports a stop or a wait", async () => {
    const { entry } = await captured();
    const { ui, recorder, clock } = screenful();
    try {
      ui.attachedTo({ type: "hello", pid: 12345, program: "research-agent.js", node: "main" });
      const first = await untilFrame(recorder, "Connected to pid 12345 research-agent.js");
      expect(first).toContain("waiting for the program to reach its next statement");
      expect(first).toContain("0ms");
      expect(first).not.toContain("source file not found");
      expect(first).not.toContain("unknown module");

      clock.now += 3_000;
      const later = await untilFrame(recorder, "statement\u2026 3s");
      expect(later).toContain("waiting for the program to reach its next statement");

      ui.setBusy([entry]);
      const busy = await untilFrame(recorder, "llm-after-step.agency:5");
      expect(busy).not.toContain("waiting for the program to reach its next statement");

      // The wait closes before any stop: the connecting screen comes
      // back and its figure keeps counting.
      ui.setBusy([]);
      clock.now += 2_000;
      const back = await untilFrame(recorder, "statement\u2026 5s");
      expect(back).toContain("Connected to pid 12345 research-agent.js");
    } finally {
      ui.destroy();
    }
  });
});
