import { describe, expect, it } from "vitest";

import { TestsTableView } from "./testsTableView.js";
import { runRow, screenText, testRow } from "./viewTestUtils.js";

const viewport = { rows: 24, cols: 120 };

describe("TestsTableView", () => {
  it("renders a waiting title before the parent row arrives, then the tests", () => {
    const view = new TestsTableView("r-1");
    expect(screenText(view.render(viewport))).toContain("waiting for data");

    view.setData([runRow("r-1", { tests: [testRow("t-a"), testRow("t-b")] })]);
    const text = screenText(view.render(viewport));
    expect(text).toContain("t-a");
    expect(text).toContain("t-b");
    expect(text).toContain("[pick test]");
  });

  it("Enter opens the cursor test's statelog; Esc backs out; q quits", () => {
    const view = new TestsTableView("r-1");
    view.setData([runRow("r-1", { agent: "gcode", tests: [testRow("t-a"), testRow("t-b")] })]);

    view.handleKey({ key: "j" }, viewport);
    const action = view.handleKey({ key: "enter" }, viewport);
    expect(action).toEqual({
      kind: "openLog",
      statelogPath: "/runs/x/inputs/t-b/agent/statelog.jsonl",
      title: "gcode / t-b",
    });
    expect(view.handleKey({ key: "escape" }, viewport)).toEqual({ kind: "back" });
    expect(view.handleKey({ key: "q" }, viewport)).toEqual({ kind: "quit" });
  });

  it("a backfill upsert refreshes cells without moving the cursor", () => {
    const view = new TestsTableView("r-1");
    const before = runRow("r-1", {
      backfilled: false,
      tests: [testRow("t-a", { costUsd: null }), testRow("t-b", { costUsd: null })],
    });
    view.setData([before]);
    view.handleKey({ key: "j" }, viewport);
    expect(screenText(view.render(viewport))).toContain("…");

    const after = runRow("r-1", {
      backfilled: true,
      tests: [testRow("t-a", { costUsd: 2 }), testRow("t-b", { costUsd: 3 })],
    });
    view.setData([after]);
    const text = screenText(view.render(viewport));
    expect(text).toContain("$3.00");
    const action = view.handleKey({ key: "enter" }, viewport);
    expect(action).toMatchObject({ kind: "openLog", title: "agent-a / t-b" });
  });
});
