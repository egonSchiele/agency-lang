// End-to-end follow-mode behavior against a real file on disk — the tests
// that would have caught follow being broken since it shipped.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ScriptedInput } from "../tui/input/scripted.js";
import { FrameRecorder } from "../tui/output/recorder.js";
import { makeFollowWatcher, runViewer } from "./run.js";
import type { ParseResult } from "../statelog/parse.js";
import { commentsPathFor } from "../runDirectory/commentsPath.js";
import { openCommentsStore } from "../runDirectory/commentsStore.js";

function envelope(
  spanId: string,
  type: string,
  at: number,
  extra: Record<string, unknown> = {},
): string {
  return (
    JSON.stringify({
      format_version: 1,
      trace_id: "abc",
      project_id: "p",
      span_id: spanId,
      parent_span_id: null,
      data: { type, timestamp: new Date(at).toISOString(), ...extra },
    }) + "\n"
  );
}

const bootLine = envelope("s1", "agentStart", 0, { entryNode: "main" });

function toolLines(spanId: string, name: string, at: number): string {
  return (
    envelope(spanId, "toolCallStart", at, { toolName: name }) +
    envelope(spanId, "toolCall", at + 100, { toolName: name })
  );
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// The rendered row the cursor is on ("> " marker), colors stripped.
function cursorRow(out: FrameRecorder): string {
  if (out.frames.length === 0) return "";
  // eslint-disable-next-line no-control-regex
  const text = out.lastText().replace(/\x1b\[[0-9;]*m/g, "");
  return (
    text
      .split("\n")
      .find(
        (line) => line.trimStart().startsWith("▶ ") && !line.trimStart().startsWith("▶ OUTLINE ·"),
      ) ?? ""
  );
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
    input.feedKey({ key: "2" });
    return runViewer({
      followPath: file,
      followIntervalMs: 20,
      input,
      output: out,
      viewport: { rows: 20, cols: 100 },
    });
  }

  it("a new trace arriving under follow does not open the boot picker", async () => {
    const input = new ScriptedInput([]);
    const out = new FrameRecorder();
    const done = start(input, out);
    input.feedKey({ key: "f" });
    fs.appendFileSync(
      file,
      toolLines("new-trace-tool", "arrived", 1000).replaceAll(
        '"trace_id":"abc"',
        '"trace_id":"second"',
      ),
    );
    await until(() => out.frames.length > 0 && out.lastText().includes("trace 1/2"));
    input.feedKey({ key: "q" });
    await done;
    expect(out.lastText()).toContain("trace 1/2");
    expect(out.lastText()).not.toContain("TRACES");
  });

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

  it("keeps the picker header on its highlighted trace through append and truncation", async () => {
    const second = toolLines("second-tool", "secondTool", 1000).replaceAll(
      '"trace_id":"abc"',
      '"trace_id":"second"',
    );
    fs.appendFileSync(file, second);
    const input = new ScriptedInput(["g"]);
    const out = new FrameRecorder();
    const done = runViewer({
      followPath: file,
      initialFollow: true,
      followIntervalMs: 20,
      input,
      output: out,
      viewport: { rows: 20, cols: 130 },
    });
    const header = () => (out.frames.length > 0 ? out.lastText().split("\n")[0] : "");
    try {
      await until(() => header().includes("abc  trace 1/2"));
      expect(header()).toContain("abc  trace 1/2");
      fs.appendFileSync(file, second.replaceAll('"second"', '"third"'));
      await until(() => header().includes("abc  trace 1/3"));
      expect(header()).toContain("abc  trace 1/3");
      fs.writeFileSync(file, second);
      await until(() => header().includes("second") && out.lastText().includes("[TRACES]"));
      expect(out.lastText()).toContain("[TRACES]");
      expect(header()).toContain("second");
      expect(header()).not.toContain("abc");
      expect(header()).not.toContain("[1 overview]");
    } finally {
      input.feedKey({ key: "q" });
      await done;
    }
  });

  it("toggling follow off and on must not lose earlier appends (the accumulator rewind)", async () => {
    const input = new ScriptedInput([]);
    const out = new FrameRecorder();
    const done = start(input, out);
    input.feedKey({ key: "f" }); // follow on
    fs.appendFileSync(file, toolLines("s2", "earlyTool", 1_000));
    await until(() => out.frames.length > 0 && out.lastText().includes("earlyTool"));
    input.feedKey({ key: "f" }); // off
    input.feedKey({ key: "f" }); // on again
    fs.appendFileSync(file, toolLines("s3", "lateTool", 2_000));
    await until(() => out.frames.length > 0 && out.lastText().includes("lateTool"));
    input.feedKey({ key: "q" });
    await done;
    expect(out.lastText()).toContain("lateTool");
    expect(out.lastText()).toContain("earlyTool");
  });

  it("an append keeps the cursor on a stable user story row", async () => {
    // User rows retain their round-based identity across a follow parse.
    fs.appendFileSync(
      file,
      envelope("s1", "promptCompletion", 500, {
        messages: [{ role: "user", content: "hello there" }],
        completion: { output: "hi back" },
      }),
    );
    const input = new ScriptedInput([]);
    const out = new FrameRecorder();
    const done = start(input, out);
    input.feedKey({ key: "g" }); // the first row is the user turn
    await until(() => cursorRow(out).includes("hello there"));
    input.feedKey({ key: "f" });
    fs.appendFileSync(file, toolLines("s2", "laterTool", 1_000));
    await until(() => out.lastText().includes("laterTool"));
    input.feedKey({ key: "q" });
    await done;
    expect(cursorRow(out)).toContain("hello there");
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

  it("shows a last line with no newline when the file is opened without --follow", async () => {
    const lastLine = envelope("s2", "toolCallStart", 1_000, { toolName: "lastTool" });
    fs.writeFileSync(file, bootLine + lastLine.trimEnd());
    const input = new ScriptedInput([]);
    const out = new FrameRecorder();
    const done = start(input, out);
    await until(() => out.frames.length > 0 && out.lastText().includes("lastTool"));
    input.feedKey({ key: "q" });
    await done;
    expect(out.lastText()).toContain("lastTool");
  });

  it("under --follow, a line still being written waits for its newline", async () => {
    // A poll can land in the middle of a line the writer has not finished.
    // That line must not show as a parse error while it waits.
    const lastLine = envelope("s2", "toolCallStart", 1_000, { toolName: "slowTool" });
    fs.writeFileSync(file, bootLine + lastLine.slice(0, 30));
    const input = new ScriptedInput([]);
    const out = new FrameRecorder();
    input.feedKey({ key: "2" });
    const done = runViewer({
      followPath: file,
      initialFollow: true,
      followIntervalMs: 20,
      input,
      output: out,
      viewport: { rows: 20, cols: 100 },
    });
    await until(() => out.frames.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(out.lastText()).not.toContain("parse error");
    fs.appendFileSync(file, lastLine.slice(30));
    await until(() => out.lastText().includes("slowTool"));
    input.feedKey({ key: "q" });
    await done;
    expect(out.lastText()).toContain("slowTool");
    expect(out.lastText()).not.toContain("parse error");
  });
});

describe("makeFollowWatcher", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "follow-watcher-"));
    file = path.join(dir, "statelog.jsonl");
    fs.writeFileSync(file, bootLine);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses only what was appended and keeps the events it already had", async () => {
    const watcher = makeFollowWatcher({
      followPath: file,
      followIntervalMs: 20,
      input: new ScriptedInput([]),
      output: new FrameRecorder(),
      viewport: { rows: 20, cols: 100 },
    });
    expect(watcher.boot.events).toHaveLength(1);
    const logs: ParseResult[] = [];
    watcher.start((log) => logs.push(log));
    try {
      fs.appendFileSync(file, toolLines("s2", "appended", 1_000));
      await until(() => logs.length > 0);
    } finally {
      watcher.stop();
    }
    expect(logs[0].events.map((event) => event.data.type)).toEqual([
      "agentStart",
      "toolCallStart",
      "toolCall",
    ]);
    // The same object, not a parse of the same line again.
    expect(logs[0].events[0]).toBe(watcher.boot.events[0]);
  });

  it("numbers a parse error by its line in the file across polls", async () => {
    const watcher = makeFollowWatcher({
      followPath: file,
      followIntervalMs: 20,
      input: new ScriptedInput([]),
      output: new FrameRecorder(),
      viewport: { rows: 20, cols: 100 },
    });
    const logs: ParseResult[] = [];
    watcher.start((log) => logs.push(log));
    try {
      fs.appendFileSync(file, toolLines("s2", "first", 1_000) + "not json\n");
      await until(() => logs.length > 0);
    } finally {
      watcher.stop();
    }
    expect(logs.at(-1)!.errors).toEqual([expect.objectContaining({ line: 4 })]);
  });
});

describe("follow mode with a trace asked for by id", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "follow-trace-id-"));
    file = path.join(dir, "statelog.jsonl");
    fs.writeFileSync(file, bootLine);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a unique prefix once the trace arrives", async () => {
    const input = new ScriptedInput([]);
    const out = new FrameRecorder();
    const done = runViewer({
      followPath: file,
      followIntervalMs: 20,
      initialFollow: true,
      focusTraceId: "sec",
      input,
      output: out,
      viewport: { rows: 20, cols: 100 },
    });
    fs.appendFileSync(
      file,
      toolLines("new-trace-tool", "arrived", 1000).replaceAll(
        '"trace_id":"abc"',
        '"trace_id":"second"',
      ),
    );
    await until(() => out.frames.length > 0 && out.lastText().includes("trace 2/2"));
    input.feedKey({ key: "2" });
    await until(() => out.lastText().includes("arrived"));
    input.feedKey({ key: "q" });
    await done;
    expect(out.lastText()).toContain("arrived");
  });

  it("waits for a trace that has not started yet and focuses it when it arrives", async () => {
    const input = new ScriptedInput([]);
    const out = new FrameRecorder();
    const done = runViewer({
      followPath: file,
      followIntervalMs: 20,
      initialFollow: true,
      focusTraceId: "second",
      input,
      output: out,
      viewport: { rows: 20, cols: 100 },
    });
    // A poll with nothing new for the waited-for trace must not jump away.
    fs.appendFileSync(file, toolLines("s2", "firstTool", 500));
    await until(() => out.frames.length > 0 && out.lastText().includes("firstTool"), 500).catch(
      () => {},
    );
    expect(out.lastText()).toContain("second");
    fs.appendFileSync(
      file,
      toolLines("new-trace-tool", "arrived", 1000).replaceAll(
        '"trace_id":"abc"',
        '"trace_id":"second"',
      ),
    );
    await until(() => out.frames.length > 0 && out.lastText().includes("trace 2/2"));
    input.feedKey({ key: "q" });
    await done;
    expect(out.lastText()).toContain("second");
    expect(out.lastText()).toContain("trace 2/2");
  });
});

describe("follow mode and comments", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "follow-comments-"));
    file = path.join(dir, "run.jsonl");
    fs.writeFileSync(file, bootLine + toolLines("s2", "firstTool", 1_000));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a comment added from another terminal appears on the next tick, with no log growth", async () => {
    const sidecar = commentsPathFor({ kind: "file", path: file });
    const viewerStore = openCommentsStore(sidecar, { kind: "human", id: "adit" });
    const input = new ScriptedInput([]);
    const out = new FrameRecorder();
    const done = runViewer({
      followPath: file,
      followIntervalMs: 20,
      initialFollow: true,
      comments: viewerStore,
      input,
      output: out,
      viewport: { rows: 20, cols: 100 },
    });
    input.feedKey({ key: "2" });
    await until(() => out.frames.length > 0 && out.lastText().includes("[2 trace]"));
    expect(out.lastText()).not.toContain("✎");

    const otherTerminal = openCommentsStore(sidecar, { kind: "agent", id: "claude" });
    otherTerminal.add({ traceId: "abc", rowId: "s2", anchor: {}, text: "noted" });
    const person = openCommentsStore(sidecar, { kind: "human", id: "adit" });
    person.add({ traceId: "abc", rowId: "s2", anchor: {}, text: "seen" });
    await until(() => out.lastText().includes("✎"));
    input.feedKey({ key: "q" });
    await done;
    expect(out.lastText()).toContain("✎");
  });
});
