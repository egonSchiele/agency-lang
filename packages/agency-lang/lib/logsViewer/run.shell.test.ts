import { readFileSync } from "node:fs";
import { ScreenHost } from "./screenHost.js";
import { TranscriptScreen } from "./screens/transcriptScreen.js";
import { TraceScreen } from "./screens/traceScreen.js";
import { OverviewScreen } from "./screens/overviewScreen.js";
import { TimelineScreen } from "./screens/timelineScreen.js";
import { DEFAULT_THRESHOLDS } from "./thresholds.js";
import { duplicateKeys } from "./keymap.js";
// Shell-level behavior: the view stack, action dispatch, help overlay,
// and the key routing that must NOT misfire (Ctrl+F pages; it is not `f`).
import { describe, expect, it } from "vitest";

import { ScriptedInput } from "../tui/input/scripted.js";
import { FrameRecorder } from "../tui/output/recorder.js";
import { runViewer, viewerShellBindings } from "./run.js";

const events = [
  { type: "agentStart", timestamp: "2026-05-16T00:00:00.000Z", entryNode: "main" },
  {
    type: "threadCreated",
    timestamp: "2026-05-16T00:00:00.100Z",
    threadId: "1",
    label: "mainThread",
  },
  { type: "promptStart", timestamp: "2026-05-16T00:00:00.200Z", model: '"m1"', threadId: "1" },
  {
    type: "promptCompletion",
    timestamp: "2026-05-16T00:00:01.000Z",
    model: '"m1"',
    threadId: "1",
    timeTaken: 800,
    usage: { inputTokens: 10, outputTokens: 2 },
    cost: { totalCost: 0.01 },
    messages: [{ role: "user", content: "add two numbers" }],
    completion: { output: "3" },
  },
  { type: "agentEnd", timestamp: "2026-05-16T00:00:02.000Z", timeTaken: 2000 },
].map((data, i) =>
  JSON.stringify({
    format_version: 1,
    trace_id: "abc",
    project_id: "p",
    span_id: data.type.startsWith("prompt") ? "s2" : "s1",
    parent_span_id: data.type.startsWith("prompt") ? "s1" : null,
    data,
  }),
);

const sample = events.join("\n") + "\n";

it("merges partial threshold overrides with the defaults", async () => {
  const output = new FrameRecorder();
  await runViewer({
    jsonl: sample,
    input: new ScriptedInput(["2", "q"]),
    output,
    viewport: { rows: 20, cols: 120 },
    thresholds: { expensiveUsd: 0.005 },
  });
  const frames = texts(output).join("\n");
  expect(frames).toContain("$0.010!");
  expect(frames).not.toContain("800ms!");
});

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

const esc = { key: "escape" };
const enter = { key: "enter" };
const twoTraceSample =
  sample +
  events
    .map((text) => {
      const event = JSON.parse(text);
      event.trace_id = "def";
      event.span_id = `second-${event.span_id}`;
      if (event.parent_span_id !== null) {
        event.parent_span_id = `second-${event.parent_span_id}`;
      }
      event.data.timestamp = new Date(Date.parse(event.data.timestamp) + 3600000).toISOString();
      return JSON.stringify(event);
    })
    .join("\n") +
  "\n";
async function driveJsonl(
  jsonl: string,
  keys: (string | { key: string; ctrl?: boolean })[],
): Promise<FrameRecorder> {
  const output = new FrameRecorder();
  await runViewer({
    jsonl,
    input: new ScriptedInput([...keys, "q"]),
    output,
    viewport: { rows: 20, cols: 130 },
  });
  return output;
}
async function driveEmbedded(keys: (string | { key: string })[]) {
  return runViewer({
    jsonl: sample,
    input: new ScriptedInput(keys),
    output: new FrameRecorder(),
    viewport: { rows: 20, cols: 120 },
    embedded: true,
  });
}
function cursorLine(text: string): string {
  return (
    text
      .split("\n")
      .find(
        (line) => line.trimStart().startsWith("▶ ") && !line.trimStart().startsWith("▶ OUTLINE ·"),
      ) ?? ""
  );
}

describe("traces list navigation", () => {
  it("combines the hints and page title on the bottom row", async () => {
    const out = await driveJsonl(twoTraceSample, []);
    const lines = out.lastText().split("\n");
    const footer = lines.at(-1)!;
    expect(lines).toHaveLength(20);
    expect(footer).toContain("j k move   ⏎ open   / search");
    expect(footer).toContain("esc back   q quit   ? help   f follow");
    expect(footer).toMatch(/\[TRACES\]$/);
    expect(footer).toHaveLength(130);
    expect(lines.slice(0, -1).join("\n")).not.toContain("TRACES");
    expect(lines.slice(0, -1).join("\n")).not.toContain("j k move");
  });

  it("keeps the footer at the bottom when the log has a parse error", async () => {
    const out = await driveJsonl(`${twoTraceSample}{broken json\n`, []);
    const lines = out.lastText().split("\n");
    expect(lines).toHaveLength(20);
    expect(lines.slice(0, -1).join("\n")).toContain("1 parse error(s)");
    expect(lines.at(-1)).toMatch(/\[TRACES\]$/);
  });

  it.each([
    ["1", "OVERVIEW"],
    ["2", "TRACE"],
    ["3", "TRANSCRIPT"],
    ["4", "TIMELINE"],
  ])("keeps the %s page title at bottom right", async (key, title) => {
    const out = await drive([key]);
    const lines = out.lastText().split("\n");
    expect(lines).toHaveLength(20);
    expect(lines.at(-1)).toHaveLength(120);
    expect(lines.at(-1)?.endsWith(`[${title}]`)).toBe(true);
    expect(lines.at(-1)).toContain("? help");
    expect(lines.slice(0, -1).join("\n")).not.toMatch(new RegExp(`^${title}(?: |$)`, "m"));
  });

  it.each([[["2", "d"], "DETAIL"]])(
    "gives overlays the same footer layout (%s)",
    async (keys, title) => {
      const out = await drive(keys as (string | { key: string })[]);
      const lines = out.lastText().split("\n");
      expect(lines).toHaveLength(20);
      expect(lines.at(-1)).toHaveLength(120);
      expect(lines.at(-1)?.endsWith(`[${title}]`)).toBe(true);
      expect(lines.at(-1)).toContain("? help");
    },
  );

  it("shows the highlighted trace in the header as the cursor moves", async () => {
    const out = await driveJsonl(twoTraceSample, [{ key: "up" }, { key: "down" }]);
    const headers = texts(out).map((frame) => frame.split("\n")[0]);
    expect(headers[0]).toContain("def  trace 2/2");
    expect(headers[1]).toContain("abc  trace 1/2");
    expect(headers[2]).toContain("def  trace 2/2");
    expect(texts(out).join("\n")).not.toContain("●");
    expect(headers.every((header) => !/\[[1-4] /.test(header))).toBe(true);
  });

  it.each([
    ["1", "overview"],
    ["2", "trace"],
    ["3", "transcript"],
    ["4", "timeline"],
  ])("%s opens the highlighted trace's %s", async (key, name) => {
    const out = await driveJsonl(twoTraceSample, ["k", key]);
    expect(out.lastText()).not.toContain("TRACES ·");
    expect(out.lastText()).toContain(`[${key} ${name}]`);
    expect(out.lastText().split("\n")[0]).toContain("abc  trace 1/2");
  });

  it("updates the header when search changes the highlighted trace", async () => {
    const out = await driveJsonl(twoTraceSample, ["k", "/", "0", "1", ":", "0", "0", enter]);
    expect(out.lastText()).toContain("1 of 2 match");
    expect(out.lastText().split("\n")[0]).toContain("def  trace 2/2");
  });

  it("shows no stale trace or active tab when a search has no matches", async () => {
    const out = await driveJsonl(twoTraceSample, ["/", "~", enter, "2", enter]);
    const header = out.lastText().split("\n")[0];
    expect(out.lastText()).toContain("0 of 2 match");
    expect(header).not.toContain("def");
    expect(header).not.toMatch(/trace \d+\/2/);
    expect(header).not.toMatch(/\[[1-4] /);
  });

  it("puts the traces shortcut in the footer of an opened trace", async () => {
    const out = await driveJsonl(twoTraceSample, [enter]);
    const lines = out.lastText().trimEnd().split("\n");
    expect(lines[0]).not.toContain("t traces");
    expect(lines.at(-1)).toContain("t traces");
  });

  it("backs out through overview to the list with the same trace highlighted", async () => {
    const out = await driveJsonl(twoTraceSample, ["k", "4", esc, esc, esc, enter]);
    const frames = texts(out);
    expect(frames[3]).toContain("[1 overview]");
    expect(frames[4]).toContain("[TRACES]");
    expect(frames[4].split("\n")[0]).toContain("abc  trace 1/2");
    expect(frames[5]).toContain("[TRACES]");
    expect(out.lastText()).toContain("[1 overview]");
    expect(out.lastText()).toContain("abc  trace 1/2");
  });

  it("opens overview with Enter even when the picker was opened from another tab", async () => {
    const out = await driveJsonl(twoTraceSample, ["4", "t", "k", enter]);
    expect(out.lastText()).toContain("[1 overview]");
    expect(out.lastText()).toContain("abc  trace 1/2");
  });

  it("returns to the embedding app after backing out to the traces list", async () => {
    const out = new FrameRecorder();
    const resolution = await runViewer({
      jsonl: twoTraceSample,
      input: new ScriptedInput([enter, esc, esc, "q"]),
      output: out,
      viewport: { rows: 20, cols: 130 },
      embedded: true,
    });
    expect(resolution).toBe("back");
    expect(texts(out).filter((frame) => frame.includes("[TRACES]"))).toHaveLength(2);
  });
});

describe("the viewer shell", () => {
  it("number keys switch screens and the tab strip says where you are", async () => {
    const out = await drive(["4", "2"]);
    const frames = texts(out);
    expect(frames.some((frame) => frame.includes("[4 timeline]"))).toBe(true);
    expect(out.lastText()).toContain("[2 trace]");
  });

  it("the focus travels: a call selected in the timeline is revealed in the trace", async () => {
    const out = await drive(["4", "j", "2"]); // the timeline's second row is the llm call
    expect(cursorLine(out.lastText())).toMatch(/LLM call\s+1/);
  });

  it("Esc walks the ladder: overlay, then screen state, then home, then nothing", async () => {
    const out = await drive(["4", "d", esc, esc, esc, esc]);
    const frames = texts(out);
    const afterFirstEsc = frames[frames.length - 4];
    expect(afterFirstEsc).toContain("[4 timeline]"); // the detail overlay closed
    expect(out.lastText()).toContain("[1 overview]"); // home, and Esc there changed nothing
  });

  it("embedded: Esc on the overview resolves back", async () => {
    const resolution = await driveEmbedded(["1", esc]);
    expect(resolution).toBe("back");
  });

  it("standalone: Esc never ends the session", async () => {
    const resolution = await runViewer({
      jsonl: sample,
      input: new ScriptedInput(["1", esc, esc, esc, "q"]),
      output: new FrameRecorder(),
      viewport: { rows: 20, cols: 120 },
    });
    expect(resolution).toBe("quit");
  });

  it("below 100 columns it says so, and q still quits", async () => {
    const out = new FrameRecorder();
    await runViewer({
      jsonl: sample,
      input: new ScriptedInput(["q"]),
      output: out,
      viewport: { rows: 20, cols: 78 },
    });
    expect(out.lastText()).toContain("This viewer wants 100 columns; this terminal has 78.");
  });

  it("below 100 columns, embedded, Esc still returns to the host", async () => {
    const resolution = await runViewer({
      jsonl: sample,
      input: new ScriptedInput([esc]),
      output: new FrameRecorder(),
      viewport: { rows: 20, cols: 78 },
      embedded: true,
    });
    expect(resolution).toBe("back");
  });

  it("opens on the trace picker when the log holds several traces", async () => {
    const out = await driveJsonl(twoTraceSample, []);
    expect(out.lastText()).toContain("[TRACES]");
  });

  it("Esc stays on the traces list when there is nothing left to clear", async () => {
    const out = await driveJsonl(twoTraceSample, [esc, esc]);
    expect(out.lastText()).toContain("[TRACES]");
    expect(out.lastText()).not.toContain("[1 overview]");
  });

  it("a log with one trace opens on its overview", async () => {
    const out = await drive([]);
    expect(out.lastText()).not.toContain("TRACES");
    expect(out.lastText()).toContain("[1 overview]");
  });

  it("the selected LLM call opens in trace, and Esc returns to overview", async () => {
    const out = await drive([enter, esc]);
    const frames = texts(out);
    expect(frames[frames.length - 2]).toContain("[2 trace]");
    expect(out.lastText()).toContain("[1 overview]");
  });

  it("a trace asked for by id opens on it, with no picker in the way", async () => {
    const out = new FrameRecorder();
    await runViewer({
      jsonl: twoTraceSample,
      input: new ScriptedInput(["q"]),
      output: out,
      viewport: { rows: 20, cols: 120 },
      focusTraceId: "abc",
    });
    expect(out.lastText()).not.toContain("TRACES");
    expect(out.lastText()).toContain("[1 overview]");
    expect(out.lastText()).toContain("trace 1/2");
  });

  it("< and > step between traces", async () => {
    const out = await driveJsonl(twoTraceSample, [enter, "<"]);
    expect(out.lastText()).toContain("trace 1/2");
  });

  it("choosing a trace in the picker switches to it and closes the picker", async () => {
    const out = await driveJsonl(twoTraceSample, ["k", enter]);
    expect(out.lastText()).toContain("trace 1/2");
    expect(out.lastText()).not.toContain("TRACES");
  });

  it("t reopens the picker after opening a trace", async () => {
    const out = await driveJsonl(twoTraceSample, [enter, "t"]);
    expect(out.lastText()).toContain("[TRACES]");
  });

  it("while the picker takes text, q is a letter and does not quit", async () => {
    const out = await driveJsonl(twoTraceSample, ["/", "q", esc, esc, "q"]);
    const frames = texts(out);
    expect(frames.some((frame) => frame.includes("/ q"))).toBe(true);
  });

  it("a search made in the picker arrives on the screen as its search", async () => {
    const out = await driveJsonl(twoTraceSample, [esc, "4", "t", "/", "a", "d", "d", enter, enter]);
    expect(out.lastText()).toContain("[2 trace]");
    expect(cursorLine(out.lastText())).toContain("add two numbers");
  });

  it("a boot-picker search opens its payload match in the trace", async () => {
    const out = await driveJsonl(twoTraceSample, ["/", "a", "d", "d", enter, enter, "n"]);
    expect(out.lastText()).toContain("[2 trace]");
    expect(out.lastText()).toContain("add two numbers");
  });

  it("Esc in the picker clears the search and then stays on the list", async () => {
    const out = await driveJsonl(twoTraceSample, ["/", "z", enter, esc, esc]);
    const frames = texts(out);
    expect(frames[frames.length - 2]).toContain("[TRACES]"); // search cleared, picker still open
    expect(out.lastText()).toContain("[TRACES]");
  });

  it("? shows the ACTIVE view's help and any key closes it", async () => {
    const out = await drive(["4", "?", "G", "x"]);
    const help = texts(out)
      .filter((text) => text.includes("Keybindings"))
      .at(-1)!;
    expect(help).toContain("drill");
    expect(out.lastText()).toContain("[TIMELINE]");
  });

  it("Ctrl+F pages — it must not toggle follow", async () => {
    const out = await drive([{ key: "f", ctrl: true }]);
    expect(texts(out).join("\n")).not.toContain("follow unavailable");
  });

  it("f without a followPath reports rather than toggling", async () => {
    const out = await drive(["f"]);
    expect(texts(out).join("\n")).toContain("follow unavailable");
  });

  it("promptLine round-trip filters the trace", async () => {
    const out = new FrameRecorder();
    const input = new ScriptedInput(["2", "/", "q"]);
    input.feedLine("add two numbers");
    await runViewer({
      jsonl: sample,
      input,
      output: out,
      viewport: { rows: 20, cols: 120 },
    });
    expect(out.lastText()).toContain("/add two numbers");
  });

  it("quit works from a timeline view", async () => {
    const out = await drive(["4"]);
    expect(out.frames.length).toBeGreaterThan(0);
  });
});

it("typing q f ? and digits never triggers shell commands", async () => {
  const out = await driveJsonl(twoTraceSample, ["/", "q", "f", "?", "1", "2", "3", "4", esc, esc]);
  expect(texts(out).some((frame) => frame.includes("/ qf?1234"))).toBe(true);
  expect(texts(out).join("\n")).not.toContain("Keybindings");
  expect(texts(out).join("\n")).not.toContain("follow unavailable");
});
it("2, d and Esc opens and closes detail on a real node", async () => {
  const out = await drive(["2", "d", esc]);
  expect(texts(out).some((frame) => frame.includes("[DETAIL]"))).toBe(true);
  expect(out.lastText()).not.toContain("[DETAIL]");
});

it("a second round opens its own answer and token counts in detail", async () => {
  const jsonl = [0, 1]
    .map((position) =>
      JSON.stringify({
        format_version: 1,
        trace_id: "T",
        project_id: "",
        span_id: "L",
        parent_span_id: null,
        data: {
          type: "promptCompletion",
          timestamp: new Date(1000 + position * 1000).toISOString(),
          timeTaken: 100,
          completion: { output: position === 0 ? "first answer" : "second answer" },
          usage: { inputTokens: 17, cachedInputTokens: 31, outputTokens: 9 },
        },
      }),
    )
    .join("\n");
  const out = await driveJsonl(jsonl, ["4", "j", "j", "d"]);
  expect(out.lastText()).toContain("second answer");
  expect(out.lastText()).toContain("context 48 (31 cached) · fresh 17 · out 9");
  expect(out.lastText()).not.toContain("first answer");
});
it("number keys leave an open detail overlay in place", async () => {
  const out = await drive(["4", "d", "2"]);
  expect(out.lastText()).toContain("[DETAIL]");
  expect(out.lastText()).toContain("[4 timeline]");
});

it("the shell table gives each command one owner", () => {
  const host = new ScreenHost(
    {
      overview: new OverviewScreen([], "T", () => undefined),
      trace: new TraceScreen([], "T", DEFAULT_THRESHOLDS, { extractEnabled: false }),
      transcript: new TranscriptScreen([], "T"),
      timeline: new TimelineScreen([], "T", DEFAULT_THRESHOLDS),
    },
    "trace",
    "T",
  );
  expect(
    duplicateKeys(
      viewerShellBindings(
        host,
        () => [],
        () => {},
        () => {},
      ),
    ),
  ).toEqual([]);
});
it("trace navigation stays in the trace named by the header", async () => {
  const out = await driveJsonl(twoTraceSample, [esc, "2", "g"]);
  expect(out.lastText()).toContain("trace 2/2");
  expect(out.lastText()).toContain("[TRACE]");
  expect(out.lastText()).not.toContain("[abc]");
});

it.each([
  ["2", "3"],
  ["3", "4"],
  ["4", "2"],
  ["2", "1"],
  ["3", "2"],
])("round focus survives %s → %s and back", async (from, to) => {
  const jsonl = readFileSync(new URL("./fixtures/handler-chain.jsonl", import.meta.url), "utf8");
  const out = await driveJsonl(jsonl, ["2", "G", "k", "k", from, to, from]);
  expect(cursorLine(out.lastText())).toMatch(/LLM call\s+9/);
});

it("shell help includes quit, back, and numbered screens without duplicate ownership", async () => {
  const out = await drive(["3", "?"]);
  expect(out.lastText()).toContain("Escape");
  expect(out.lastText()).toContain("Ctrl+C");
  expect(out.lastText()).toContain("1 — overview");
  expect(out.lastText()).toContain("3 — transcript");
});

it("help paging reaches screen bindings and Escape closes it", async () => {
  const out = await drive(["3", "?", "G", esc]);
  const help = texts(out)
    .filter((text) => text.includes("Keybindings"))
    .at(-1)!;
  expect(help).toContain("copy full block text");
  expect(help).toContain("system prompt");
  expect(out.lastText()).toContain("TRANSCRIPT");
});

it("embedded focused traces return to their host on the first Esc", async () => {
  const output = new FrameRecorder();
  const resolution = await runViewer({
    jsonl: sample,
    input: new ScriptedInput([esc, "q"]),
    output,
    viewport: { rows: 20, cols: 120 },
    embedded: true,
    focusTraceId: "abc",
  });
  expect(resolution).toBe("back");
  expect(texts(output).join("\n")).not.toContain("The overview lands");
});
