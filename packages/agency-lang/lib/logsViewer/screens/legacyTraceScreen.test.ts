import { ScreenHost } from "../screenHost.js";
import { PlaceholderScreen } from "./placeholderScreen.js";
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
  const screen = new LegacyTraceScreen(tree, roots, "A");
  screen.setTrace("B");
  screen.applySearch("needle");
  expect(tree.cursorTraceId()).toBe("B");
});

it("bounds navigation and follow updates to the selected trace while retaining other traces", () => {
  const roots = buildForest([
    ...traceEvents("A", { answer: "alpha", toolOutput: "alpha" }),
    ...traceEvents("B", { answer: "beta", toolOutput: "beta" }),
  ]);
  const viewport = { rows: 20, cols: 120 };
  const tree = new TreeView(roots, DEFAULT_THRESHOLDS, viewport, { focusTraceId: "B" });
  const screen = new LegacyTraceScreen(tree, roots, "B");
  screen.handleKey({ key: "g" }, viewport);
  expect(tree.cursorTraceId()).toBe("B");
  screen.setData(roots);
  screen.handleKey({ key: "g" }, viewport);
  expect(tree.cursorTraceId()).toBe("B");
  screen.applySearch("beta");
  screen.setTrace("A");
  expect(tree.hasActiveSearch()).toBe(false);
  screen.handleKey({ key: "g" }, viewport);
  expect(tree.cursorTraceId()).toBe("A");
  screen.setFocus("trace-B");
  expect(tree.cursorTraceId()).toBe("A");
  screen.setData([]);
  expect(tree.cursorTraceId()).toBe("");
});
it("normal slash search cannot leave the selected trace", () => {
  const roots = buildForest([
    ...traceEvents("A", { answer: "alpha", toolOutput: "alpha" }),
    ...traceEvents("B", { answer: "beta", toolOutput: "beta" }),
  ]);
  const viewport = { rows: 20, cols: 120 };
  const tree = new TreeView(roots, DEFAULT_THRESHOLDS, viewport, { focusTraceId: "B" });
  const screen = new LegacyTraceScreen(tree, roots, "B");
  const action = screen.handleKey({ key: "/" }, viewport);
  expect(action.kind).toBe("promptLine");
  if (action.kind === "promptLine") {
    action.onResult("alpha");
  }
  expect(tree.cursorTraceId()).toBe("B");
  expect(tree.messageBar()).toContain("no matches");
});

it("opens the chosen trace root so its children can be read", () => {
  const roots = buildForest([
    ...traceEvents("A", { answer: "alpha", toolOutput: "alpha" }),
    ...traceEvents("B", { answer: "beta", toolOutput: "beta" }),
  ]);
  const viewport = { rows: 20, cols: 120 };
  const tree = new TreeView(roots, DEFAULT_THRESHOLDS, viewport, { focusTraceId: "A" });
  const screen = new LegacyTraceScreen(tree, roots, "A");
  screen.setTrace("B");
  screen.handleKey({ key: "j" }, viewport);
  expect(tree.cursorRowId()).not.toBe("trace-B");
  expect(tree.cursorTraceId()).toBe("B");
});

it("selecting the active trace screen retains its leaf cursor", () => {
  const roots = buildForest(traceEvents("A", { answer: "needle", toolOutput: "done" }));
  const tree = new TreeView(roots, DEFAULT_THRESHOLDS, { rows: 20, cols: 120 });
  const screen = new LegacyTraceScreen(tree, roots, "A");
  screen.applySearch("needle");
  const cursor = tree.cursorRowId();
  const host = new ScreenHost(
    {
      trace: screen,
      overview: new PlaceholderScreen("overview", ""),
      transcript: new PlaceholderScreen("transcript", ""),
      timeline: screen,
    },
    "trace",
    "A",
  );
  host.switchTo("trace");
  expect(tree.cursorRowId()).toBe(cursor);
});
