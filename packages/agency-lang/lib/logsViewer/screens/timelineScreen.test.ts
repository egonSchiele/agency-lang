import { buildTreeIndex } from "../forest.js";
import { layout } from "../../tui/layout.js";
import { render } from "../../tui/render/renderer.js";
import { FrameRecorder } from "../../tui/output/recorder.js";
import { parseStyledText } from "../../tui/styleParser.js";
import { describe, expect, it } from "vitest";

import type { Element } from "../../tui/elements.js";
import { DEFAULT_THRESHOLDS } from "../thresholds.js";
import { benchForest, leaf, span, trace } from "../timeline/fixture.js";
import { TimelineScreen } from "../screens/timelineScreen.js";
import type { TreeNode } from "../types.js";

const viewport = { rows: 24, cols: 120 };

function flat(el: Element): string[] {
  if (el.type === "text")
    return [
      parseStyledText(el.content ?? "")
        .map((part) => part.text)
        .join(""),
    ];
  return (el.children ?? []).flatMap(flat);
}

function frame(view: TimelineScreen, vp = viewport): string {
  return flat(view.render(vp)).join("\n");
}

function fixtureForest(): TreeNode[] {
  const bash = span(
    "toolExecution",
    [
      leaf("toolCallStart", 2_000, {
        toolName: "bash",
        args: { command: "pip install matplotlib" },
      }),
      leaf("toolCall", 6_000, { toolName: "bash" }),
    ],
    { id: "bash1" },
  );
  const innerLlm = span(
    "llmCall",
    [
      leaf("promptCompletion", 60_000, {
        model: '"claude-sonnet-5"',
        threadId: "5",
        timeTaken: 59_000,
        messages: [{ role: "user", content: "solve the gcode puzzle" }],
      }),
      bash,
    ],
    { id: "llm1" },
  );
  const admin = span("handlerChain", [leaf("handlerDecision", 2_500)], { id: "admin1" });
  const agent = span(
    "toolExecution",
    [
      leaf("toolCallStart", 500, { toolName: "codeAgent", args: { userMsg: "do the task" } }),
      admin,
      innerLlm,
      leaf("toolCall", 61_000, { toolName: "codeAgent" }),
    ],
    { id: "agent1" },
  );
  const root = span(
    "agentRun",
    [leaf("agentStart", 0, { entryNode: "main" }), agent, leaf("agentEnd", 61_500)],
    { id: "root1" },
  );
  return [trace([leaf("threadCreated", 0, { threadId: "5", label: "codingAgent" }), root])];
}

describe("TimelineScreen", () => {
  it("labels: llm shows the asked question, tools show their argument, never the model", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    const text = frame(view);
    expect(text).toContain("llm · solve the gcode puzzle");
    expect(text).toContain("bash · pip install matplotlib");
    expect(text).not.toContain("claude-sonnet-5");
  });

  it("admin spans are hidden by default; a reveals them and marks the header", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    expect(frame(view)).not.toContain("handlerChain");
    view.handleKey({ key: "a" }, viewport);
    const shown = frame(view);
    expect(shown).toContain("handlerChain");
    expect(shown).toContain("[admin spans shown]");
  });

  it("drill re-roots on the selected span with breadcrumbs; ← climbs out", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    view.handleKey({ key: "down" }, viewport); // → codeAgent row
    view.handleKey({ key: "enter" }, viewport); // drill in
    const drilled = frame(view);
    expect(drilled).toContain("» codeAgent");
    expect(drilled).not.toContain("agentRun");
    view.handleKey({ key: "left" }, viewport);
    expect(frame(view)).toContain("agentRun");
  });

  it("Enter on a leaf opens the detail screen for that span", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    view.handleKey({ key: "G" }, viewport); // last row = bash (leaf)
    const action = view.handleKey({ key: "enter" }, viewport);
    expect(action).toEqual({ kind: "openDetail", rowId: "bash1" });
  });

  it("zoom halves the window around the cursor span; 0 resets; pan clamps", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    const full = view.currentWindow();
    view.handleKey({ key: "+" }, viewport);
    const zoomed = view.currentWindow();
    expect(zoomed.end - zoomed.start).toBeCloseTo((full.end - full.start) / 2, 3);
    view.handleKey({ key: "]" }, viewport);
    const panned = view.currentWindow();
    expect(panned.start).toBeGreaterThanOrEqual(full.start);
    expect(panned.end).toBeLessThanOrEqual(full.end);
    view.handleKey({ key: "0" }, viewport);
    expect(view.currentWindow()).toEqual(full);
  });

  it("total/self appears only when they differ", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    const text = frame(view);
    expect(text).toMatch(/1m0[12]s\/\d+m?\d*/); // wrapping span shows total/self
    expect(text).toMatch(/ 4\.0s(?!\/)/); // leaf bash shows plain total
  });

  it("search jumps the cursor; n advances; a miss reports via the footer", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    const action = view.handleKey({ key: "/" }, viewport);
    expect(action.kind).toBe("promptLine");
    if (action.kind === "promptLine") action.onResult("pip install");
    expect(view.cursorSpanId()).toBe("bash1");
    const miss = view.handleKey({ key: "/" }, viewport);
    if (miss.kind === "promptLine") miss.onResult("zzz-nothing");
    expect(frame(view)).toContain('no matches for "zzz-nothing"');
    view.handleKey({ key: "down" }, viewport); // any key clears it, like the tree
    expect(frame(view)).not.toContain("zzz-nothing");
  });

  it("the follow indicator shows in the header", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    view.setFollowIndicator(true);
    expect(frame(view)).toContain("[following]");
  });

  it("paging moves the cursor by viewport rows", () => {
    const view = new TimelineScreen(benchForest(), benchForest()[0].traceId, DEFAULT_THRESHOLDS);
    const before = view.cursorSpanId();
    view.handleKey({ key: "f", ctrl: true }, viewport);
    expect(view.cursorSpanId()).not.toBe(before);
  });

  it("setData keeps the cursor span and, when unzoomed, extends the axis", () => {
    const forest = fixtureForest();
    const view = new TimelineScreen(forest, "T", DEFAULT_THRESHOLDS);
    view.handleKey({ key: "G" }, viewport);
    const keptId = view.cursorSpanId();
    const grown = fixtureForest();
    grown[0].children.push(
      span(
        "toolExecution",
        [
          leaf("toolCallStart", 70_000, { toolName: "write" }),
          leaf("toolCall", 90_000, { toolName: "write" }),
        ],
        { id: "late1" },
      ),
    );
    view.setData(grown);
    expect(view.cursorSpanId()).toBe(keptId);
    expect(view.currentWindow().end).toBeGreaterThanOrEqual(90_000);
  });

  it("setData does NOT move the window while zoomed", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    view.handleKey({ key: "+" }, viewport);
    const zoomed = view.currentWindow();
    const grown = fixtureForest();
    grown[0].children.push(
      span(
        "toolExecution",
        [
          leaf("toolCallStart", 70_000, { toolName: "write" }),
          leaf("toolCall", 90_000, { toolName: "write" }),
        ],
        { id: "late1" },
      ),
    );
    view.setData(grown);
    expect(view.currentWindow()).toEqual(zoomed);
  });

  it("drillTo starts re-rooted (the openFlameAt path)", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS, {
      drillTo: "agent1",
    });
    const text = frame(view);
    expect(text).toContain("» codeAgent");
    expect(text).not.toContain("agentRun");
  });

  it("renders the real trimmed statelog without falling over (layout regression net)", () => {
    const roots = benchForest();
    const view = new TimelineScreen(roots, roots[0].traceId, DEFAULT_THRESHOLDS);
    const lines = flat(view.render({ rows: 30, cols: 120 }));
    expect(lines.length).toBeGreaterThan(10);
    expect(lines[0]).toContain("TIMELINE [timeline]");
  });
});

function loopForest(): TreeNode[] {
  return [
    trace([
      span(
        "llmCall",
        [
          leaf("promptCompletion", 1000, {
            timeTaken: 100,
            usage: { inputTokens: 123, cachedInputTokens: 18000, outputTokens: 45 },
            cost: { totalCost: 0.0015 },
          }),
          span(
            "toolExecution",
            [
              leaf("toolCallStart", 1100, { toolName: "read", args: { path: "{bold}" } }),
              leaf("toolCall", 1500, { toolName: "read" }),
            ],
            { id: "tool1" },
          ),
          leaf("promptCompletion", 2000, { timeTaken: 100 }),
          leaf("promptCompletion", 3000, { timeTaken: 100 }),
        ],
        { id: "L" },
      ),
    ]),
  ];
}
describe("timeline screen rows and focus", () => {
  it("uses full-width, consecutive height-one bar rows and draws rounds", () => {
    const view = new TimelineScreen(loopForest(), "T", DEFAULT_THRESHOLDS);
    const text = frame(view, { rows: 12, cols: 140 });
    expect(text).toContain("round 1");
    expect(text).toContain("round 3");
    expect(text).toContain("{bold}");
    const bars = flat(view.render({ rows: 12, cols: 140 })).filter((text) => text.includes("█"));
    expect(bars[0].lastIndexOf("█")).toBeGreaterThan(110);
  });
  it("focuses a stable round and opens it in trace or details", () => {
    const view = new TimelineScreen(loopForest(), "T", DEFAULT_THRESHOLDS);
    view.setFocus("round:L:1");
    expect(view.focusId()).toBe("round:L:1");
    expect(view.handleKey({ key: "enter" }, viewport)).toEqual({
      kind: "openScreen",
      screen: "trace",
      focusId: "round:L:1",
    });
    expect(view.handleKey({ key: "d" }, viewport)).toEqual({
      kind: "openDetail",
      rowId: "round:L:1",
    });
    view.setData(loopForest());
    expect(view.focusId()).toBe("round:L:1");
  });
  it("falls back from a hidden admin span to its tool", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    view.setFocus("admin1");
    expect(view.focusId()).toBe("agent1");
  });
  it("clears search before drill and offers pan only when zoomed", () => {
    const view = new TimelineScreen(loopForest(), "T", DEFAULT_THRESHOLDS);
    expect(frame(view)).not.toContain("[ ] pan");
    view.handleKey({ key: "+" }, viewport);
    expect(frame(view)).toContain("[ ] pan");
    view.handleKey({ key: "enter" }, viewport);
    view.applySearch("round");
    expect(view.escape()).toBe(true);
    expect(view.escape()).toBe(true);
    expect(view.escape()).toBe(false);
    expect(view.helpLines().some((text) => text.startsWith("a —"))).toBe(true);
  });
  it("Ctrl+D moves half as many rows as Ctrl+F", () => {
    const forest = [
      trace(
        Array.from({ length: 30 }, (_unused, position) =>
          span("toolExecution", [leaf("toolCall", position * 100)], { id: `tool${position}` }),
        ),
      ),
    ];
    const view = new TimelineScreen(forest, "T", DEFAULT_THRESHOLDS);
    view.handleKey({ key: "d", ctrl: true }, viewport);
    expect(view.focusId()).toBe("tool10");
    view.handleKey({ key: "g" }, viewport);
    view.handleKey({ key: "f", ctrl: true }, viewport);
    expect(view.focusId()).toBe("tool20");
  });
});

it("lays bars on consecutive lines across the real 140-column frame", () => {
  const view = new TimelineScreen(loopForest(), "T", DEFAULT_THRESHOLDS);
  const recorder = new FrameRecorder();
  recorder.write(render(layout(view.render({ rows: 12, cols: 140 }), 140, 12)));
  const lines = recorder.lastText().split("\n");
  expect(lines[2].lastIndexOf("█")).toBeGreaterThan(110);
  expect(lines.slice(2, 7).every((line) => line.trim().length > 0)).toBe(true);
});
it.each([100, 130, 200])("renders a timeline golden at %i columns", (cols) => {
  const view = new TimelineScreen(loopForest(), "T", DEFAULT_THRESHOLDS);
  const recorder = new FrameRecorder();
  recorder.write(render(layout(view.render({ rows: 12, cols }), cols, 12)));
  expect(recorder.lastText()).toMatchSnapshot();
  recorder.writeHTML(`/tmp/pr4-timeline-${cols}.html`);
});
it("help derives a table with no duplicate key ownership", () => {
  const screen = new TimelineScreen(loopForest(), "T", DEFAULT_THRESHOLDS);
  const keys = screen.helpLines().flatMap((line) => line.split(" — ")[0].split(" / "));
  expect(keys.filter((key, position) => keys.indexOf(key) !== position)).toEqual([]);
});

it("drilling a multi-round call draws each round once", () => {
  const view = new TimelineScreen(loopForest(), "T", DEFAULT_THRESHOLDS);
  view.handleKey({ key: "enter" }, viewport);
  expect(frame(view).match(/round 1/g)).toHaveLength(1);
  expect(frame(view).match(/round 2/g)).toHaveLength(1);
});
it("drilling a single-round call keeps the duplicate round bar suppressed", () => {
  const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
  view.setFocus("llm1");
  view.handleKey({ key: "enter" }, viewport);
  expect(frame(view)).not.toContain("round 1");
});
it("drilling never imports unrelated rounds from the trace root", () => {
  const roots = loopForest();
  roots[0].children.push(leaf("promptCompletion", 4000, { timeTaken: 100 }));
  const view = new TimelineScreen(roots, "T", DEFAULT_THRESHOLDS);
  view.handleKey({ key: "enter" }, viewport);
  expect(frame(view)).not.toContain("round 4");
});
it("falls back to a surviving parent when follow removes the selected child", () => {
  const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
  view.setFocus("bash1");
  const roots = fixtureForest();
  const index = buildTreeIndex(roots[0]);
  index.byId.llm1.children = index.byId.llm1.children.filter((child) => child.id !== "bash1");
  view.setData(roots);
  expect(view.focusId()).toBe("llm1");
});
