import { describe, it, expect } from "vitest";
import { runViewer } from "./run.js";
import { ScriptedInput } from "../tui/input/scripted.js";
import { FrameRecorder } from "../tui/output/recorder.js";

const sampleEvents = [
  {
    format_version: 1,
    trace_id: "abc",
    project_id: "p",
    span_id: "s1",
    parent_span_id: null,
    data: {
      type: "agentStart",
      timestamp: "2026-05-16T00:00:00.000Z",
      entryNode: "main",
    },
  },
  {
    format_version: 1,
    trace_id: "abc",
    project_id: "p",
    span_id: "s1",
    parent_span_id: null,
    data: {
      type: "agentEnd",
      timestamp: "2026-05-16T00:00:01.000Z",
      timeTaken: 1000,
    },
  },
];

const sample = sampleEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";

function feed(input: ScriptedInput, keys: string[]): void {
  for (const k of keys) input.feedKey({ key: k });
}

describe("runViewer", () => {
  it("renders, navigates with j, expands with l, quits with q", async () => {
    const input = new ScriptedInput();
    feed(input, ["j", "l", "q"]);
    const out = new FrameRecorder();
    await runViewer({
      jsonl: sample,
      input,
      output: out,
      viewport: { rows: 10, cols: 80 },
    });
    expect(out.frames.length).toBeGreaterThan(0);
    const lastFrame = out.frames[out.frames.length - 1].frame.toPlainText();
    expect(lastFrame).toMatch(/agentRun/);
  });

  it("shows a helpful message when the file is empty", async () => {
    const input = new ScriptedInput();
    feed(input, ["q"]);
    const out = new FrameRecorder();
    await runViewer({
      jsonl: "",
      input,
      output: out,
      viewport: { rows: 5, cols: 40 },
    });
    const first = out.frames[0].frame.toPlainText();
    expect(first.toLowerCase()).toMatch(/no events/);
  });

  it("clamps scrollTop after collapsing reduces the visible row count", async () => {
    // Build a synthetic log with many leaves under one span, scroll
    // way past where the collapsed view will reach, then collapse the
    // span. Without clamping the viewer would render an empty frame.
    const many = Array.from({ length: 30 }, (_, i) => ({
      format_version: 1,
      trace_id: "abc",
      project_id: "p",
      span_id: "s1",
      parent_span_id: null,
      data: { type: "debug", timestamp: "", message: `m${i}` },
    }));
    const jsonl = many.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const input = new ScriptedInput();
    // l: expand span. j × 20: scroll far down. h: collapse it. q.
    feed(input, [
      "l",
      ...Array.from({ length: 20 }, () => "j"),
      "h",
      "q",
    ]);
    const out = new FrameRecorder();
    await runViewer({
      jsonl,
      input,
      output: out,
      viewport: { rows: 5, cols: 80 },
    });
    const last = out.frames[out.frames.length - 1].frame.toPlainText();
    // After collapsing, the trace + s1 should still be visible — the
    // frame must not be empty.
    expect(last.length).toBeGreaterThan(0);
    expect(last).toMatch(/trace abc/);
  });

  it("shows parse errors as a footer line", async () => {
    const input = new ScriptedInput();
    feed(input, ["q"]);
    const out = new FrameRecorder();
    const bad = sample + "this is not json\n";
    await runViewer({
      jsonl: bad,
      input,
      output: out,
      viewport: { rows: 10, cols: 80 },
    });
    const frame = out.frames[0].frame.toPlainText();
    expect(frame).toMatch(/1 parse error/);
  });
});
