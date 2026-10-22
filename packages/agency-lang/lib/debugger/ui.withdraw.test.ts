// The terminal UI when another party answers first: the read it is
// inside rejects with `RequestWithdrawn`, whether that is the command
// loop or an open picker, and the next read takes the next key. And the
// stats line says when an agent is on the run too.
import { describe, it, expect } from "vitest";
import { FrameRecorder, Screen } from "@/tui/index.js";
import { TestInput } from "./testSession.js";
import { DebuggerUI } from "./ui.js";
import { RequestWithdrawn } from "./types.js";

function screenful(): { ui: DebuggerUI; recorder: FrameRecorder; input: TestInput } {
  const recorder = new FrameRecorder();
  const input = new TestInput();
  const screen = new Screen({ input, output: recorder, width: 120, height: 40 });
  const ui = new DebuggerUI(screen);
  return { ui, recorder, input };
}

function lastFrame(recorder: FrameRecorder): string {
  return recorder.frames[recorder.frames.length - 1].frame.toPlainText();
}

describe("a withdrawn read", () => {
  it("rejects waitForCommand, and the next waitForCommand takes the next key", async () => {
    const { ui, input } = screenful();
    try {
      const reading = ui.waitForPerson();
      const first = ui.waitForCommand();
      await reading;
      ui.withdraw();
      await expect(first).rejects.toBeInstanceOf(RequestWithdrawn);

      const second = ui.waitForCommand();
      input.feedKey({ key: "s" });
      expect(await second).toEqual({ type: "step" });
    } finally {
      ui.destroy();
    }
  });

  it("closes an open prompt", async () => {
    const { ui, recorder } = screenful();
    try {
      const reading = ui.waitForPerson();
      const asking = ui.promptForInput("value for x:");
      await reading;
      expect(lastFrame(recorder)).toContain("value for x:");
      ui.withdraw();
      await expect(asking).rejects.toBeInstanceOf(RequestWithdrawn);
      expect(lastFrame(recorder)).not.toContain("value for x:");
    } finally {
      ui.destroy();
    }
  });

  it("does nothing when no read is in progress", () => {
    const { ui } = screenful();
    try {
      expect(() => ui.withdraw()).not.toThrow();
    } finally {
      ui.destroy();
    }
  });
});

describe("the parties line", () => {
  it("says when an agent is on the run too, and stops when it leaves", async () => {
    const { ui, recorder } = screenful();
    ui.attachedTo({ type: "hello", pid: 4242, program: "research.js", node: "main" });
    try {
      ui.setParties({ terminal: true, cli: true });
      expect(lastFrame(recorder)).toContain(
        "attached to 4242 research.js | with agency debug session",
      );
      ui.setParties({ terminal: true, cli: false });
      expect(lastFrame(recorder)).not.toContain("with agency debug session");
    } finally {
      ui.destroy();
    }
  });
});
