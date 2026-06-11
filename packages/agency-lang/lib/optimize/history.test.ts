import { describe, expect, it } from "vitest";

import { buildMutationHistory } from "./history.js";

describe("buildMutationHistory", () => {
  it("omits the history section when there are no prior entries", () => {
    expect(buildMutationHistory([])).toBe("");
  });

  it("renders the five most recent entries first with rationale and rejected loss reasons", () => {
    const history = buildMutationHistory([
      { iter: 1, decision: "accepted", wins: 2, losses: 1, rationale: "First accepted change. More details.", lossReasons: [] },
      { iter: 2, decision: "rejected", wins: 1, losses: 3, rationale: "Too verbose. More details.", lossReasons: ["Lost clarity", "Missed format", "Too long", "Ignored tone"] },
      { iter: 3, decision: "validation-failed", wins: 0, losses: 0, rationale: "Dropped interpolation.", lossReasons: [] },
      { iter: 4, decision: "accepted", wins: 4, losses: 0, rationale: "Added examples.", lossReasons: [] },
      { iter: 5, decision: "rejected", wins: 0, losses: 2, rationale: "Overfit examples.", lossReasons: ["Worse generalization"] },
      { iter: 6, decision: "accepted", wins: 3, losses: 1, rationale: "Shortened prompt.", lossReasons: [] },
    ]);

    expect(history).toContain("HISTORY (most recent first):");
    expect(history.indexOf("iter 6")).toBeLessThan(history.indexOf("iter 5"));
    expect(history).not.toContain("iter 1");
    expect(history).toContain("mutation: Shortened prompt.");
    expect(history).toContain("judge reasons candidate lost: \"Worse generalization\"");
    expect(history).toContain("\"Lost clarity\", \"Missed format\", \"Too long\"");
    expect(history).not.toContain("Ignored tone");
  });
});
