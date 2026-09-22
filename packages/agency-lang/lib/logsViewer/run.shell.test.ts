import { ScreenHost } from "./screenHost.js";
import { PlaceholderScreen } from "./screens/placeholderScreen.js";
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
  return text.split("\n").find((line) => line.trimStart().startsWith("> ")) ?? "";
}
describe("the viewer shell", () => {
  it("number keys switch screens and the tab strip says where you are", async () => {
    const out = await drive(["4", "2"]);
    const frames = texts(out);
    expect(frames.some((frame) => frame.includes("[4 timeline]"))).toBe(true);
    expect(out.lastText()).toContain("[2 trace]");
  });

  it("the focus travels: a call selected in the timeline is revealed in the trace", async () => {
    const out = await drive(["4", "j", "2"]); // the timeline's second row is the llm call
    expect(cursorLine(out.lastText())).toMatch(/llmCall/);
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
    expect(out.lastText()).toContain("TRACES · 2");
  });

  it("dismissing the picker leaves the most recent trace showing", async () => {
    const out = await driveJsonl(twoTraceSample, [esc]);
    expect(out.lastText()).not.toContain("TRACES");
    expect(out.lastText()).toContain("[1 overview]");
    expect(out.lastText()).toContain("trace 2/2 · t traces");
  });

  it("a log with one trace opens on its overview", async () => {
    const out = await drive([]);
    expect(out.lastText()).not.toContain("TRACES");
    expect(out.lastText()).toContain("[1 overview]");
  });

  it("a time bar opens its occurrences, and Esc returns to the overview", async () => {
    const out = await drive([enter, esc]);
    const frames = texts(out);
    expect(frames[frames.length - 2]).toContain("OCCURRENCES");
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
    const out = await driveJsonl(twoTraceSample, [esc, "<"]);
    expect(out.lastText()).toContain("trace 1/2");
  });

  it("choosing a trace in the picker switches to it and closes the picker", async () => {
    const out = await driveJsonl(twoTraceSample, ["k", enter]);
    expect(out.lastText()).toContain("trace 1/2");
    expect(out.lastText()).not.toContain("TRACES");
  });

  it("t reopens the picker after it has been dismissed", async () => {
    const out = await driveJsonl(twoTraceSample, [esc, "t"]);
    expect(out.lastText()).toContain("TRACES · 2");
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

  it("Esc in the picker clears the search before it closes the picker", async () => {
    const out = await driveJsonl(twoTraceSample, ["/", "z", enter, esc, esc]);
    const frames = texts(out);
    expect(frames[frames.length - 2]).toContain("TRACES · 2"); // search cleared, picker still open
    expect(out.lastText()).not.toContain("TRACES");
  });

  it("? shows the ACTIVE view's help and any key closes it", async () => {
    const out = await drive(["4", "?", "x"]);
    const help = texts(out).find((t) => t.includes("Keybindings"))!;
    expect(help).toContain("drill");
    expect(out.lastText()).toContain("TIMELINE [timeline]");
  });

  it("Ctrl+F pages — it must not toggle follow", async () => {
    const out = await drive([{ key: "f", ctrl: true }]);
    expect(texts(out).join("\n")).not.toContain("follow unavailable");
  });

  it("f without a followPath reports rather than toggling", async () => {
    const out = await drive(["f"]);
    expect(texts(out).join("\n")).toContain("follow unavailable");
  });

  it("promptLine round-trip drives tree search", async () => {
    const out = new FrameRecorder();
    const input = new ScriptedInput(["2", "/", "q"]);
    input.feedLine("agentRun");
    await runViewer({
      jsonl: sample,
      input,
      output: out,
      viewport: { rows: 20, cols: 120 },
    });
    expect(out.lastText()).toContain("match 1/");
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
  expect(texts(out).some((frame) => frame.includes("DETAIL"))).toBe(true);
  expect(out.lastText()).not.toContain("DETAIL");
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
  expect(out.lastText()).toContain("48 context (31 cached, 0 write) / 9 out");
  expect(out.lastText()).not.toContain("first answer");
});
it("number keys leave an open detail overlay in place", async () => {
  const out = await drive(["4", "d", "2"]);
  expect(out.lastText()).toContain("DETAIL");
  expect(out.lastText()).toContain("[4 timeline]");
});

it("the shell table gives each command one owner", () => {
  const host = new ScreenHost(
    {
      overview: new PlaceholderScreen("overview", ""),
      trace: new PlaceholderScreen("trace", ""),
      transcript: new PlaceholderScreen("transcript", ""),
      timeline: new PlaceholderScreen("timeline", ""),
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
it("legacy trace navigation stays in the trace named by the header", async () => {
  const out = await driveJsonl(twoTraceSample, [esc, "2", "g"]);
  expect(out.lastText()).toContain("trace 2/2");
  expect(cursorLine(out.lastText())).toContain("[def]");
  expect(out.lastText()).not.toContain("[abc]");
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
