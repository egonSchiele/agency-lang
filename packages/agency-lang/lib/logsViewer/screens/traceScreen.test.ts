import { describe, expect, it } from "vitest";
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
    expect(output.match(/round\s+\d+/g)).toHaveLength(10);
    expect(output.match(/⚠ std::grep\s+rejected/g)).toHaveLength(4);
    const lines = output.split("\n").filter((line) => /round\s+\d/.test(line));
    const positions = lines.map((line) => line.indexOf("$"));
    expect(positions.every((position) => position === positions[0])).toBe(true);
  });
  it("moves the payload with the cursor and carries the tool from its interrupt", () => {
    const screen = make([agentLoopTrace()]);
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
      buildForest([event("promptCompletion", 24000, "L", null, { timeTaken: 23700 })]),
    );
    expect(text(slow)).toContain("23.7s!");
  });
  it("error filters retain rejected tools and their asking rounds", () => {
    const screen = make([agentLoopTrace()]);
    press(screen, "F");
    const output = text(screen);
    expect(output).toMatch(/round\s+2/);
    expect(output).toContain("✖ grep");
    expect(output).not.toMatch(/round\s+1\b/);
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
    expect(text(screen)).toMatch(/round\s+2/);
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
