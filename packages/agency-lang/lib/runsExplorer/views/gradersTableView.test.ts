import { describe, expect, it } from "vitest";

import type { GraderVerdict, TestDetail } from "../rows.js";
import { GradersTableView } from "./gradersTableView.js";
import { runRow, screenText, testRow } from "./viewTestUtils.js";

const viewport = { rows: 24, cols: 120 };

function verdict(name: string, over: Partial<GraderVerdict> = {}): GraderVerdict {
  return {
    name,
    score: { kind: "scalar", value: 0.7 },
    weight: 1,
    mustPass: false,
    feedback: `${name} says so\nsecond line`,
    annotator: "graders.ts@abc",
    ...over,
  };
}

const detail: TestDetail = {
  input: "the input",
  output: { kind: "output", text: "the output" },
  graders: [
    verdict("a-judge"),
    verdict("gate", { score: { kind: "binary", pass: false }, mustPass: true }),
  ],
};

function view(over: Partial<TestDetail> | null = {}): GradersTableView {
  const built = new GradersTableView("r-1", "t1");
  const test = over === null ? testRow("t1") : testRow("t1", { detail: { ...detail, ...over } });
  built.setData([runRow("r-1", { agent: "gcode", tests: [test] })]);
  return built;
}

describe("GradersTableView", () => {
  it("renders one row per verdict with its score, gate marker, and first feedback line", () => {
    const text = screenText(view().render(viewport));
    expect(text).toContain("TEST t1 — gcode — score 0.50");
    expect(text).toContain("a-judge");
    expect(text).toContain("0.70");
    expect(text).toContain("a-judge says so");
    expect(text).not.toContain("second line");
    expect(text).toContain("FAIL");
    expect(text).toContain("gate");
    expect(text).toContain("[graders]");
  });

  it("Enter opens the cursor verdict, o opens the test's log; Esc backs out", () => {
    const built = view();
    built.handleKey({ key: "j" }, viewport);
    expect(built.handleKey({ key: "enter" }, viewport)).toEqual({
      kind: "openVerdict",
      runKey: "r-1",
      inputId: "t1",
      graderName: "gate",
    });
    expect(built.handleKey({ key: "o" }, viewport)).toEqual({
      kind: "openLog",
      statelogPath: "/runs/x/inputs/t1/agent/statelog.jsonl",
      title: "gcode / t1",
      traceId: undefined,
    });
    expect(built.handleKey({ key: "escape" }, viewport)).toEqual({ kind: "back" });
  });

  it("says why the table is empty: never graded, or never ran", () => {
    expect(screenText(view({ graders: [] }).render(viewport))).toContain("no grading pass");
    expect(screenText(view(null).render(viewport))).toContain("wrote no trace");
    expect(view(null).handleKey({ key: "enter" }, viewport)).toEqual({ kind: "none" });
  });
});
