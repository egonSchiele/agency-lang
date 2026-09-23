import { describe, expect, it } from "vitest";
import { parseStyledText } from "../../tui/styleParser.js";
import { THEME } from "../theme.js";
import { FrameRecorder } from "../../tui/output/recorder.js";
import { layout } from "../../tui/layout.js";
import { render } from "../../tui/render/renderer.js";
import { DEFAULT_THRESHOLDS } from "../thresholds.js";
import { walkNodes } from "../forest.js";
import { outlineRows } from "../story.js";
import { agentLoopTrace, event, loopEvents, sampleRunForest } from "../storyFixture.js";
import { buildForest } from "../tree.js";
import { TraceScreen } from "./traceScreen.js";
const viewport = { rows: 40, cols: 140 };
function make(roots = sampleRunForest()) {
  return new TraceScreen(roots, roots[0].traceId, DEFAULT_THRESHOLDS, { extractEnabled: true });
}
function press(screen: TraceScreen, key: string) {
  return screen.handleKey({ key }, viewport);
}
function text(screen: TraceScreen, cols = 140, rows = 40) {
  const recorder = new FrameRecorder();
  recorder.write(render(layout(screen.render({ rows, cols }), cols, rows)));
  return recorder.lastText();
}
describe("trace screen", () => {
  it("fits all ten recorded rounds and four rejected interrupts on one screen", () => {
    const output = text(make());
    expect(output.match(/LLM call\s+\d+/g)).toHaveLength(10);
    expect(output.match(/⚠ std::grep\s+rejected/g)).toHaveLength(4);
    const lines = output.split("\n").filter((line) => /LLM call\s+\d/.test(line));
    const positions = lines.map((line) => line.indexOf("$"));
    expect(positions.every((position) => position === positions[0])).toBe(true);
  });
  it("moves the payload with the cursor and carries the tool from its interrupt", () => {
    const screen = make([agentLoopTrace()]);
    press(screen, "p");
    press(screen, "j");
    press(screen, "j");
    expect(text(screen)).toContain("TOOL · agencyGuide");
    press(screen, "j");
    expect(screen.focusId()).toBe("guide");
    expect(press(screen, "d")).toEqual({
      kind: "openDetail",
      rowId: "leaf:guide:interruptResolved:0",
    });
  });
  it("preserves literal style tags and highlighted Agency braces", () => {
    const roots = buildForest([
      event("promptCompletion", 1000, "L", null, {
        completion: {
          output: JSON.stringify({ response: { code: "def f(): number {\n  return 1\n}" } }),
        },
      }),
    ]);
    const screen = make(roots);
    expect(text(screen)).toContain("def f(): number {");
    roots[0].children[0].children[0].event!.data.completion.output = "{bold} and {red-fg}";
    screen.setData(roots);
    expect(text(screen)).toContain("{bold} and {red-fg}");
  });
  it("marks hot metrics and exposes every forest node with m and a", () => {
    const screen = make();
    press(screen, "j");
    const id = screen.focusId();
    press(screen, "m");
    expect(screen.focusId()).toBe(id);
    expect(text(screen)).toContain("toolCallStart");
    press(screen, "a");
    expect(screen.rowCount()).toBe(walkNodes(sampleRunForest()[0]).length - 1);
    const slow = make(
      buildForest([event("promptCompletion", 360000, "L", null, { timeTaken: 360000 })]),
    );
    expect(text(slow)).toContain("360.0s!");
  });
  it("keeps an LLM group selected while showing its summary or raw events", () => {
    const roots = buildForest([
      event("toolCallStart", 0, "research", null, { toolName: "researchAgent" }),
      event("promptCompletion", 1000, "calls", "research", {
        threadIdentity: "thread-main",
        threadLabel: "main",
        model: "test-model",
        completion: { output: "research result" },
      }),
    ]);
    const screen = make(roots);
    screen.setFocus("calls");
    press(screen, "enter");
    expect(screen.focusId()).toBe("calls");
    expect(text(screen)).toContain("Thread · main");
    expect(text(screen)).toContain("Thread: main");
    expect(text(screen)).toContain("research result");
    expect(text(screen)).not.toContain("subagent main");
    press(screen, "r");
    expect(text(screen)).toContain('"promptCompletion"');
    press(screen, "r");
    press(screen, "enter");
    expect(screen.focusId()).toBe("calls");
    expect(text(screen)).toContain("Thread · main");
    expect(text(screen)).not.toContain("LLM call  1");
  });
  it("error filters retain rejected tools and their asking rounds", () => {
    const screen = make([agentLoopTrace()]);
    press(screen, "F");
    const output = text(screen);
    expect(output).toMatch(/LLM call\s+2/);
    expect(output).toContain("✖ grep");
    expect(output).not.toMatch(/LLM call\s+1\b/);
    expect(screen.escape()).toBe(true);
    expect(screen.escape()).toBe(false);
  });
  it("escapes pane focus, then the filter, then nothing", () => {
    const screen = make();
    press(screen, "tab");
    press(screen, "F");
    expect([screen.escape(), screen.escape(), screen.escape()]).toEqual([true, true, false]);
  });
  it("searches full payloads, retains ancestors and cycles matches", () => {
    const screen = make([agentLoopTrace()]);
    screen.applySearch("Search?");
    expect(text(screen)).toMatch(/LLM call\s+2/);
    expect(text(screen)).toContain("grep");
    press(screen, "n");
    press(screen, "n");
    expect(press(screen, "d")).toEqual({
      kind: "openDetail",
      rowId: "leaf:grep:interruptResolved:0",
    });
    expect(screen.focusId()).toBe("grep");
    screen.applySearch("no such content");
    expect(text(screen)).toContain("No matching rows");
  });
  it("collapse, machinery and focus transitions keep stable row identities", () => {
    const screen = make([agentLoopTrace()]);
    press(screen, "p");
    screen.setFocus("round:L:0");
    press(screen, "enter");
    expect(text(screen)).not.toContain("⚠ std::read");
    screen.setFocus("guide");
    expect(text(screen)).toContain("⚠ std::read");
    press(screen, "m");
    expect(screen.focusId()).toBe("guide");
    press(screen, "m");
    expect(screen.focusId()).toBe("guide");
    screen.setFocus("L");
    expect(screen.focusId()).toBe("round:L:0");
  });
  it("follow replaces unfinished status and retains the cursor through leaf renumbering", () => {
    const events = [
      event("promptStart", 0, "L"),
      event("toolCallStart", 100, "tool", "L", { toolName: "read" }),
    ];
    const screen = make(buildForest(events));
    screen.setFocus("tool");
    expect(text(screen)).toContain("completion not recorded");
    events.push(
      event("promptCompletion", 90, "L"),
      event("toolCall", 200, "tool", "L", { toolName: "read", timeTaken: 100, output: "result" }),
    );
    screen.setData(buildForest(events));
    expect(screen.focusId()).toBe("tool");
    expect(text(screen)).toContain("completed");
    screen.setData(buildForest(loopEvents()));
    expect(screen.focusId()).toBeDefined();
  });
  it("supports raw, copy and extraction actions and half page movement", () => {
    const screen = make();
    const copied = press(screen, "y");
    expect(copied.kind).toBe("copy");
    press(screen, "r");
    expect(text(screen)).toContain('"format_version"');
    expect(press(screen, "Y")).toEqual({
      kind: "copyTrace",
      traceId: sampleRunForest()[0].traceId,
    });
    expect(press(screen, "x").kind).toBe("extractTrace");
    const before = screen.focusId();
    screen.handleKey({ key: "d", ctrl: true }, { rows: 12, cols: 140 });
    const half = screen.focusId();
    press(screen, "g");
    screen.handleKey({ key: "f", ctrl: true }, { rows: 12, cols: 140 });
    expect(screen.focusId()).not.toBe(half);
    expect(half).not.toBe(before);
  });
  it.each([100, 130, 200])("renders the recorded trace at %i columns", (cols) => {
    const screen = make();
    screen.setFocus(
      outlineRows(sampleRunForest()[0], { machinery: false, admin: false })
        .filter((row) => row.kind === "round")
        .at(-1)!.id,
    );
    const recorder = new FrameRecorder();
    recorder.write(render(layout(screen.render({ rows: 40, cols }), cols, 40)));
    expect(recorder.lastText()).toMatchSnapshot();
    press(screen, "#");
    recorder.write(render(layout(screen.render({ rows: 40, cols }), cols, 40)));
    expect(recorder.lastText()).toMatchSnapshot();
    recorder.writeHTML(`/tmp/pr6-trace-${cols}.html`);
  });
});

it("limits searches and follow navigation to the selected trace", () => {
  const roots = buildForest([
    {
      ...event("promptCompletion", 100, "A"),
      trace_id: "A",
      data: {
        type: "promptCompletion",
        timestamp: new Date(100).toISOString(),
        completion: { output: "alpha" },
      },
    },
    {
      ...event("promptCompletion", 200, "B"),
      trace_id: "B",
      data: {
        type: "promptCompletion",
        timestamp: new Date(200).toISOString(),
        completion: { output: "beta" },
      },
    },
  ]);
  const screen = new TraceScreen(roots, "B", DEFAULT_THRESHOLDS, { extractEnabled: false });
  const search = press(screen, "/");
  if (search.kind !== "promptLine") {
    throw new Error("prompt expected");
  }
  search.onResult("alpha");
  expect(text(screen)).toContain("No matching rows");
  expect(text(screen)).not.toContain("ASSISTANT");
  screen.setTrace("A");
  expect(text(screen)).toContain("alpha");
  expect(screen.escape()).toBe(false);
  screen.setFocus("round:B:0");
  expect(screen.focusId()).toBe("round:A:0");
  screen.setData(roots);
  press(screen, "G");
  expect(screen.focusId()).toBe("round:A:0");
  screen.setData([]);
  expect(screen.focusId()).toBeUndefined();
  expect(press(screen, "x")).toEqual({ kind: "none" });
});

it("payload paging leaves the outline focus unchanged and help has no duplicate keys", () => {
  const screen = make();
  press(screen, "r");
  press(screen, "tab");
  const before = text(screen);
  const id = screen.focusId();
  screen.handleKey({ key: "d", ctrl: true }, { rows: 12, cols: 140 });
  const half = text(screen);
  expect(half).not.toBe(before);
  expect(screen.focusId()).toBe(id);
  press(screen, "g");
  screen.handleKey({ key: "f", ctrl: true }, { rows: 12, cols: 140 });
  expect(text(screen)).not.toBe(half);
  const keys = screen.helpLines().flatMap((line) => line.split(" — ")[0].split(" / "));
  expect(keys.filter((key, position) => keys.indexOf(key) !== position)).toEqual([]);
});

it("only shares round, tool or subagent ancestors from machinery rows", () => {
  const screen = make(buildForest([event("promptStart", 0, "L")]));
  press(screen, "m");
  screen.setFocus("leaf:L:promptStart:0");
  expect(screen.focusId()).toBeUndefined();
});

it("reveals an explicitly requested shared focus through an active filter", () => {
  const screen = make([agentLoopTrace()]);
  screen.applySearch("Search?");
  screen.setFocus("guide");
  expect(screen.focusId()).toBe("guide");
  expect(text(screen)).toContain("TOOL · agencyGuide");
});

it("previous match from a nonmatching ancestor selects the last match", () => {
  const screen = make([agentLoopTrace()]);
  screen.applySearch("Search?");
  screen.setFocus("round:L:1");
  press(screen, "N");
  expect(press(screen, "d")).toEqual({
    kind: "openDetail",
    rowId: "leaf:grep:interruptResolved:0",
  });
});

it("marks the pane that receives arrow keys and moves the cue with Tab and Escape", () => {
  const screen = make(
    buildForest([
      event("promptCompletion", 100, "L", null, {
        completion: {
          output: Array.from({ length: 80 }, (_, line) => `payload line ${line + 1}`).join("\n"),
        },
      }),
      event("promptCompletion", 200, "L", null, { completion: { output: "second answer" } }),
    ]),
  );
  screen.setFocus("round:L:0");
  const header = () => text(screen).split("\n")[0];
  const activeLabel = () =>
    parseStyledText(screen.render(viewport).children![0].content ?? "").find(
      (part) => part.bg === THEME.rule && part.text.includes("↑↓ scroll"),
    );
  expect(header()).toContain("▶ OUTLINE · ↑↓ scroll");
  expect(activeLabel()).toMatchObject({ fg: THEME.accent, bold: true });
  press(screen, "tab");
  expect(header()).toContain("▶ DETAILS · ↑↓ scroll");
  expect(header()).not.toContain("▶ OUTLINE");
  expect(activeLabel()?.text).toContain("DETAILS");
  const before = text(screen);
  press(screen, "down");
  expect(text(screen)).not.toBe(before);
  expect(screen.focusId()).toBe("round:L:0");
  screen.escape();
  expect(header()).toContain("▶ OUTLINE · ↑↓ scroll");
  press(screen, "down");
  expect(screen.focusId()).toBe("round:L:1");
});

it("Left and Right focus a pane directly, and Space pages the active pane", () => {
  const roots = buildForest(
    Array.from({ length: 60 }, (_, index) =>
      event("promptCompletion", index * 100, "L", null, {
        completion: { output: Array.from({ length: 90 }, (_, line) => `line ${line}`).join("\n") },
      }),
    ),
  );
  const screen = make(roots);
  const pageViewport = { rows: 12, cols: 140 };
  const frame = () => text(screen, 140, 12);
  const key = (key: string) => screen.handleKey({ key }, pageViewport);
  frame();
  key("right");
  expect(frame().split("\n")[0]).toContain("▶ DETAILS");
  const before = frame();
  key(" ");
  const paged = frame();
  expect(paged).not.toBe(before);
  expect(screen.focusId()).toBe("round:L:0");
  key("g");
  key("pagedown");
  expect(frame()).toBe(paged);
  key("right");
  expect(frame()).toBe(paged);
  key("left");
  key("left");
  expect(frame().split("\n")[0]).toContain("▶ OUTLINE");
  key("space");
  const next = screen.focusId();
  expect(next).not.toBe("round:L:0");
  key("g");
  key("pagedown");
  expect(screen.focusId()).toBe(next);
});

it("brackets skip descendants to visible siblings without leaving the parent", () => {
  const roots = buildForest([
    event("toolCallStart", 0, "research", null, { toolName: "researchAgent" }),
    event("promptCompletion", 100, "first", "research", { completion: { output: "first" } }),
    event("toolCallStart", 101, "nested", "first", { toolName: "read" }),
    event("promptCompletion", 200, "second", "research", { completion: { output: "second" } }),
    event("promptCompletion", 300, "third", "research", { completion: { output: "third" } }),
    event("toolCallStart", 400, "other", null, { toolName: "otherAgent" }),
    event("promptCompletion", 500, "outside", "other"),
  ]);
  const screen = make(roots);
  screen.setFocus("first");
  press(screen, "[");
  expect(screen.focusId()).toBe("first");
  press(screen, "]");
  expect(screen.focusId()).toBe("second");
  press(screen, "]");
  expect(screen.focusId()).toBe("third");
  press(screen, "]");
  expect(screen.focusId()).toBe("third");
  press(screen, "[");
  expect(screen.focusId()).toBe("second");
  press(screen, "right");
  press(screen, "[");
  expect(screen.focusId()).toBe("second");
  press(screen, "left");
  press(screen, "[");
  press(screen, "enter");
  press(screen, "]");
  expect(screen.focusId()).toBe("second");
  screen.applySearch("third");
  screen.setFocus("research");
  press(screen, "down");
  expect(screen.focusId()).toBe("third");
  press(screen, "[");
  expect(screen.focusId()).toBe("third");
  screen.applySearch("not found");
  press(screen, "]");
  expect(screen.focusId()).toBeUndefined();
});

it("toggles outline and detail line numbers without resetting them on scroll", () => {
  const roots = buildForest(
    Array.from({ length: 40 }, (_, index) =>
      event("promptCompletion", index * 100, "L", null, {
        completion: { output: Array.from({ length: 60 }, (_, line) => `body ${line}`).join("\n") },
      }),
    ),
  );
  const screen = make(roots);
  const vp = { rows: 12, cols: 140 };
  const frame = () => text(screen, vp.cols, vp.rows);
  const key = (key: string) => screen.handleKey({ key }, vp);
  const before = frame();
  key("#");
  expect(frame()).toMatch(/\n\s*1\s+▶ LLM call/);
  expect(frame()).toMatch(/│\s*1 ASSISTANT/);
  key("right");
  key("pagedown");
  expect(frame()).toMatch(/│\s*10 /);
  key("left");
  key("G");
  expect(frame()).toMatch(/\n\s*40\s+▶ LLM call/);
  screen.setData(roots);
  expect(frame()).toMatch(/\n\s*40\s+▶ LLM call/);
  key("g");
  key("#");
  expect(frame()).toBe(before);
});

it("hides successful approvals by default and reveals them with p or search", () => {
  const roots = buildForest([
    event("toolCallStart", 0, "tool", null, { toolName: "read" }),
    event("interruptResolved", 1, "tool", null, {
      interruptId: "ok",
      outcome: "approved",
      interrupt: { effect: "approved-only" },
    }),
    event("interruptResolved", 2, "tool", null, {
      interruptId: "no",
      outcome: "rejected",
      interrupt: { effect: "denied-only" },
    }),
    event("interruptThrown", 3, "tool", null, {
      interruptId: "wait",
      interrupt: { effect: "pending-only" },
    }),
  ]);
  const screen = make(roots);
  expect(text(screen)).not.toContain("approved-only");
  expect(text(screen)).toContain("denied-only");
  expect(text(screen)).toContain("pending-only");
  press(screen, "p");
  expect(text(screen)).toContain("approved-only");
  press(screen, "p");
  expect(text(screen)).not.toContain("approved-only");
  screen.applySearch("approved-only");
  expect(text(screen)).toContain("approved-only");
  screen.escape();
  expect(text(screen)).not.toContain("approved-only");
  press(screen, "m");
  press(screen, "a");
  expect(screen.rowCount()).toBe(walkNodes(roots[0]).length - 1);
});

function threadEvents(running = false) {
  return [
    event("toolCallStart", 0, "research", null, { toolName: "researchAgent" }),
    event("promptStart", 1, "calls", "research"),
    ...(running
      ? []
      : [
          event("promptCompletion", 100, "calls", "research", {
            threadIdentity: "main-id",
            threadLabel: "main",
            completion: { output: "final answer" },
          }),
        ]),
  ];
}

it("starts completed thread groups folded, while expansion survives follow and machinery", () => {
  const roots = buildForest(threadEvents());
  const screen = make(roots);
  expect(screen.rowCount()).toBe(2);
  expect(text(screen)).toContain("▸ Thread · main");
  screen.setFocus("calls");
  press(screen, "enter");
  expect(screen.rowCount()).toBe(3);
  screen.setData(roots);
  expect(screen.rowCount()).toBe(3);
  press(screen, "m");
  press(screen, "a");
  expect(screen.rowCount()).toBe(walkNodes(roots[0]).length - 1);
  press(screen, "m");
  expect(screen.rowCount()).toBe(3);
  press(screen, "enter");
  expect(screen.rowCount()).toBe(2);
  screen.applySearch("final answer");
  expect(screen.rowCount()).toBe(3);
  screen.escape();
  expect(screen.rowCount()).toBe(2);
  screen.setFocus("round:calls:0");
  expect(screen.rowCount()).toBe(3);
  screen.setData(roots);
  expect(screen.rowCount()).toBe(3);
});

it("leaves running groups open and does not fold work the user is reading", () => {
  const screen = make(buildForest(threadEvents(true)));
  expect(text(screen)).not.toContain("▸ Thread");
  screen.setFocus("calls");
  screen.setData(buildForest(threadEvents()));
  expect(screen.rowCount()).toBe(3);
  screen.setData(buildForest(threadEvents()));
  expect(screen.rowCount()).toBe(3);
});

it("reopens automatic folds when a retry starts in the same group, preserving manual folds", () => {
  const completed = threadEvents();
  const retrying = [...completed, event("promptStart", 200, "calls", "research")];
  const screen = make(buildForest(completed));
  expect(text(screen)).toContain("▸ Thread · main");
  screen.setData(buildForest(retrying));
  expect(text(screen)).not.toContain("▸ Thread · main");
  expect(screen.rowCount()).toBe(3);
  screen.setFocus("calls");
  press(screen, "enter");
  screen.setData(buildForest(retrying));
  expect(text(screen)).toContain("▸ Thread · main");
});
