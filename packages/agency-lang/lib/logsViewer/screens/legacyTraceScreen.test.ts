import { it, expect } from "vitest";
import { LegacyTraceScreen } from "./legacyTraceScreen.js";
import { TreeView } from "../views/treeView.js";
import { buildForest } from "../tree.js";
import { traceEvents } from "../traceFixture.js";
import { DEFAULT_THRESHOLDS } from "../thresholds.js";
it("applies a picker query only to the selected trace payloads", () => {
  const roots = buildForest([
    ...traceEvents("A", { answer: "needle", toolOutput: "needle" }),
    ...traceEvents("B", { answer: "needle", toolOutput: "needle" }),
  ]);
  const tree = new TreeView(roots, DEFAULT_THRESHOLDS, { rows: 20, cols: 120 });
  const screen = new LegacyTraceScreen(tree);
  screen.setTrace("B");
  screen.applySearch("needle");
  expect(tree.cursorTraceId()).toBe("B");
});
