import { describe, it, expect } from "vitest";

import { Screen } from "../tui/screen.js";
import { ScriptedInput } from "../tui/input/scripted.js";
import { FrameRecorder } from "../tui/output/recorder.js";
import { editTaskOnScreen } from "./taskEditor.js";

function makeScreen(keys: ReadonlyArray<string | { key: string; text?: string; ctrl?: boolean }>) {
  const out = new FrameRecorder();
  const screen = new Screen({ output: out, input: new ScriptedInput(keys), width: 80, height: 24 });
  return { screen, out };
}

describe("editTaskOnScreen", () => {
  it("paints a full-screen page that names the step and shows the recorded task", async () => {
    const { screen, out } = makeScreen([{ key: "enter" }]);
    await editTaskOnScreen(screen, "Summarize the news for 2026-08-15");
    const text = out.lastText();
    expect(text).toMatch(/set the task/);
    expect(text).toMatch(/Recorded task/);
    expect(text).toMatch(/Summarize the news for 2026-08-15/);
    expect(text).toMatch(/Your task/);
  });

  it("keeps the recorded task when the annotator just presses Enter", async () => {
    const { screen } = makeScreen([{ key: "enter" }]);
    expect(await editTaskOnScreen(screen, "the recorded task")).toEqual({ kind: "keep-default" });
  });

  it("replaces the task with typed text", async () => {
    const keys = [..."new task".split("").map((key) => ({ key })), { key: "enter" }];
    const { screen } = makeScreen(keys);
    expect(await editTaskOnScreen(screen, "old task")).toEqual({ kind: "replace", value: "new task" });
  });

  it("clears the task when the annotator types a single dash", async () => {
    const { screen } = makeScreen([{ key: "-" }, { key: "enter" }]);
    expect(await editTaskOnScreen(screen, "old task")).toEqual({ kind: "omit" });
  });

  it("backs out with Escape, returning null so the trace is not labeled", async () => {
    const { screen } = makeScreen([{ key: "x" }, { key: "escape" }]);
    expect(await editTaskOnScreen(screen, "old task")).toBeNull();
  });

  it("shows a placeholder when the run recorded no task", async () => {
    const { screen, out } = makeScreen([{ key: "enter" }]);
    await editTaskOnScreen(screen, null);
    expect(out.lastText()).toMatch(/none recorded/);
  });
});
