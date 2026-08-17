import { describe, it, expect } from "vitest";

import { Screen } from "../tui/screen.js";
import { ScriptedInput } from "../tui/input/scripted.js";
import { FrameRecorder } from "../tui/output/recorder.js";
import { editTaskOnScreen, fieldLines } from "./taskEditor.js";

// The gray-until-edited signal is an ANSI bright-black foreground.
const GRAY = "\x1b[90m";

function makeScreen(keys: ReadonlyArray<string | { key: string; text?: string; ctrl?: boolean }>) {
  const out = new FrameRecorder();
  const screen = new Screen({ output: out, input: new ScriptedInput(keys), width: 80, height: 24 });
  return { screen, out };
}

function chars(text: string): { key: string }[] {
  return text.split("").map((key) => ({ key }));
}

describe("editTaskOnScreen", () => {
  it("pre-fills the field with the recorded task and names the step", async () => {
    const { screen, out } = makeScreen([{ key: "enter" }]);
    await editTaskOnScreen(screen, "Write a 10 word story about a cat and a dog.");
    const text = out.lastText();
    expect(text).toMatch(/Set the task/);
    expect(text).toMatch(/Write a 10 word story about a cat and a dog\./);
  });

  it("keeps the recorded task when the field is accepted untouched", async () => {
    const { screen } = makeScreen([{ key: "enter" }]);
    expect(await editTaskOnScreen(screen, "the recorded task")).toEqual({ kind: "keep-default" });
  });

  it("treats appended text as a replacement of the pre-filled default", async () => {
    // The default is pre-filled, so typing appends to it — the whole field is
    // the new task the annotator committed to.
    const { screen } = makeScreen([...chars("!"), { key: "enter" }]);
    expect(await editTaskOnScreen(screen, "old task")).toEqual({
      kind: "replace",
      value: "old task!",
    });
  });

  it("clears the task when the annotator deletes the default down to nothing", async () => {
    const backspaces = Array.from({ length: "old".length }, () => ({ key: "backspace" }));
    const { screen } = makeScreen([...backspaces, { key: "enter" }]);
    expect(await editTaskOnScreen(screen, "old")).toEqual({ kind: "omit" });
  });

  it("lets the annotator type a task when the run recorded none", async () => {
    const { screen } = makeScreen([...chars("judge this"), { key: "enter" }]);
    expect(await editTaskOnScreen(screen, null)).toEqual({ kind: "replace", value: "judge this" });
  });

  it("backs out with Escape, returning null so the trace is not labeled", async () => {
    const { screen } = makeScreen([{ key: "x" }, { key: "escape" }]);
    expect(await editTaskOnScreen(screen, "old task")).toBeNull();
  });

  it("shows a typing hint when there is no recorded task to pre-fill", async () => {
    const { screen, out } = makeScreen([{ key: "enter" }]);
    await editTaskOnScreen(screen, null);
    expect(out.lastText()).toMatch(/type a task/);
  });

  it("paints the pre-filled default gray and the edited text plain white", () => {
    const untouched = fieldLines("the recorded task", false, true, 60).join("");
    const edited = fieldLines("the recorded task!", true, true, 60).join("");
    expect(untouched).toContain(GRAY); // gray default
    expect(edited).not.toContain(GRAY); // now the annotator's own text
  });
});
