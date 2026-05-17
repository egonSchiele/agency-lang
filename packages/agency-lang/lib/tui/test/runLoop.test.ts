import { describe, it, expect } from "vitest";
import { Screen } from "../screen.js";
import { ScriptedInput } from "../input/scripted.js";
import { FrameRecorder } from "../output/recorder.js";
import { line } from "../builders.js";

describe("Screen.runLoop", () => {
  it("renders, handles keys, and stops when isDone returns true", async () => {
    const input = new ScriptedInput();
    input.feedKey({ key: "j" });
    input.feedKey({ key: "j" });
    input.feedKey({ key: "q" });
    const output = new FrameRecorder();
    const screen = new Screen({ input, output, width: 20, height: 5 });
    const finalState = await screen.runLoop({
      initialState: { n: 0, done: false },
      render: (s) => line(`n=${s.n}`),
      handleKey: (s, event) => {
        if (event.key === "q") return { ...s, done: true };
        if (event.key === "j") return { ...s, n: s.n + 1 };
        return s;
      },
      isDone: (s) => s.done,
    });
    expect(finalState.n).toBe(2);
    // Four frames: initial render + one after each key.
    expect(output.frames.length).toBe(4);
  });

  it("stops without consuming any keys when isDone returns true initially", async () => {
    const input = new ScriptedInput();
    const output = new FrameRecorder();
    const screen = new Screen({ input, output, width: 20, height: 5 });
    const finalState = await screen.runLoop({
      initialState: { done: true },
      render: () => line("hi"),
      handleKey: (s) => s,
      isDone: (s) => s.done,
    });
    expect(finalState.done).toBe(true);
    // Just the initial render.
    expect(output.frames.length).toBe(1);
  });
});
