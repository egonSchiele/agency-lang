import { buildTreeIndex } from "../forest.js";
import { layout } from "../../tui/layout.js";
import { render } from "../../tui/render/renderer.js";
import { FrameRecorder } from "../../tui/output/recorder.js";
import { parseStyledText } from "../../tui/styleParser.js";
import { describe, expect, it } from "vitest";

import type { Element } from "../../tui/elements.js";
import { DEFAULT_THRESHOLDS } from "../thresholds.js";
import { THEME } from "../theme.js";
import { benchForest, leaf, sessionTrace, span, trace } from "../timeline/fixture.js";
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
  it("labels thread groups by name and keeps tool argument summaries", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    view.setFocus("bash1"); // open the folded group so every row shows
    const text = frame(view);
    expect(text).toContain("Thread · codingAgent");
    expect(text).toContain("bash · pip install matplotlib");
    expect(text).not.toContain("claude-sonnet-5");
  });

  it("keeps thread labels bold and accented when selected, including drill breadcrumbs", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    view.setFocus("llm1");
    const styled = (element: Element): ReturnType<typeof parseStyledText> =>
      element.type === "text"
        ? parseStyledText(element.content ?? "")
        : (element.children ?? []).flatMap(styled);
    const label = styled(view.render(viewport)).find((part) =>
      part.text.includes("Thread · codingAgent"),
    );
    expect(label).toMatchObject({ fg: THEME.accent, bold: true });
    view.handleKey({ key: "right" }, viewport);
    expect(frame(view)).toContain("» Thread · codingAgent");
  });

  it("names every thread span by its thread and call count, nested ones too", () => {
    const call = (at: number) =>
      leaf("promptCompletion", at, {
        model: '"m1"',
        threadIdentity: "T",
        threadLabel: "main",
        timeTaken: 500,
        completion: { output: "ok" },
      });
    const inner = span("llmCall", [call(3_000), call(4_000)], { id: "inner" });
    const tool = span(
      "toolExecution",
      [leaf("toolCallStart", 1_500, { toolName: "researchAgent", args: {} }), inner],
      { id: "research" },
    );
    const outer = span("llmCall", [call(1_000), tool, call(5_000)], { id: "outer" });
    const view = new TimelineScreen([trace([outer])], "T", DEFAULT_THRESHOLDS);
    const text = frame(view);
    // The outer span and the sub-agent's span inside it, both two calls on "main".
    const rows = text
      .split("\n")
      .filter((row) => row.includes("Thread · main · 2 LLM calls") && !row.startsWith("Thread"));
    expect(rows).toHaveLength(2);
    expect(rows[1].indexOf("Thread")).toBeGreaterThan(rows[0].indexOf("Thread"));
  });

  it("colors rows by kind as the trace does, not by how much time a name took", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    view.setFocus("bash1"); // open the folded group so every row shows
    view.setFocus("llm1"); // the cursor row paints in the text color
    const styled = (element: Element): ReturnType<typeof parseStyledText> =>
      element.type === "text"
        ? parseStyledText(element.content ?? "")
        : (element.children ?? []).flatMap(styled);
    const parts = styled(view.render(viewport));
    const part = (text: string) => parts.find((candidate) => candidate.text.includes(text));
    expect(part("bash · pip install")).toMatchObject({ fg: THEME.kind.tool });
    expect(part("codeAgent ·")).toMatchObject({ fg: THEME.kind.tool });
    expect(part("Thread · codingAgent")).toMatchObject({ fg: THEME.accent });
  });

  it("stacks a session's turns, each under its own row and axis, with the wait between them", () => {
    const view = new TimelineScreen([sessionTrace()], "T", DEFAULT_THRESHOLDS);
    const text = frame(view);
    expect(text).toContain("Elapsed 15m00s · 15.0s working · 14m45s waiting for the user");
    expect(text).toContain("▶ turn 1 · first question");
    expect(text).toContain("⏸ waited 9m54s for the user");
    expect(text).toContain("turn 2 · second question");
    expect(text).not.toContain("with a second line");
    expect(text).toContain("⏸ waited 4m51s, then the run ended");
    // One call per span draws no call row of its own; the tool shows under turn 2 only.
    expect(text).toContain("read · a");
    expect(text.indexOf("read · a")).toBeGreaterThan(text.indexOf("turn 2 ·"));
    // Each turn's row carries its own axis, ending at that turn's working time.
    // A turn's row is its title with cost and calls; the line beneath is its
    // own axis, ending at that turn's working time, labeled total/self.
    const lines = text.split("\n");
    const under = (title: string) => lines[lines.findIndex((row) => row.includes(title)) + 1];
    expect(lines.find((row) => row.includes("turn 1 · first question"))).toMatch(
      /\$0\.010 · 1 LLM call/,
    );
    expect(under("turn 1 · first question")).toMatch(/0ms\s+3\.0s\s+6\.0s\s+total\/self/);
    expect(under("turn 2 · second question")).toMatch(/0ms\s+4\.5s\s+9\.0s\s+total\/self/);
    // No axis at the top: the header is followed by turn 1 directly.
    expect(lines[1]).toContain("turn 1 · first question");
    expect(frame(view)).toMatch(
      /turn 1 · first question {2}· {2}start \+0ms {2}· {2}1 LLM call, ran 6\.0s, then waited 9m54s/,
    );
    // The cursor walks down turn 1's rows, past the wait line, into turn 2.
    const seen: string[] = [];
    for (let step = 0; step < 8; step += 1) {
      view.handleKey({ key: "down" }, viewport);
      seen.push(view.focusId() ?? "");
    }
    expect(seen).toEqual([
      "node",
      "L1",
      "round:L1:0",
      "turn:1",
      "node",
      "L2",
      "round:L2:0",
      "tool2",
    ]);
    for (let step = 0; step < 4; step += 1) {
      view.handleKey({ key: "up" }, viewport);
    }
    expect(view.focusId()).toBe("turn:1");
    // Enter folds a turn.
    view.handleKey({ key: "enter" }, viewport);
    expect(frame(view)).toContain("▸ turn 2 · second question");
    expect(frame(view)).not.toContain("read · a");
    expect(frame(view)).toContain("⏸ waited 4m51s, then the run ended");
    // The node's span is drawn in both turns; folding it in one leaves the other open.
    view.handleKey({ key: "enter" }, viewport);
    view.handleKey({ key: "down" }, viewport);
    expect(view.focusId()).toBe("node");
    view.handleKey({ key: "enter" }, viewport);
    const rows = frame(view).split("\n");
    expect(rows.filter((row) => row.includes("▸ "))).toHaveLength(1);
    expect(rows.filter((row) => row.includes("Thread · main"))).toHaveLength(1);
  });

  it("zoom and focus stay within the turn they belong to", () => {
    const view = new TimelineScreen([sessionTrace()], "T", DEFAULT_THRESHOLDS);
    view.setFocus("tool2");
    expect(view.focusId()).toBe("tool2");
    view.handleKey({ key: "+" }, viewport);
    const zoomed = frame(view);
    expect(zoomed).toContain("(zoom ");
    // Turn 1's axis is untouched by a zoom in turn 2.
    const rows = zoomed.split("\n");
    expect(rows[rows.findIndex((row) => row.includes("turn 1 ·")) + 1]).toMatch(
      /0ms\s+3\.0s\s+6\.0s/,
    );
    view.setFocus("L1");
    expect(view.focusId()).toBe("L1");
    expect(frame(view)).not.toContain("(zoom ");
    const drilled = new TimelineScreen([sessionTrace()], "T", DEFAULT_THRESHOLDS, {
      drillTo: "L2",
    });
    expect(frame(drilled)).toContain("» Thread · main");
    expect(frame(drilled)).toContain("turn 2 · second question");
    expect(frame(drilled)).not.toContain("turn 1 ·");
  });

  it("uses unnamed for threads without recorded names and preserves individual call labels", () => {
    const view = new TimelineScreen(loopForest(), "T", DEFAULT_THRESHOLDS);
    expect(frame(view)).toContain("Thread · unnamed");
    expect(frame(view)).toContain("LLM call 1");
    expect(frame(view)).toContain("LLM call 3");
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
    // The first row is codeAgent: agentRun above it is hidden.
    view.handleKey({ key: "right" }, viewport); // drill in
    const drilled = frame(view);
    expect(drilled).toContain("» codeAgent");
    view.handleKey({ key: "left" }, viewport);
    expect(frame(view)).toContain("codeAgent · do the task");
    expect(frame(view)).not.toContain("» ");
  });

  it("hides the agentRun span until a shows it", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    expect(frame(view)).not.toContain("agentRun");
    expect(frame(view)).toContain("total/self");
    view.handleKey({ key: "a" }, viewport);
    expect(frame(view)).toContain("agentRun");
  });

  it("Enter on a leaf opens the detail screen for that span", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    view.setFocus("bash1");
    const action = view.handleKey({ key: "enter" }, viewport);
    expect(action).toEqual({ kind: "openDetail", rowId: "bash1" });
  });

  it("starts a completed sub-agent group folded; Enter opens and closes it in place", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    expect(frame(view)).toContain("▸ Thread · codingAgent");
    expect(frame(view)).not.toContain("bash · pip install");
    view.handleKey({ key: "G" }, viewport); // last visible row = the folded group
    expect(view.cursorSpanId()).toBe("llm1");
    view.handleKey({ key: "enter" }, viewport);
    expect(frame(view)).not.toContain("▸ Thread");
    expect(frame(view)).toContain("bash · pip install");
    expect(view.cursorSpanId()).toBe("llm1");
    expect(frame(view)).not.toContain("» "); // no drill happened
    view.handleKey({ key: "enter" }, viewport);
    expect(frame(view)).toContain("▸ Thread · codingAgent");
    expect(frame(view)).not.toContain("bash · pip install");
    // A top-level thread never folds by itself.
    expect(frame(new TimelineScreen(loopForest(), "T", DEFAULT_THRESHOLDS))).toContain(
      "LLM call 3",
    );
  });

  it("search and focus open the fold that hides their row", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    const action = view.handleKey({ key: "/" }, viewport);
    if (action.kind === "promptLine") action.onResult("pip install");
    expect(view.cursorSpanId()).toBe("bash1");
    expect(frame(view)).toContain("bash · pip install");
    const other = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    other.setFocus("bash1");
    expect(other.cursorSpanId()).toBe("bash1");
    // A follow update keeps a group the reader opened open.
    other.setData(fixtureForest());
    expect(frame(other)).toContain("bash · pip install");
  });

  it("zoom halves the window around the cursor span; 0 resets; pan clamps", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    const full = view.currentWindow();
    view.handleKey({ key: "+" }, viewport);
    const zoomed = view.currentWindow();
    expect(zoomed.end - zoomed.start).toBeCloseTo((full.end - full.start) / 2, 3);
    view.handleKey({ key: "}" }, viewport);
    const panned = view.currentWindow();
    expect(panned.start).toBeGreaterThan(zoomed.start);
    expect(panned.start).toBeGreaterThanOrEqual(full.start);
    expect(panned.end).toBeLessThanOrEqual(full.end);
    view.handleKey({ key: "{" }, viewport);
    expect(view.currentWindow()).toEqual(zoomed);
    view.handleKey({ key: "0" }, viewport);
    expect(view.currentWindow()).toEqual(full);
  });

  it("total/self appears only when they differ", () => {
    const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    view.setFocus("bash1"); // open the folded group so every row shows
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
    expect(lines.at(-1)).toContain("[TIMELINE]");
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
  it("brackets skip descendants and stop at sibling boundaries, including while zoomed", () => {
    const forest = [
      trace([
        span(
          "toolExecution",
          [
            leaf("toolCallStart", 0),
            span("toolExecution", [leaf("toolCall", 100)], { id: "child1" }),
            leaf("toolCall", 200),
          ],
          { id: "first" },
        ),
        span(
          "toolExecution",
          [
            leaf("toolCallStart", 300),
            span("toolExecution", [leaf("toolCall", 400)], { id: "child2" }),
            leaf("toolCall", 500),
          ],
          { id: "second" },
        ),
      ]),
    ];
    const view = new TimelineScreen(forest, "T", DEFAULT_THRESHOLDS);
    view.handleKey({ key: "[" }, viewport);
    expect(view.focusId()).toBe("first");
    view.handleKey({ key: "]" }, viewport);
    expect(view.focusId()).toBe("second");
    view.handleKey({ key: "]" }, viewport);
    expect(view.focusId()).toBe("second");
    view.handleKey({ key: "+" }, viewport);
    const zoomed = view.currentWindow();
    view.handleKey({ key: "[" }, viewport);
    expect(view.focusId()).toBe("first");
    expect(view.currentWindow()).toEqual(zoomed);
    for (const id of ["child1", "child2"]) {
      view.setFocus(id);
      for (const key of ["[", "]"]) {
        view.handleKey({ key }, viewport);
        expect(view.focusId()).toBe(id);
      }
    }
  });
  it("brackets skip requested tools between LLM calls inside a drilled timeline", () => {
    const view = new TimelineScreen(loopForest(), "T", DEFAULT_THRESHOLDS);
    view.handleKey({ key: "enter" }, viewport);
    view.setFocus("round:L:0");
    view.handleKey({ key: "]" }, viewport);
    expect(view.focusId()).toBe("round:L:1");
    view.handleKey({ key: "]" }, viewport);
    expect(view.focusId()).toBe("round:L:2");
    view.handleKey({ key: "[" }, viewport);
    expect(view.focusId()).toBe("round:L:1");
    view.setFocus("tool1");
    view.handleKey({ key: "]" }, viewport);
    expect(view.focusId()).toBe("tool1");
  });
  it("uses full-width, consecutive height-one bar rows and draws rounds", () => {
    const view = new TimelineScreen(loopForest(), "T", DEFAULT_THRESHOLDS);
    const text = frame(view, { rows: 12, cols: 140 });
    expect(text).toContain("LLM call 1");
    expect(text).toContain("LLM call 3");
    expect(text).toContain("{bold}");
    const recorder = new FrameRecorder();
    recorder.write(render(layout(view.render({ rows: 12, cols: 140 }), 140, 12)));
    const lines = recorder.lastText().split("\n");
    expect(lines.find((line) => line.includes("read · {bold}"))!.indexOf("read ·")).toBe(
      lines.find((line) => line.includes("LLM call 1"))!.indexOf("LLM call 1") + 2,
    );
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
    expect(frame(view)).not.toContain("{ } pan");
    view.handleKey({ key: "+" }, viewport);
    expect(frame(view)).toContain("{ } pan");
    view.handleKey({ key: "right" }, viewport);
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
  view.handleKey({ key: "#" }, { rows: 12, cols });
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
  view.handleKey({ key: "right" }, viewport);
  expect(frame(view).match(/LLM call 1/g)).toHaveLength(1);
  expect(frame(view).match(/LLM call 2/g)).toHaveLength(1);
});
it("a thread with one call draws the call's row, and Enter on it opens the call in the trace", () => {
  const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS);
  view.setFocus("round:llm1:0");
  expect(view.focusId()).toBe("round:llm1:0");
  expect(frame(view)).toContain("LLM call 1");
  expect(view.handleKey({ key: "enter" }, viewport)).toEqual({
    kind: "openScreen",
    screen: "trace",
    focusId: "round:llm1:0",
  });
});
it("drilling never imports unrelated rounds from the trace root", () => {
  const roots = loopForest();
  roots[0].children.push(leaf("promptCompletion", 4000, { timeTaken: 100 }));
  const view = new TimelineScreen(roots, "T", DEFAULT_THRESHOLDS);
  view.handleKey({ key: "right" }, viewport);
  expect(frame(view)).not.toContain("LLM call 4");
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

it.each(["trace-T", "missing"])("retains its drill and cursor for unresolvable focus %s", (id) => {
  const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS, { drillTo: "agent1" });
  view.setFocus("bash1");
  view.setFocus(id);
  expect(view.focusId()).toBe("bash1");
  expect(frame(view)).toContain("» codeAgent");
  expect(frame(view)).not.toContain("agentRun");
});
it("leaves its drill to reveal a focus drawn outside it", () => {
  const view = new TimelineScreen(fixtureForest(), "T", DEFAULT_THRESHOLDS, { drillTo: "llm1" });
  view.setFocus("agent1");
  expect(view.focusId()).toBe("agent1");
  expect(frame(view)).toContain("codeAgent · do the task");
  expect(frame(view)).not.toContain("» ");
});

it("toggles row numbers without changing focus, zoom, or drill state", () => {
  const roots = fixtureForest();
  const screen = new TimelineScreen(roots, roots[0].traceId, DEFAULT_THRESHOLDS);
  const before = frame(screen);
  const focus = screen.focusId();
  const window = screen.currentWindow();
  screen.handleKey({ key: "#" }, viewport);
  expect(frame(screen)).toMatch(/\n\s*1 /);
  expect(screen.focusId()).toBe(focus);
  expect(screen.currentWindow()).toEqual(window);
  screen.setData(roots);
  expect(frame(screen)).toMatch(/\n\s*1 /);
  screen.handleKey({ key: "#" }, viewport);
  expect(frame(screen)).toBe(before);
});

describe("timeline marks", () => {
  it("marks a span that logged an error with ✖ and a tool waiting on a person with ⏸", () => {
    const failed = span(
      "toolExecution",
      [
        leaf("toolCallStart", 1_000, { toolName: "write", args: { path: "a" } }),
        leaf("error", 1_500, { message: "disk full", errorType: "toolError" }),
      ],
      { id: "failed" },
    );
    const waiting = span(
      "toolExecution",
      [
        leaf("toolCallStart", 2_000, { toolName: "deploy", args: { env: "prod" } }),
        leaf("interruptResolved", 2_100, { interruptId: "i", outcome: "passed" }),
      ],
      { id: "waiting" },
    );
    const view = new TimelineScreen(
      [
        trace([
          span("llmCall", [leaf("promptCompletion", 500, { timeTaken: 100 }), failed, waiting], {
            id: "L",
          }),
        ]),
      ],
      "T",
      DEFAULT_THRESHOLDS,
    );
    const text = frame(view);
    expect(text).toMatch(/✖ write/);
    expect(text).toMatch(/⏸ deploy/);
    expect(text).not.toMatch(/✖ Thread/);
  });
});
