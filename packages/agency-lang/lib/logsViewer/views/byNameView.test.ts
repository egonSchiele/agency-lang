import { describe, expect, it } from "vitest";

import type { Element } from "../../tui/elements.js";
import { DEFAULT_THRESHOLDS } from "../thresholds.js";
import { benchForest, leaf, span, trace } from "../timeline/fixture.js";
import { ByNameView } from "./byNameView.js";
import type { TreeNode } from "../types.js";

const viewport = { rows: 24, cols: 120 };

function flat(el: Element): string[] {
  if (el.type === "text") return [el.content ?? ""];
  return (el.children ?? []).flatMap(flat);
}

function forest(): TreeNode[] {
  const llmA = span(
    "llmCall",
    [
      leaf("promptCompletion", 30_000, {
        model: '"m1"',
        threadId: "5",
        timeTaken: 29_000,
        messages: [{ role: "user", content: "q" }],
      }),
    ],
    { id: "a" },
  );
  const llmB = span(
    "llmCall",
    [leaf("promptCompletion", 50_000, { model: '"m2"', threadId: "5", timeTaken: 10_000 })],
    { id: "b" },
  );
  const bash = span(
    "toolExecution",
    [
      leaf("toolCallStart", 1_000, { toolName: "bash" }),
      leaf("toolCall", 2_000, { toolName: "bash" }),
    ],
    { id: "t1" },
  );
  return [
    trace([leaf("threadCreated", 0, { threadId: "5", label: "codingAgent" }), llmA, llmB, bash]),
  ];
}

describe("ByNameView", () => {
  it("groups sort by self-time descending, keyed by thread label", () => {
    const view = new ByNameView(forest(), "T", DEFAULT_THRESHOLDS);
    expect(view.groupRows().map((g) => g.key)).toEqual(["llm(codingAgent)", "bash"]);
    expect(view.groupRows()[0].count).toBe(2);
  });

  it("Enter hands the kernel group key to occurrences", () => {
    const view = new ByNameView(forest(), "T", DEFAULT_THRESHOLDS);
    expect(view.handleKey({ key: "enter" }, viewport)).toEqual({
      kind: "openOccurrences",
      groupKey: "llm(codingAgent)",
    });
  });

  it("d opens the detail of the group's LONGEST call", () => {
    const view = new ByNameView(forest(), "T", DEFAULT_THRESHOLDS);
    expect(view.handleKey({ key: "d" }, viewport)).toEqual({ kind: "openDetail", spanId: "a" }); // 29s beats 10s
  });

  it("the footer names the model mix", () => {
    const view = new ByNameView(forest(), "T", DEFAULT_THRESHOLDS);
    expect(flat(view.render(viewport)).join("\n")).toContain("models: m1, m2");
  });

  it("parallel groups may render shares above 100% (spec v2.1)", () => {
    const branchA = span(
      "llmCall",
      [leaf("promptCompletion", 10_000, { model: '"m1"', timeTaken: 10_000 })],
      { id: "pa" },
    );
    const branchB = span(
      "llmCall",
      [leaf("promptCompletion", 10_000, { model: '"m1"', timeTaken: 10_000 })],
      { id: "pb" },
    );
    const fork = span("forkAll", [leaf("forkStart", 0), branchA, branchB]);
    const view = new ByNameView([trace([fork])], "T", DEFAULT_THRESHOLDS);
    const llmGroup = view.groupRows().find((g) => g.key === "llm(m1)")!;
    expect(Math.round(llmGroup.share * 100)).toBe(200);
  });

  it("renders the real trimmed statelog", () => {
    const roots = benchForest();
    const view = new ByNameView(roots, roots[0].traceId, DEFAULT_THRESHOLDS);
    const text = flat(view.render(viewport)).join("\n");
    expect(text).toContain("TIMELINE [byName]");
    expect(view.groupRows().length).toBeGreaterThan(3);
  });
});
