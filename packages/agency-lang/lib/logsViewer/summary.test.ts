import { describe, it, expect } from "vitest";
import { summarizeSpanStyled } from "./summary.js";
import { TreeNode } from "./treeNode.js";

describe("summarizeSpanStyled", () => {
  const makeNode = (duration?: number, cost?: number): TreeNode =>
    new TreeNode({
      id: "s",
      traceId: "",
      parentId: null,
      nodeKind: "span",
      label: "llmCall",
      summary: "",
      duration,
      cost,
    });

  it("wraps slow durations in bright-red tags", () => {
    const s = summarizeSpanStyled(makeNode(10_000));
    expect(s).toMatch(/\{bright-red-fg\}10\.0s\{\/bright-red-fg\}/);
  });

  it("wraps fast durations in gray tags", () => {
    const s = summarizeSpanStyled(makeNode(50));
    expect(s).toMatch(/\{gray-fg\}50ms\{\/gray-fg\}/);
  });

  it("leaves normal-range durations untagged", () => {
    const s = summarizeSpanStyled(makeNode(500));
    expect(s).toContain("500ms");
    expect(s).not.toMatch(/\{[a-z-]+-fg\}500ms/);
  });

  it("wraps expensive costs in bright-red tags", () => {
    const s = summarizeSpanStyled(makeNode(undefined, 0.05));
    expect(s).toMatch(/\{bright-red-fg\}\$0\.050\{\/bright-red-fg\}/);
  });

  it("does not color token counts", () => {
    const n = makeNode();
    n.tokens = 1500;
    const s = summarizeSpanStyled(n);
    expect(s).toContain("1500 tok");
    expect(s).not.toMatch(/\{[a-z-]+-fg\}1500 tok/);
  });
});
