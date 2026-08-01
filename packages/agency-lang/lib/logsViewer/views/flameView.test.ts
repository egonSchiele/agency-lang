import { describe, expect, it } from "vitest";

import type { Element } from "../../tui/elements.js";
import { DEFAULT_THRESHOLDS } from "../thresholds.js";
import { benchForest, leaf, span, trace } from "../timeline/fixture.js";
import { FlameView } from "./flameView.js";
import type { TreeNode } from "../types.js";

const viewport = { rows: 24, cols: 120 };

function flat(el: Element): string[] {
  if (el.type === "text") return [el.content ?? ""];
  return (el.children ?? []).flatMap(flat);
}

function frame(view: FlameView, vp = viewport): string {
  return flat(view.render(vp)).join("\n");
}

function fixtureForest(): TreeNode[] {
  const bash = span("toolExecution", [
    leaf("toolCallStart", 2_000, { toolName: "bash", args: { command: "pip install matplotlib" } }),
    leaf("toolCall", 6_000, { toolName: "bash" }),
  ], { id: "bash1" });
  const innerLlm = span("llmCall", [
    leaf("promptCompletion", 60_000, {
      model: '"claude-sonnet-5"', threadId: "5", timeTaken: 59_000,
      messages: [{ role: "user", content: "solve the gcode puzzle" }],
    }),
    bash,
  ], { id: "llm1" });
  const admin = span("handlerChain", [leaf("handlerDecision", 2_500)], { id: "admin1" });
  const agent = span("toolExecution", [
    leaf("toolCallStart", 500, { toolName: "codeAgent", args: { userMsg: "do the task" } }),
    admin,
    innerLlm,
    leaf("toolCall", 61_000, { toolName: "codeAgent" }),
  ], { id: "agent1" });
  const root = span("agentRun", [leaf("agentStart", 0, { entryNode: "main" }), agent, leaf("agentEnd", 61_500)], { id: "root1" });
  return [trace([leaf("threadCreated", 0, { threadId: "5", label: "codingAgent" }), root])];
}

describe("FlameView", () => {
  it("labels: llm shows the asked question, tools show their argument, never the model", () => {
    const view = new FlameView(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    const text = frame(view);
    expect(text).toContain("llm · solve the gcode puzzle");
    expect(text).toContain("bash · pip install matplotlib");
    expect(text).not.toContain("claude-sonnet-5");
  });

  it("admin spans are hidden by default; a reveals them and marks the header", () => {
    const view = new FlameView(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    expect(frame(view)).not.toContain("handlerChain");
    view.handleKey({ key: "a" }, viewport);
    const shown = frame(view);
    expect(shown).toContain("handlerChain");
    expect(shown).toContain("[admin spans shown]");
  });

  it("drill re-roots on the selected span with breadcrumbs; ← climbs out", () => {
    const view = new FlameView(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    view.handleKey({ key: "down" }, viewport);       // → codeAgent row
    view.handleKey({ key: "enter" }, viewport);      // drill in
    const drilled = frame(view);
    expect(drilled).toContain("» codeAgent");
    expect(drilled).not.toContain("agentRun");
    view.handleKey({ key: "left" }, viewport);
    expect(frame(view)).toContain("agentRun");
  });

  it("Enter on a leaf opens the detail screen for that span", () => {
    const view = new FlameView(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    view.handleKey({ key: "G" }, viewport);           // last row = bash (leaf)
    const action = view.handleKey({ key: "enter" }, viewport);
    expect(action).toEqual({ kind: "openDetail", spanId: "bash1" });
  });

  it("o returns focusInTree with the cursor span id", () => {
    const view = new FlameView(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    view.handleKey({ key: "down" }, viewport);
    expect(view.handleKey({ key: "o" }, viewport))
      .toEqual({ kind: "focusInTree", spanId: "agent1" });
  });

  it("zoom halves the window around the cursor span; 0 resets; pan clamps", () => {
    const view = new FlameView(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    const full = view.currentWindow();
    view.handleKey({ key: "+" }, viewport);
    const zoomed = view.currentWindow();
    expect(zoomed.end - zoomed.start).toBeCloseTo((full.end - full.start) / 2, 3);
    view.handleKey({ key: "]" }, viewport);
    const panned = view.currentWindow();
    expect(panned.start).toBeGreaterThanOrEqual(full.start);
    expect(panned.end).toBeLessThanOrEqual(full.end);
    view.handleKey({ key: "0" }, viewport);
    expect(view.currentWindow()).toEqual(full);
  });

  it("total/self appears only when they differ", () => {
    const view = new FlameView(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    const text = frame(view);
    expect(text).toMatch(/1m0[12]s\/\d+m?\d*/);       // wrapping span shows total/self
    expect(text).toMatch(/ 4\.0s(?!\/)/);              // leaf bash shows plain total
  });

  it("search jumps the cursor; n advances; a miss reports via the footer", () => {
    const view = new FlameView(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    const action = view.handleKey({ key: "/" }, viewport);
    expect(action.kind).toBe("promptLine");
    if (action.kind === "promptLine") action.onResult("pip install");
    expect(view.cursorSpanId()).toBe("bash1");
    const miss = view.handleKey({ key: "/" }, viewport);
    if (miss.kind === "promptLine") miss.onResult("zzz-nothing");
    expect(frame(view)).toContain('no matches for "zzz-nothing"');
  });

  it("paging moves the cursor by viewport rows", () => {
    const view = new FlameView(benchForest(), benchForest()[0].traceId, DEFAULT_THRESHOLDS);
    const before = view.cursorSpanId();
    view.handleKey({ key: "f", ctrl: true }, viewport);
    expect(view.cursorSpanId()).not.toBe(before);
  });

  it("setData keeps the cursor span and, when unzoomed, extends the axis", () => {
    const forest = fixtureForest();
    const view = new FlameView(forest, "T", DEFAULT_THRESHOLDS);
    view.handleKey({ key: "G" }, viewport);
    const keptId = view.cursorSpanId();
    const grown = fixtureForest();
    grown[0].children.push(
      span("toolExecution", [
        leaf("toolCallStart", 70_000, { toolName: "write" }),
        leaf("toolCall", 90_000, { toolName: "write" }),
      ], { id: "late1" }),
    );
    view.setData(grown);
    expect(view.cursorSpanId()).toBe(keptId);
    expect(view.currentWindow().end).toBeGreaterThanOrEqual(90_000);
  });

  it("setData does NOT move the window while zoomed", () => {
    const view = new FlameView(fixtureForest(), "T", DEFAULT_THRESHOLDS);
    view.handleKey({ key: "+" }, viewport);
    const zoomed = view.currentWindow();
    const grown = fixtureForest();
    grown[0].children.push(
      span("toolExecution", [
        leaf("toolCallStart", 70_000, { toolName: "write" }),
        leaf("toolCall", 90_000, { toolName: "write" }),
      ], { id: "late1" }),
    );
    view.setData(grown);
    expect(view.currentWindow()).toEqual(zoomed);
  });

  it("drillTo starts re-rooted (the openFlameAt path)", () => {
    const view = new FlameView(fixtureForest(), "T", DEFAULT_THRESHOLDS, { drillTo: "agent1" });
    const text = frame(view);
    expect(text).toContain("» codeAgent");
    expect(text).not.toContain("agentRun");
  });

  it("renders the real trimmed statelog without falling over (layout regression net)", () => {
    const roots = benchForest();
    const view = new FlameView(roots, roots[0].traceId, DEFAULT_THRESHOLDS);
    const lines = flat(view.render({ rows: 30, cols: 120 }));
    expect(lines.length).toBeGreaterThan(10);
    expect(lines[0]).toContain("TIMELINE [flame]");
  });
});
