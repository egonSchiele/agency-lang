// End-to-end follow-mode behavior against a real file on disk — the tests
// that would have caught follow being broken since it shipped.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ScriptedInput } from "../tui/input/scripted.js";
import { FrameRecorder } from "../tui/output/recorder.js";
import { runViewer } from "./run.js";

function envelope(spanId: string, type: string, at: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format_version: 1, trace_id: "abc", project_id: "p",
    span_id: spanId, parent_span_id: null,
    data: { type, timestamp: new Date(at).toISOString(), ...extra },
  }) + "\n";
}

const bootLine = envelope("s1", "agentStart", 0, { entryNode: "main" });

function toolLines(spanId: string, name: string, at: number): string {
  return envelope(spanId, "toolCallStart", at, { toolName: name })
    + envelope(spanId, "toolCall", at + 100, { toolName: name });
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("follow mode", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "follow-"));
    file = path.join(dir, "statelog.jsonl");
    fs.writeFileSync(file, bootLine);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function start(input: ScriptedInput, out: FrameRecorder) {
    return runViewer({
      jsonl: fs.readFileSync(file, "utf8"),
      followPath: file,
      followIntervalMs: 20,
      input,
      output: out,
      viewport: { rows: 20, cols: 100 },
    });
  }

  it("an appended span appears while following", async () => {
    const input = new ScriptedInput([]);
    const out = new FrameRecorder();
    const done = start(input, out);
    input.feedKey({ key: "f" });
    fs.appendFileSync(file, toolLines("s2", "firstTool", 1_000));
    await until(() => out.frames.length > 0 && out.lastText().includes("firstTool"));
    input.feedKey({ key: "q" });
    await done;
    expect(out.lastText()).toContain("firstTool");
  });

  it("toggling follow off and on must not lose earlier appends (the accumulator rewind)", async () => {
    const input = new ScriptedInput([]);
    const out = new FrameRecorder();
    const done = start(input, out);
    input.feedKey({ key: "f" });                                   // follow on
    fs.appendFileSync(file, toolLines("s2", "earlyTool", 1_000));
    await until(() => out.frames.length > 0 && out.lastText().includes("earlyTool"));
    input.feedKey({ key: "f" });                                   // off
    input.feedKey({ key: "f" });                                   // on again
    fs.appendFileSync(file, toolLines("s3", "lateTool", 2_000));
    await until(() => out.frames.length > 0 && out.lastText().includes("lateTool"));
    input.feedKey({ key: "q" });
    await done;
    expect(out.lastText()).toContain("lateTool");
    expect(out.lastText()).toContain("earlyTool");
  });

  it("a truncated file resets the view without crashing", async () => {
    const input = new ScriptedInput([]);
    const out = new FrameRecorder();
    const done = start(input, out);
    input.feedKey({ key: "f" });
    fs.appendFileSync(file, toolLines("s2", "beforeTruncate", 1_000));
    await until(() => out.frames.length > 0 && out.lastText().includes("beforeTruncate"));
    fs.writeFileSync(file, bootLine + toolLines("s9", "afterTruncate", 500));
    await until(() => out.frames.length > 0 && out.lastText().includes("afterTruncate"));
    input.feedKey({ key: "q" });
    await done;
    expect(out.lastText()).toContain("afterTruncate");
    expect(out.lastText()).not.toContain("beforeTruncate");
  });

  it("a truncation to empty clears the previous trace from the view", async () => {
    // A shrink to nothing produces no chunk, so the watcher must still notify —
    // otherwise the old trace stays on screen and stays labelable.
    const input = new ScriptedInput([]);
    const out = new FrameRecorder();
    const done = start(input, out);
    input.feedKey({ key: "f" });
    fs.appendFileSync(file, toolLines("s2", "beforeTruncate", 1_000));
    await until(() => out.frames.length > 0 && out.lastText().includes("beforeTruncate"));
    fs.writeFileSync(file, "");
    await until(() => out.frames.length > 0 && !out.lastText().includes("beforeTruncate"));
    input.feedKey({ key: "q" });
    await done;
    expect(out.lastText()).not.toContain("beforeTruncate");
  });
});
