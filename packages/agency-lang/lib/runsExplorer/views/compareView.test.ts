import { describe, expect, it } from "vitest";

import { CompareView } from "./compareView.js";
import { runRow, screenText } from "./viewTestUtils.js";

const viewport = { rows: 24, cols: 140 };

function rows() {
  return [
    runRow("a1", { agent: "agent-a", suite: "bench", score: 1.0 }),
    runRow("a2", { agent: "agent-a", suite: "bench", score: 0.0 }),
    runRow("a3", { agent: "agent-a", suite: "web", score: null }),
    runRow("b1", { agent: "agent-b", suite: "bench", score: 0.5 }),
    runRow("c1", { agent: "agent-c", suite: "web", score: 0.25 }),
  ];
}

describe("CompareView", () => {
  it("cells are mean × count over graded runs only; objective zero counts", () => {
    const view = new CompareView();
    view.setData(rows());
    const text = screenText(view.render(viewport));
    expect(text).toContain("0.50 ×2");
    expect(text).toContain("0.50 ×1");
    expect(text).toContain("0.25 ×1");
  });

  it("an agent × suite pair with no graded runs renders a dash", () => {
    const view = new CompareView();
    view.setData(rows());
    const text = screenText(view.render(viewport));
    const webRow = text.split("\n").find((line) => line.includes("web"));
    expect(webRow).toBeDefined();
    expect(webRow).toContain("—");
  });

  it("caps the agent columns at the four most frequent", () => {
    const many = rows();
    for (const extra of ["d", "e", "f"]) {
      many.push(runRow(`${extra}1`, { agent: `agent-${extra}`, suite: "bench", score: 0.5 }));
    }
    const view = new CompareView();
    view.setData(many);
    const text = screenText(view.render(viewport));
    expect(text).toContain("agent-a");
    expect((text.match(/agent-/g) ?? []).length).toBeLessThanOrEqual(5);
  });

  it("keys: t/T cycle, Esc backs to the runs table, q quits", () => {
    const view = new CompareView();
    expect(view.handleKey({ key: "t" })).toEqual({ kind: "cycleView", delta: 1 });
    expect(view.handleKey({ key: "escape" })).toEqual({ kind: "back" });
    expect(view.handleKey({ key: "q" })).toEqual({ kind: "quit" });
  });

  it("shows the view tag", () => {
    const view = new CompareView();
    view.setData(rows());
    expect(screenText(view.render(viewport))).toContain("[compare]");
  });
});
