import { describe, expect, it } from "vitest";

import type { Element } from "../../tui/elements.js";
import { DEFAULT_THRESHOLDS } from "../thresholds.js";
import { leaf, span, trace } from "../timeline/fixture.js";
import { OccurrencesView } from "./occurrencesView.js";
import type { TreeNode } from "../types.js";

const viewport = { rows: 20, cols: 120 };

function flat(el: Element): string[] {
  if (el.type === "text") return [el.content ?? ""];
  return (el.children ?? []).flatMap(flat);
}

function bashTool(id: string, at: number, command: string, children: TreeNode[] = []): TreeNode {
  return span(
    "toolExecution",
    [
      leaf("toolCallStart", at, { toolName: "bash", args: { command } }),
      ...children,
      leaf("toolCall", at + 500, { toolName: "bash" }),
    ],
    { id },
  );
}

function forest(): TreeNode[] {
  const b1 = bashTool("b1", 1_000, "ls -la");
  const withChild = bashTool("b2", 3_000, "compound", [
    span("llmCall", [leaf("promptCompletion", 3_300, { model: '"m"' })], { id: "nested" }),
  ]);
  const agent = span(
    "toolExecution",
    [
      leaf("toolCallStart", 500, { toolName: "codeAgent" }),
      b1,
      withChild,
      leaf("toolCall", 5_000, { toolName: "codeAgent" }),
    ],
    { id: "agent" },
  );
  const root = span("agentRun", [leaf("agentStart", 0, { entryNode: "main" }), agent], {
    id: "root",
  });
  return [trace([root])];
}

describe("OccurrencesView", () => {
  it("lists calls chronologically with the shared path lifted into the header", () => {
    const view = new OccurrencesView(forest(), "T", "bash", DEFAULT_THRESHOLDS);
    expect(view.occurrenceIds()).toEqual(["b1", "b2"]);
    const text = flat(view.render(viewport)).join("\n");
    expect(text).toContain("(all under agentRun » codeAgent)");
    expect(text).toContain("ls -la");
  });

  it("Enter on a leaf opens detail; on a call with children opens a drilled flame", () => {
    const view = new OccurrencesView(forest(), "T", "bash", DEFAULT_THRESHOLDS);
    expect(view.handleKey({ key: "enter" }, viewport)).toEqual({
      kind: "openDetail",
      spanId: "b1",
    });
    view.handleKey({ key: "down" }, viewport);
    expect(view.handleKey({ key: "enter" }, viewport)).toEqual({
      kind: "openFlameAt",
      spanId: "b2",
    });
  });

  it("escape and left go back to by-name", () => {
    const view = new OccurrencesView(forest(), "T", "bash", DEFAULT_THRESHOLDS);
    expect(view.handleKey({ key: "escape" }, viewport)).toEqual({ kind: "back" });
    expect(view.handleKey({ key: "left" }, viewport)).toEqual({ kind: "back" });
  });

  it("the prefix cut lands on a segment boundary, never mid-name", () => {
    const helperCall = bashTool("h1", 1_000, "x");
    const helper = span(
      "toolExecution",
      [
        leaf("toolCallStart", 900, { toolName: "codeAgentHelper" }),
        helperCall,
        leaf("toolCall", 2_000, { toolName: "codeAgentHelper" }),
      ],
      { id: "helper" },
    );
    const mainCall = bashTool("m1", 3_000, "y");
    const agent = span(
      "toolExecution",
      [
        leaf("toolCallStart", 500, { toolName: "codeAgent" }),
        mainCall,
        leaf("toolCall", 4_000, { toolName: "codeAgent" }),
      ],
      { id: "agent" },
    );
    const root = span("agentRun", [leaf("agentStart", 0, { entryNode: "main" }), helper, agent], {
      id: "root",
    });
    const view = new OccurrencesView([trace([root])], "T", "bash", DEFAULT_THRESHOLDS);
    expect(view.header()).toBe("agentRun » ");
    const text = flat(view.render(viewport)).join("\n");
    expect(text).toContain("codeAgentHelper");
    expect(text).toContain("codeAgent");
  });

  it("a vanished group after setData notes it and backs out on the next key", () => {
    const view = new OccurrencesView(forest(), "T", "bash", DEFAULT_THRESHOLDS);
    const empty = [
      trace([span("agentRun", [leaf("agentStart", 0, { entryNode: "main" })], { id: "root" })]),
    ];
    view.setData(empty);
    expect(flat(view.render(viewport)).join("\n")).toContain("no longer exists");
    expect(view.handleKey({ key: "down" }, viewport)).toEqual({ kind: "back" });
  });
});
