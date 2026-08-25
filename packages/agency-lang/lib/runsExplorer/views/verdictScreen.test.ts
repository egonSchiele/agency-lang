import { describe, expect, it } from "vitest";

import type { TestDetail } from "../rows.js";
import { VerdictScreen } from "./verdictScreen.js";
import { runRow, screenText, testRow } from "./viewTestUtils.js";

const viewport = { rows: 12, cols: 60 };

const detail: TestDetail = {
  input: '{"assignment":"explain it","sourceFile":"x.md"}',
  output: { kind: "output", text: '[{"error":true,"feedback":"too long"}]' },
  graders: [
    {
      key: "grader:graders.ts:names-the-flaws",
      name: "names-the-flaws",
      score: { kind: "scalar", value: 0.25 },
      weight: 1,
      mustPass: false,
      feedback: "one of four points covered, ".repeat(6).trim(),
      annotator: "graders.ts@abc",
    },
  ],
};

function screen(graderKey = "grader:graders.ts:names-the-flaws"): VerdictScreen {
  const built = new VerdictScreen("r-1", "t1", graderKey);
  built.setData([
    runRow("r-1", {
      agent: "gcode",
      tests: [testRow("t1", { detail, statelogPath: "/logs/t1.jsonl", traceId: "tr-1" })],
    }),
  ]);
  return built;
}

describe("VerdictScreen", () => {
  it("shows the score, the feedback, and the input and output as pretty JSON", () => {
    const lines = screen()
      .pageLines(200)
      .map((entry) => entry.text);
    expect(lines[0]).toBe("score:    0.25");
    expect(lines).toContain("── feedback ──");
    expect(lines).toContain("── input ──");
    expect(lines).toContain('  "assignment": "explain it",');
    expect(lines).toContain("── output ──");
    expect(lines).toContain('    "feedback": "too long"');
    expect(screenText(screen().render(viewport))).toContain(
      "VERDICT  names-the-flaws on t1 — 0.25",
    );
  });

  it("wraps long feedback to the width and scrolls against the wrapped count", () => {
    const built = screen();
    const total = built.pageLines(viewport.cols).length;
    expect(total).toBeGreaterThan(viewport.rows);
    built.handleKey({ key: "G" }, viewport);
    const text = screenText(built.render(viewport));
    expect(text).toContain(`${total} of ${total}`);
    expect(built.handleKey({ key: "escape" }, viewport)).toEqual({ kind: "back" });
  });

  it("o opens the test's log without leaving the verdict", () => {
    expect(screen().handleKey({ key: "o" }, viewport)).toEqual({
      kind: "openLog",
      statelogPath: "/logs/t1.jsonl",
      title: "gcode / t1",
      traceId: "tr-1",
    });
  });

  it("names a verdict it cannot find rather than rendering blank", () => {
    expect(screenText(screen("missing").render(viewport))).toContain("no verdict missing");
  });
});
