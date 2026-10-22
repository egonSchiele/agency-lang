import { describe, expect, it } from "vitest";
import { filterPalette, paletteEntries } from "./palette.js";
import type { StopView } from "./rows.js";
import { agentShapedCheckpoint } from "../../runtime/state/checkpointPatch/testCheckpoints.js";

function view(): StopView {
  return {
    checkpoint: agentShapedCheckpoint(),
    stop: { branchPath: [], loopStop: "round" },
    viewed: { branchPath: [], loopStop: "round" },
    moduleId: "mod",
    pending: { edits: [], applied: [] },
  };
}

describe("the palette", () => {
  it("lists every edit every row offers, pane by pane, in the table's words", () => {
    const entries = paletteEntries(view());
    const sentences = entries.map((entry) => entry.sentence);
    expect(sentences.some((s) => s.startsWith("append a message to thread main ("))).toBe(true);
    expect(sentences).toContain("set answer in main (now null)");
    expect(sentences).toContain("remove search from this loop");
    expect(sentences).toContain("disarm the guard research (time, 10s of 1m)");
    expect(sentences).toContain("change the budget of the guard research (time, 10s of 1m)");
    // The root budget offers nothing, and a tool call's branch takes no result.
    expect(sentences.some((s) => s.includes("root"))).toBe(false);
    expect(sentences.some((s) => s.includes("tool_0_abc") && s.includes("result"))).toBe(false);
    // Each entry says where its row is, so the UI can move the cursor there.
    const remove = entries.find((entry) => entry.sentence.startsWith("remove search"))!;
    expect(remove.pane).toBe("callStack");
    expect(remove.rowIndex).toBe(2);
    expect(remove.action.name).toBe("remove-tool");
  });

  it("filters by a case-insensitive substring of the sentence", () => {
    const entries = paletteEntries(view());
    expect(filterPalette(entries, "DISARM").map((e) => e.action.name)).toEqual(["disarm-guard"]);
    expect(filterPalette(entries, "  ")).toBe(entries);
    expect(filterPalette(entries, "nothing like this")).toEqual([]);
  });
});
