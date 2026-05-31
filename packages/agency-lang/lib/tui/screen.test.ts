import { describe, it, expect } from "vitest";
import { Screen } from "./screen.js";
import { ScriptedInput } from "./input/scripted.js";
import { FrameRecorder } from "./output/recorder.js";
import { column, line } from "./builders.js";

describe("Screen.runLoop tickMs", () => {
  it("re-renders periodically even with no key input", async () => {
    const input = new ScriptedInput();
    const output = new FrameRecorder();
    const screen = new Screen({ input, output, width: 40, height: 5 });
    let renderCount = 0;
    // Use a state object that flips `done` from outside via a timer
    // so the loop terminates after enough ticks.
    const state = { done: false };
    setTimeout(() => {
      state.done = true;
      // Feed a key so the loop wakes from the current race and re-checks
      // isDone. Without this it would wait for the next tick (acceptable
      // but slow). The key path also updates state so isDone reads true.
      input.feedKey({ key: "q" });
    }, 120);
    const finalState = await screen.runLoop({
      initialState: state,
      render: () => {
        renderCount++;
        return column({}, line("tick"));
      },
      handleKey: (s) => s,
      isDone: (s) => s.done,
      tickMs: 30,
    });
    // Initial render + at least 2 ticks within 120ms (tick=30ms).
    expect(renderCount).toBeGreaterThanOrEqual(3);
    expect(finalState.done).toBe(true);
    screen.destroy();
  });

  it("falls back to pure event-driven mode when tickMs is omitted", async () => {
    const input = new ScriptedInput([{ key: "q" }]);
    const output = new FrameRecorder();
    const screen = new Screen({ input, output, width: 40, height: 5 });
    let renderCount = 0;
    const finalState = await screen.runLoop({
      initialState: { done: false },
      render: () => {
        renderCount++;
        return column({}, line("hi"));
      },
      handleKey: (_s, ev) => ({ done: ev.key === "q" }),
      isDone: (s) => s.done,
    });
    // Initial render + 1 render after the keypress.
    expect(renderCount).toBe(2);
    expect(finalState.done).toBe(true);
    screen.destroy();
  });
});
