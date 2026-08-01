// The structural test: flame and by-name must agree about self-time,
// which is the kernel's reason to exist ("a disagreement between two
// classes' private copies would be silent and wrong"). For every group,
// the by-name total equals the sum over the flame view's spans that
// belong to that group — on the synthetic fixture AND the real one.
import { describe, expect, it } from "vitest";

import { DEFAULT_THRESHOLDS } from "../thresholds.js";
import { benchForest, leaf, span, trace } from "../timeline/fixture.js";
import { ByNameView } from "./byNameView.js";
import { FlameView } from "./flameView.js";
import type { TreeNode } from "../types.js";

function agreementHolds(roots: TreeNode[], traceId: string): void {
  const flame = new FlameView(roots, traceId, DEFAULT_THRESHOLDS);
  const byName = new ByNameView(roots, traceId, DEFAULT_THRESHOLDS);
  const selfBySpanId: Record<string, number> = {};
  for (const s of flame.rowSpans()) selfBySpanId[s.id] = s.selfMs;
  for (const group of byName.groupRows()) {
    const flameSum = group.spanIds.reduce((sum, id) => sum + (selfBySpanId[id] ?? 0), 0);
    expect(flameSum).toBeCloseTo(group.totalSelfMs, 5);
  }
}

describe("cross-view agreement", () => {
  it("holds on a synthetic nested fixture", () => {
    const inner = span("toolExecution", [
      leaf("toolCallStart", 200, { toolName: "bash" }),
      leaf("toolCall", 800, { toolName: "bash" }),
    ]);
    const outer = span("llmCall", [
      leaf("promptStart", 0, { threadId: "1" }),
      inner,
      leaf("promptCompletion", 1_000, { model: '"m"', threadId: "1" }),
    ]);
    agreementHolds([trace([outer])], "T");
  });

  it("holds on the real trimmed statelog", () => {
    const roots = benchForest();
    agreementHolds(roots, roots[0].traceId);
  });
});
