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

describe("runViewer", () => {
  it("renders, navigates with j, expands with l, quits with q", async () => {
    const out = new FrameRecorder();
    await runViewer({
      jsonl: sample,
      input: new ScriptedInput(["j", "l", "q"]),
      output: out,
      viewport: { rows: 10, cols: 80 },
    });
    expect(out.frames.length).toBeGreaterThan(0);
    expect(out.lastText()).toMatch(/agentRun/);
  });

  it("shows a helpful message when the file is empty", async () => {
    const out = new FrameRecorder();
    await runViewer({
      jsonl: "",
      input: new ScriptedInput(["q"]),
      output: out,
      viewport: { rows: 5, cols: 40 },
    });
    expect(out.textAt(0).toLowerCase()).toMatch(/no events/);
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
    // l: expand span. j × 20: scroll far down. h: collapse it. q.
    const keys = [
      "l",
      ...Array.from({ length: 20 }, () => "j"),
      "h",
      "q",
    ];
    const out = new FrameRecorder();
    await runViewer({
      jsonl,
      input: new ScriptedInput(keys),
      output: out,
      viewport: { rows: 5, cols: 80 },
    });
    const last = out.lastText();
    // After collapsing, the trace + s1 should still be visible — the
    // frame must not be empty.
    expect(last.length).toBeGreaterThan(0);
    expect(last).toMatch(/\[abc\]/);
  });

  it("Enter on a leaf opens the JSON pane with the payload", async () => {
    const out = new FrameRecorder();
    await runViewer({
      jsonl: sample,
      // Navigate: l (expand trace) l (expand agentRun span) j (move
      // to first child leaf, agentStart) Enter (open pane) q (quit).
      input: new ScriptedInput(["l", "l", "j", "Enter", "q"]),
      output: out,
      viewport: { rows: 20, cols: 80 },
    });
    const last = out.lastText();
    // The pane should show the agentStart event payload (the
    // EventEnvelope shape includes trace_id and "data" at the top
    // level). Header `▼ {` indicates the pane is open and expanded.
    expect(last).toMatch(/"data":/);
    expect(last).toMatch(/agentStart/);
  });

  it("/ then a query jumps the cursor to the first match", async () => {
    const out = new FrameRecorder();
    const scripted = new ScriptedInput(["l", "j", "/"]);
    // Pre-load the search prompt response and the final 'q'.
    scripted.feedLine("agentEnd");
    scripted.feedKey({ key: "q" });
    await runViewer({
      jsonl: sample,
      input: scripted,
      output: out,
      viewport: { rows: 10, cols: 80 },
    });
    const last = out.lastText();
    // Status bar should show the match indicator.
    expect(last).toMatch(/match 1\/1/);
    // And mention the query string.
    expect(last).toMatch(/agentEnd/);
  });

  it("? opens the help overlay; any key closes it", async () => {
    const out = new FrameRecorder();
    await runViewer({
      jsonl: sample,
      input: new ScriptedInput(["?", "j", "q"]),
      output: out,
      viewport: { rows: 20, cols: 80 },
    });
    // At least one frame should show the help heading.
    const anyHelp = out.frames.some((_, i) => out.textAt(i).includes("Keybindings"));
    expect(anyHelp).toBe(true);
    // And the final frame (after `j`) should not.
    expect(out.lastText()).not.toMatch(/Keybindings/);
  });

  it("shows parse errors as a footer line", async () => {
    const out = new FrameRecorder();
    const bad = sample + "this is not json\n";
    await runViewer({
      jsonl: bad,
      input: new ScriptedInput(["q"]),
      output: out,
      viewport: { rows: 10, cols: 80 },
    });
    expect(out.textAt(0)).toMatch(/1 parse error/);
  });
});
