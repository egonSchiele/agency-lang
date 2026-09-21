import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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
  it("renders, navigates with j, expands with Enter, quits with q", async () => {
    const out = new FrameRecorder();
    await runViewer({
      jsonl: sample,
      input: new ScriptedInput(["2", "m", "j", "Enter", "q"]),
      output: out,
      viewport: { rows: 10, cols: 100 },
    });
    expect(out.frames.length).toBeGreaterThan(0);
    expect(out.lastText()).toMatch(/agentRun/);
  });

  it("shows a run directory's annotation summary in the shell header", async () => {
    const out = new FrameRecorder();
    await runViewer({
      jsonl: sample,
      input: new ScriptedInput(["2", "q"]),
      output: out,
      viewport: { rows: 10, cols: 100 },
      traceAnnotations: { abc: "1 note · score 0.50" },
    });
    expect(out.lastText()).toContain("1 note · score 0.50");
  });

  it("starts on the focused trace when asked to", async () => {
    const second = sample.replaceAll('"trace_id":"abc"', '"trace_id":"xyz"');
    const out = new FrameRecorder();
    // Extract via `x` writes `<traceId>.jsonl` by default, which tells us
    // which trace the cursor was on.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-focus-"));
    const source = path.join(dir, "log.jsonl");
    fs.writeFileSync(source, sample + second);
    const input = new ScriptedInput(["2", "x"]);
    input.feedLine(path.join(dir, "picked.jsonl"));
    input.feedKey({ key: "q" });
    await runViewer({
      jsonl: sample + second,
      input,
      output: out,
      viewport: { rows: 12, cols: 100 },
      extract: { sourcePath: source },
      focusTraceId: "xyz",
    });
    expect(fs.readFileSync(path.join(dir, "picked.jsonl"), "utf8")).toBe(second);
  });

  it("x extracts the focused trace to the file the user names", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-extract-"));
    const source = path.join(dir, "log.jsonl");
    fs.writeFileSync(source, sample);
    const outPath = path.join(dir, "out", "abc.jsonl");
    const input = new ScriptedInput(["2", "x"]);
    input.feedLine(outPath);
    input.feedKey({ key: "q" });
    const out = new FrameRecorder();
    await runViewer({
      jsonl: sample,
      input,
      output: out,
      viewport: { rows: 12, cols: 100 },
      extract: { sourcePath: source },
    });
    expect(fs.readFileSync(outPath, "utf8")).toBe(sample);
    expect(out.lastText()).toMatch(/Wrote 2 events/);
  });

  it("x refuses to overwrite a file that already exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-extract-"));
    const source = path.join(dir, "log.jsonl");
    fs.writeFileSync(source, sample);
    const outPath = path.join(dir, "taken.jsonl");
    fs.writeFileSync(outPath, "precious\n");
    const input = new ScriptedInput(["2", "x"]);
    input.feedLine(outPath);
    input.feedKey({ key: "q" });
    const out = new FrameRecorder();
    await runViewer({
      jsonl: sample,
      input,
      output: out,
      viewport: { rows: 12, cols: 100 },
      extract: { sourcePath: source },
    });
    expect(fs.readFileSync(outPath, "utf8")).toBe("precious\n");
    expect(out.lastText()).toMatch(/Extract failed/);
  });

  it("x does nothing without a local source", async () => {
    const out = new FrameRecorder();
    await runViewer({
      jsonl: sample,
      input: new ScriptedInput(["2", "x", "q"]),
      output: out,
      viewport: { rows: 12, cols: 100 },
    });
    expect(out.lastText()).not.toMatch(/Wrote/);
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
    // Inspect machinery, scroll to the end, then fold its parent.
    const keys = ["2", "m", ...Array.from({ length: 20 }, () => "j"), "g", "Enter", "q"];
    const out = new FrameRecorder();
    await runViewer({
      jsonl,
      input: new ScriptedInput(keys),
      output: out,
      viewport: { rows: 5, cols: 100 },
    });
    const last = out.lastText();
    // The parent remains visible after all its children are hidden.
    expect(last.length).toBeGreaterThan(0);
    expect(last).toContain("debug");
    expect(last).toContain("30 hidden");
  });

  it("machinery leaves show complete JSON in the payload pane", async () => {
    const out = new FrameRecorder();
    await runViewer({
      jsonl: sample,
      input: new ScriptedInput(["2", "m", "j", "q"]),
      output: out,
      viewport: { rows: 20, cols: 100 },
    });
    expect(out.lastText()).toContain('"data":');
    expect(out.lastText()).toContain('"type": "agentStart"');
  });

  it("/ then a query jumps the cursor to the first match", async () => {
    const out = new FrameRecorder();
    const scripted = new ScriptedInput(["2", "m", "/"]);
    // Pre-load the search prompt response and the final 'q'.
    scripted.feedLine("agentEnd");
    scripted.feedKey({ key: "q" });
    await runViewer({
      jsonl: sample,
      input: scripted,
      output: out,
      viewport: { rows: 10, cols: 100 },
    });
    const last = out.lastText();
    // The query keeps its matching event and containing span visible.
    expect(last).toContain("/agentEnd");
    expect(last).toContain("1 hidden");
    expect(last).toMatch(/agentEnd/);
  });

  it("? opens the help overlay; any key closes it", async () => {
    const out = new FrameRecorder();
    await runViewer({
      jsonl: sample,
      input: new ScriptedInput(["?", "j", "q"]),
      output: out,
      viewport: { rows: 20, cols: 100 },
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
      viewport: { rows: 10, cols: 100 },
    });
    expect(out.textAt(0)).toMatch(/1 parse error/);
  });
});
