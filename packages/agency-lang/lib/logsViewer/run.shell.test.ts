// Shell-level behavior: the view stack, action dispatch, help overlay,
// and the key routing that must NOT misfire (Ctrl+F pages; it is not `f`).
import { describe, expect, it } from "vitest";

import { ScriptedInput } from "../tui/input/scripted.js";
import { FrameRecorder } from "../tui/output/recorder.js";
import { runViewer } from "./run.js";

const events = [
  { type: "agentStart", timestamp: "2026-05-16T00:00:00.000Z", entryNode: "main" },
  { type: "threadCreated", timestamp: "2026-05-16T00:00:00.100Z", threadId: "1", label: "mainThread" },
  { type: "promptStart", timestamp: "2026-05-16T00:00:00.200Z", model: '"m1"', threadId: "1" },
  {
    type: "promptCompletion", timestamp: "2026-05-16T00:00:01.000Z", model: '"m1"', threadId: "1",
    timeTaken: 800, usage: { inputTokens: 10, outputTokens: 2 }, cost: { totalCost: 0.01 },
    messages: [{ role: "user", content: "add two numbers" }],
    completion: { output: "3" },
  },
  { type: "agentEnd", timestamp: "2026-05-16T00:00:02.000Z", timeTaken: 2000 },
].map((data, i) => JSON.stringify({
  format_version: 1, trace_id: "abc", project_id: "p",
  span_id: data.type.startsWith("prompt") ? "s2" : "s1",
  parent_span_id: data.type.startsWith("prompt") ? "s1" : null,
  data,
}));

const sample = events.join("\n") + "\n";

async function drive(keys: (string | { key: string; ctrl?: boolean })[]): Promise<FrameRecorder> {
  const out = new FrameRecorder();
  await runViewer({
    jsonl: sample,
    input: new ScriptedInput([...keys, "q"]),
    output: out,
    viewport: { rows: 20, cols: 120 },
  });
  return out;
}

function texts(out: FrameRecorder): string[] {
  return Array.from({ length: out.frames.length }, (_unused, i) => out.textAt(i));
}

describe("the viewer shell", () => {
  it("t opens flame, t again by-name, Esc lands back on the tree intact", async () => {
    const out = await drive(["t", "t", { key: "escape" }]);
    const frames = texts(out);
    expect(frames.some((t) => t.includes("TIMELINE [flame]"))).toBe(true);
    expect(frames.some((t) => t.includes("TIMELINE [byName]"))).toBe(true);
    expect(out.lastText()).toMatch(/agentRun/);
    expect(out.lastText()).not.toContain("TIMELINE");
  });

  it("? shows the ACTIVE view's help and any key closes it", async () => {
    const out = await drive(["t", "?", "x"]);
    const help = texts(out).find((t) => t.includes("Keybindings"))!;
    expect(help).toContain("drill");
    expect(out.lastText()).toContain("TIMELINE [flame]");
  });

  it("d in the tree opens the detail screen (a viewer-level feature)", async () => {
    const out = await drive(["d", { key: "escape" }]);
    expect(texts(out).some((t) => t.includes("DETAIL"))).toBe(true);
  });

  it("o in flame pops to the tree focused on the span", async () => {
    const out = await drive(["t", "j", "o"]);
    expect(out.lastText()).not.toContain("TIMELINE");
  });

  it("Ctrl+F pages — it must not toggle follow", async () => {
    const out = await drive([{ key: "f", ctrl: true }]);
    expect(texts(out).join("\n")).not.toContain("follow");
  });

  it("f without a followPath reports rather than toggling", async () => {
    const out = await drive(["f"]);
    expect(texts(out).join("\n")).toContain("follow unavailable");
  });

  it("promptLine round-trip drives tree search", async () => {
    const out = new FrameRecorder();
    const input = new ScriptedInput(["/", "q"]);
    input.feedLine("agentRun");
    await runViewer({
      jsonl: sample, input, output: out, viewport: { rows: 20, cols: 120 },
    });
    expect(out.lastText()).toContain("match 1/");
  });

  it("quit works from a timeline view", async () => {
    const out = await drive(["t", "t"]);
    expect(out.frames.length).toBeGreaterThan(0);
  });
});
