import { describe, expect, it } from "vitest";

import { InfoScreen } from "./infoScreen.js";
import { runRow, screenText, testRow } from "./viewTestUtils.js";

const viewport = { rows: 40, cols: 120 };

describe("InfoScreen", () => {
  it("shows command, per-test statuses, and warnings", () => {
    const view = new InfoScreen("r-1");
    view.setData([runRow("r-1", {
      command: "claude -p {task}",
      warnings: ["could not parse config.json"],
      tests: [testRow("t-a", { status: "failed" })],
    })]);

    const text = screenText(view.render(viewport));
    expect(text).toContain("claude -p {task}");
    expect(text).toContain("t-a: failed");
    expect(text).toContain("could not parse config.json");
    expect(text).toContain("[run info]");
  });

  it("Esc and i back out; q quits", () => {
    const view = new InfoScreen("r-1");
    expect(view.handleKey({ key: "escape" })).toEqual({ kind: "back" });
    expect(view.handleKey({ key: "i" })).toEqual({ kind: "back" });
    expect(view.handleKey({ key: "q" })).toEqual({ kind: "quit" });
  });
});
