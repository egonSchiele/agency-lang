import { it, expect } from "vitest";
import { TracePicker } from "./tracePicker.js";
import { traceEvents, errorEvent } from "../traceFixture.js";
import { buildForest } from "../tree.js";
import { DEFAULT_THRESHOLDS } from "../thresholds.js";
import type { TreeNode } from "../types.js";
import { layout } from "../../tui/layout.js";
import { render } from "../../tui/render/renderer.js";
import { FrameRecorder } from "../../tui/output/recorder.js";
const viewport = { rows: 20, cols: 120 };
function renderOf(picker: TracePicker): string {
  const recorder = new FrameRecorder();
  recorder.write(render(layout(picker.render(viewport), viewport.cols, viewport.rows)));
  return recorder.lastText();
}
function makePicker(roots: TreeNode[]): TracePicker {
  return new TracePicker(roots, {
    currentTraceId: roots.at(-1)!.traceId,
    annotations: {},
    thresholds: DEFAULT_THRESHOLDS,
  });
}
function renderPicker(roots: TreeNode[]): string {
  return renderOf(makePicker(roots));
}
function press(picker: TracePicker, key: string) {
  return picker.handleKey({ key: key.toLowerCase() === "enter" ? "enter" : key }, viewport);
}
function type(picker: TracePicker, text: string): void {
  for (const key of text) {
    press(picker, key);
  }
}
function threeTraceForest(): TreeNode[] {
  return buildForest([
    ...traceEvents("A", { answer: "def archiveNotes(count) {return 1}", toolOutput: "done" }),
    ...traceEvents("B", { answer: "ArchiveNotes", toolOutput: "archivenotes" }),
    ...traceEvents("C", { answer: "hello", toolOutput: "done" }),
  ]);
}
function fourTraceForestWhereDAlsoMatches(): TreeNode[] {
  return [
    ...threeTraceForest(),
    ...buildForest(traceEvents("D", { answer: "archiveNotes", toolOutput: "done" })),
  ];
}
function forestAsking(ask: string): TreeNode[] {
  return buildForest(traceEvents("A", { answer: "ok", toolOutput: "done", ask }));
}
function threeTraceForestWithErrorInB(): TreeNode[] {
  const roots = threeTraceForest();
  roots[1].children.push(buildForest([errorEvent("B")])[0].children[0]);
  return roots;
}
function cursorLine(text: string): string {
  return text.split("\n").find((row) => row.includes("ask for A")) ?? "";
}
it("lists every trace with its numbers and what it was asked", () => {
  const text = renderPicker(threeTraceForest());
  expect(text).toContain("[TRACES]");
  expect(text).toMatch(/ask for A/);
  expect(text).toMatch(/ask for C/);
});

it("narrows as the query grows, one character at a time", () => {
  const picker = makePicker(threeTraceForest());
  press(picker, "/");
  type(picker, "arch");
  expect(renderOf(picker)).toContain("2 of 3 match");
  type(picker, "iveNotes(");
  expect(renderOf(picker)).toContain("1 of 3 match");
  expect(renderOf(picker)).not.toMatch(/ask for C/);
});

it("while typing, q and digits are text, and the shell is told so", () => {
  const picker = makePicker(threeTraceForest());
  press(picker, "/");
  expect(picker.capturesText!()).toBe(true);
  type(picker, "q1");
  expect(renderOf(picker)).toContain("/ q1");
  press(picker, "Enter");
  expect(picker.capturesText!()).toBe(false);
});

it("shows hit counts and the first hit of the focused trace", () => {
  const picker = makePicker(threeTraceForest());
  press(picker, "/");
  type(picker, "archivenotes");
  const text = renderOf(picker);
  expect(text).toMatch(/hits/);
  expect(text).toContain("first hit:");
});

it("Enter opens the focused trace and carries the query", () => {
  const picker = makePicker(threeTraceForest());
  press(picker, "/");
  type(picker, "archiveNotes");
  press(picker, "Enter"); // stop editing
  expect(press(picker, "Enter")).toEqual({
    kind: "selectTrace",
    traceId: "A",
    query: "archiveNotes",
  });
});

it("Enter with no query carries none", () => {
  expect(press(makePicker(threeTraceForest()), "Enter")).toEqual({
    kind: "selectTrace",
    traceId: "C",
  });
});

it("Esc clears the search first, and only then has nothing left to undo", () => {
  const picker = makePicker(threeTraceForest());
  press(picker, "/");
  type(picker, "arch");
  expect(picker.escape!()).toBe(true);
  expect(renderOf(picker)).toContain("[TRACES]");
  expect(picker.escape!()).toBe(false);
});

it("the cursor moves to a shown trace when its own is filtered out", () => {
  const picker = makePicker(threeTraceForest()); // opens on C, the most recent
  press(picker, "/");
  type(picker, "archiveNotes");
  expect(cursorLine(renderOf(picker))).toMatch(/ask for A/);
});

it("a trace that arrives under follow is listed, and an active query still applies", () => {
  const picker = makePicker(threeTraceForest());
  press(picker, "/");
  type(picker, "archiveNotes");
  picker.setData(fourTraceForestWhereDAlsoMatches());
  expect(renderOf(picker)).toContain("3 of 4 match");
});

it("an ask that looks like a style tag is drawn as written", () => {
  expect(renderPicker(forestAsking("{bold} please"))).toContain("{bold} please");
});

it("marks errors without a second selection marker", () => {
  const text = renderPicker(threeTraceForestWithErrorInB());
  expect(text).not.toContain("●");
  expect(text).toMatch(/✖.*ask for B/);
});

it("keeps annotated rows together while scrolling in display lines", () => {
  const roots = Array.from(
    { length: 20 },
    (_unused, position) =>
      buildForest(traceEvents(`trace${position}`, { answer: "ok", toolOutput: "done" }))[0],
  );
  const annotations = Object.fromEntries(
    roots.map((root) => [root.traceId, `note for ${root.traceId}`]),
  );
  const picker = new TracePicker(roots, {
    currentTraceId: "trace0",
    annotations,
    thresholds: DEFAULT_THRESHOLDS,
  });
  press(picker, "G");
  expect(renderOf(picker)).toContain("ask for trace19");
  press(picker, "g");
  expect(renderOf(picker)).toContain("note for trace0");
});
it("renders the searched picker at 120 columns", () => {
  const roots = threeTraceForest();
  // Use local dates so this snapshot is the same in every timezone.
  roots[0].firstTs = new Date(2026, 8, 22, 16, 37, 19).getTime();
  roots[1].firstTs = new Date(2026, 8, 21, 11, 8, 2).getTime();
  const picker = makePicker(roots);
  press(picker, "/");
  type(picker, "archiveNotes");
  expect(renderOf(picker)).toMatchSnapshot();
});

it("pasted text filters traces and is carried into the selected trace", () => {
  const picker = makePicker(threeTraceForest());
  press(picker, "/");
  type(picker, "arch");
  picker.handleKey({ key: "paste", text: "iveNotes(" }, viewport);
  expect(renderOf(picker)).toContain("1 of 3 match");
  press(picker, "Enter");
  expect(press(picker, "Enter")).toEqual({
    kind: "selectTrace",
    traceId: "A",
    query: "archiveNotes(",
  });
});
