import { describe, it, expect } from "vitest";
import { Screen } from "../screen.js";
import { ScriptedInput } from "../input/scripted.js";
import { FrameRecorder } from "../output/recorder.js";
import { box, text } from "../builders.js";

describe("Screen", () => {
  it("render produces a frame and writes to output", () => {
    const recorder = new FrameRecorder();
    const input = new ScriptedInput();
    const screen = new Screen({ output: recorder, input, width: 40, height: 10 });

    const frame = screen.render(box({ border: true, key: "main" }, text("hello")));
    expect(frame).toBeDefined();
    expect(frame.findByKey("main")).toBeDefined();
    expect(recorder.frames).toHaveLength(1);
  });

  it("nextKey returns events from input source", async () => {
    const recorder = new FrameRecorder();
    const input = new ScriptedInput();
    input.feedKey({ key: "s" });
    const screen = new Screen({ output: recorder, input, width: 40, height: 10 });

    const key = await screen.nextKey();
    expect(key).toEqual({ key: "s" });
  });
});
