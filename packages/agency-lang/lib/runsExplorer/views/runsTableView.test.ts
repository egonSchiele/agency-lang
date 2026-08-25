import { describe, expect, it } from "vitest";

import { RunsTableView } from "./runsTableView.js";
import { runRow, screenText, testRow } from "./viewTestUtils.js";

const viewport = { rows: 24, cols: 120 };

function makeView(rows = defaultRows()) {
  const view = new RunsTableView();
  view.setData(rows);
  return view;
}

function defaultRows() {
  return [
    runRow("r-new", { startedAtMs: 9_000, agent: "agent-b", score: 0.1 }),
    runRow("r-old", { startedAtMs: 1_000, agent: "agent-a", score: 0.9 }),
    runRow("r-trace", {
      startedAtMs: 5_000,
      agent: "log.jsonl#ab",
      suite: "—",
      score: null,
      gatesPassed: null,
      status: "trace",
      tests: [],
      source: { kind: "statelog", file: "/logs/log.jsonl" },
    }),
  ];
}

describe("RunsTableView rendering", () => {
  it("renders the spec columns with the sorted header arrow", () => {
    const text = screenText(makeView().render(viewport));
    for (const header of [
      "date▼",
      "agent",
      "suite",
      "test",
      "score",
      "pass",
      "status",
      "cost",
      "time",
      "models",
    ]) {
      expect(text).toContain(header);
    }
  });

  it("null score renders a dash and gates render check marks", () => {
    const text = screenText(makeView().render(viewport));
    expect(text).toContain("—");
    expect(text).toContain("✓");
  });

  it("narrow viewports drop models, then time, then pass", () => {
    const view = makeView();
    const at = (cols: number) => screenText(view.render({ rows: 24, cols }));
    // Fixed columns sum to 112; the flex models column needs 8 more.
    expect(at(120)).toContain("models");
    const noModels = at(115);
    expect(noModels).not.toContain("models");
    expect(noModels).toContain("time");
    const noTime = at(105);
    expect(noTime).not.toContain("time");
    expect(noTime).toContain("pass");
    const noPass = at(98);
    expect(noPass).not.toContain("pass");
    expect(noPass).toContain("test");
    const noTest = at(80);
    expect(noTest).not.toContain("test");
    expect(noTest).toContain("status");
  });

  it("loading progress shows in the status line and clears when done", () => {
    const view = makeView();
    view.setProgress({ kind: "progress", phase: "summary", completed: 40, total: 210 });
    expect(screenText(view.render(viewport))).toContain("Loading runs… 40/210");
    view.setProgress(null);
    expect(screenText(view.render(viewport))).not.toContain("Loading");
  });

  it("shows the view tag bottom-right", () => {
    expect(screenText(makeView().render(viewport))).toContain("[runs]");
  });
});

describe("RunsTableView keys", () => {
  it("s cycles the sort column and S flips direction (header arrow moves)", () => {
    const view = makeView();
    view.handleKey({ key: "s" }, viewport);
    expect(screenText(view.render(viewport))).toContain("score▼");
    view.handleKey({ key: "S" }, viewport);
    expect(screenText(view.render(viewport))).toContain("score▲");
  });

  it("b groups by agent; Enter on a header expands its members inline", () => {
    const view = makeView();
    view.handleKey({ key: "b" }, viewport);
    const grouped = screenText(view.render(viewport));
    expect(grouped).toContain("agent-b (1)");
    expect(grouped).toContain("▸");

    view.handleKey({ key: "enter" }, viewport);
    const expanded = screenText(view.render(viewport));
    expect(expanded).toContain("▾");
  });

  it("Enter opens: multi-test run → openRun, trace row → openLog", () => {
    const view = makeView();
    const onMultiTest = view.handleKey({ key: "enter" }, viewport);
    expect(onMultiTest).toEqual({ kind: "openRun", parentRunKey: "r-new" });

    view.handleKey({ key: "j" }, viewport);
    const onTrace = view.handleKey({ key: "enter" }, viewport);
    expect(onTrace).toMatchObject({ kind: "openLog", statelogPath: "/logs/log.jsonl" });
  });

  it("a single-test run opens its graders on Enter and its log on o", () => {
    const view = makeView([runRow("solo", { tests: [testRow("only")] })]);
    expect(view.handleKey({ key: "enter" }, viewport)).toEqual({
      kind: "openTest",
      runKey: "solo",
      inputId: "only",
    });
    expect(view.handleKey({ key: "o" }, viewport)).toMatchObject({
      kind: "openLog",
      statelogPath: "/runs/x/inputs/only/agent/statelog.jsonl",
    });
  });

  it("i opens info for the cursor row; e exports the current projection", () => {
    const view = makeView();
    expect(view.handleKey({ key: "i" }, viewport)).toEqual({ kind: "openInfo", rowKey: "r-new" });
    const exported = view.handleKey({ key: "e" }, viewport);
    if (exported.kind !== "exportCsv") {
      throw new Error("expected exportCsv");
    }
    expect(exported.projection.rows).toHaveLength(3);
  });

  it("t/T cycle views, Esc at home is inert, q quits", () => {
    const view = makeView();
    expect(view.handleKey({ key: "t" }, viewport)).toEqual({ kind: "cycleView", delta: 1 });
    expect(view.handleKey({ key: "T" }, viewport)).toEqual({ kind: "cycleView", delta: -1 });
    expect(view.handleKey({ key: "escape" }, viewport)).toEqual({ kind: "none" });
    expect(view.handleKey({ key: "q" }, viewport)).toEqual({ kind: "quit" });
  });

  it("setData keeps the cursor on its row while the order changes", () => {
    const view = makeView();
    view.handleKey({ key: "j" }, viewport);
    expect(view.handleKey({ key: "i" }, viewport)).toEqual({ kind: "openInfo", rowKey: "r-trace" });

    const reordered = [defaultRows()[2], defaultRows()[0], defaultRows()[1]];
    view.setData(reordered);
    expect(view.handleKey({ key: "i" }, viewport)).toEqual({ kind: "openInfo", rowKey: "r-trace" });
  });
});
