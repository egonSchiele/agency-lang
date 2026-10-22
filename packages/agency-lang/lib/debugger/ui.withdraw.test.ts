// The terminal UI when another party answers first: the read it is
// inside rejects with `RequestWithdrawn`, whether that is the command
// loop or an open picker, and the next read takes the next key. And the
// stats line says when an agent is on the run too.
import { describe, it, expect } from "vitest";
import { FrameRecorder, Screen } from "@/tui/index.js";
import { TestInput } from "./testSession.js";
import { DebuggerUI } from "./ui.js";
import { RequestWithdrawn } from "./types.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";

/** The smallest checkpoint the rewind picker will show. */
function checkpoint(id: number): Checkpoint {
  return new Checkpoint({
    id,
    stack: {
      stack: [{ args: {}, locals: { x: id }, threads: null, step: 1, scopeName: "main" }],
      mode: "serialize",
      other: {},
      deserializeStackLength: 0,
      nodesTraversed: [],
    },
    globals: { store: {}, initializedModules: [] },
    nodeId: "main",
    moduleId: "mod.agency",
    scopeName: "main",
    stepPath: "0",
  });
}

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

  it("between a request's reads, it rejects the request's next read", async () => {
    const { ui } = screenful();
    try {
      // The picker loads its checkpoint before its first read; the
      // withdrawal lands in that gap.
      const picking = ui.showRewindSelector([checkpoint(1), checkpoint(2)]);
      ui.withdraw();
      await expect(picking).rejects.toBeInstanceOf(RequestWithdrawn);
    } finally {
      ui.destroy();
    }
  });

  it("with no request in progress, it does not carry over to the next one", async () => {
    const { ui, input } = screenful();
    try {
      expect(() => ui.withdraw()).not.toThrow();
      const next = ui.waitForCommand();
      input.feedKey({ key: "s" });
      expect(await next).toEqual({ type: "step" });
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
