import { describe, it, expect, vi } from "vitest";
import { runViewer } from "./run.js";
import { ScriptedInput } from "../tui/input/scripted.js";
import { FrameRecorder } from "../tui/output/recorder.js";

// The viewer detects the clipboard by probing for pbcopy/xclip; swap in a
// fake that captures what was written so the test is machine-independent.
const written: string[] = [];
vi.mock("./clipboard.js", () => ({
  detectClipboard: () => ({ write: (text: string) => written.push(text) }),
}));

function event(traceId: string, spanId: string, type: string, timestamp: string, extra = {}) {
  return {
    format_version: 1,
    trace_id: traceId,
    project_id: "p",
    span_id: spanId,
    parent_span_id: null,
    data: { type, timestamp, ...extra },
  };
}

// Two traces in one file. `Y` on the first trace must copy exactly its
// events, in file order, and nothing from the second trace.
const events = [
  event("abc", "s1", "agentStart", "2026-05-16T00:00:00.000Z", { entryNode: "main" }),
  event("abc", "s1", "print", "2026-05-16T00:00:00.500Z", { message: "hi" }),
  event("xyz", "s2", "agentStart", "2026-05-16T00:00:02.000Z", { entryNode: "main" }),
  event("abc", "s1", "agentEnd", "2026-05-16T00:00:01.000Z", { timeTaken: 1000 }),
  event("xyz", "s2", "agentEnd", "2026-05-16T00:00:03.000Z", { timeTaken: 1000 }),
];
const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";

describe("Y copies the whole focused trace", () => {
  it("writes every event of the trace as JSONL and reports the count", async () => {
    written.length = 0;
    const out = new FrameRecorder();
    await runViewer({
      jsonl,
      input: new ScriptedInput(["Y", "q"]),
      output: out,
      viewport: { rows: 12, cols: 100 },
    });
    expect(written).toHaveLength(1);
    const lines = written[0].split("\n").filter((l) => l !== "");
    expect(lines.map((l) => JSON.parse(l))).toEqual([events[0], events[1], events[3]]);
    expect(out.lastText()).toMatch(/copied 3 events of trace abc/);
  });

  it("y still copies only the focused node", async () => {
    written.length = 0;
    await runViewer({
      jsonl,
      input: new ScriptedInput(["y", "q"]),
      output: new FrameRecorder(),
      viewport: { rows: 12, cols: 100 },
    });
    expect(written).toHaveLength(1);
    expect(written[0]).not.toMatch(/agentEnd/);
  });
});
