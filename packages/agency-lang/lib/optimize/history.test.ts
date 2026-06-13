import { describe, expect, it } from "vitest";

import { buildMutationHistory, type MutationHistoryEntry } from "./history.js";

function entry(overrides: Partial<MutationHistoryEntry> & { iter: number }): MutationHistoryEntry {
  return {
    decision: "accepted",
    winsA: 0,
    winsB: 0,
    rationale: "Some change.",
    operations: [{ target: "foo.agency:global:prompt", op: "replaceInitializer" }],
    lossReasons: [],
    ...overrides,
  };
}

describe("buildMutationHistory", () => {
  it("omits the history section when there are no prior entries", () => {
    expect(buildMutationHistory([])).toBe("");
  });

  it("renders the five most recent entries first with targets, rationale, and rejected loss reasons", () => {
    const history = buildMutationHistory([
      entry({ iter: 1, winsB: 2, winsA: 1, rationale: "First accepted change. More details." }),
      entry({ iter: 2, decision: "rejected", winsB: 1, winsA: 3, rationale: "Too verbose. More details.", lossReasons: ["Lost clarity", "Missed format", "Too long", "Ignored tone"] }),
      entry({ iter: 3, decision: "validation-failed", rationale: "Dropped interpolation." }),
      entry({ iter: 4, winsB: 4, rationale: "Added examples." }),
      entry({ iter: 5, decision: "rejected", winsA: 2, rationale: "Overfit examples.", lossReasons: ["Worse generalization"] }),
      entry({ iter: 6, winsB: 3, winsA: 1, rationale: "Shortened prompt.", operations: [{ target: "foo.agency:bar:prompt", op: "replaceInitializer" }] }),
    ]);

    expect(history).toContain("HISTORY (most recent first):");
    expect(history.indexOf("iter 6")).toBeLessThan(history.indexOf("iter 5"));
    expect(history).not.toContain("iter 1");
    expect(history).toContain("mutation: Shortened prompt.");
    expect(history).toContain("targets: foo.agency:bar:prompt");
    expect(history).toContain("3 wins / 1 losses");
    expect(history).toContain("judge reasons candidate lost: \"Worse generalization\"");
    expect(history).toContain("\"Lost clarity\", \"Missed format\", \"Too long\"");
    expect(history).not.toContain("Ignored tone");
  });
});
