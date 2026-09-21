import { it, expect } from "vitest";
import { resolveDetailNode } from "./detailTarget.js";
import { DetailScreen } from "./views/detailScreen.js";
import { DEFAULT_THRESHOLDS } from "./thresholds.js";
import { buildForest } from "./tree.js";
import type { EventEnvelope } from "./types.js";
function loopForest(completed: boolean) {
  const event = (
    spanId: string,
    type: string,
    at: number,
    extra: Record<string, unknown> = {},
  ): EventEnvelope => ({
    format_version: 1,
    trace_id: "T",
    project_id: "",
    span_id: spanId,
    parent_span_id: null,
    data: { type, timestamp: new Date(at).toISOString(), ...extra },
  });
  const events = [
    event("other", "promptStart", 0),
    event("L", "promptCompletion", 1000, { completion: { output: "first answer" } }),
    event("L", "promptCompletion", 2000, {
      completion: { output: "second answer" },
      usage: { inputTokens: 17, cachedInputTokens: 31, outputTokens: 9 },
    }),
  ];
  if (completed) {
    events.push(
      event("other", "promptCompletion", 3000, { completion: { output: "other answer" } }),
    );
  }
  return buildForest(events);
}
it("resolves the second round again when an earlier prompt hides and leaf ids shift", () => {
  const before = loopForest(false);
  const after = loopForest(true);
  const id = "round:L:1";
  expect(resolveDetailNode(before, id)?.event?.data.completion.output).toBe("second answer");
  expect(resolveDetailNode(before, id)?.id).not.toBe(resolveDetailNode(after, id)?.id);
  expect(resolveDetailNode(after, id)?.event?.data.completion.output).toBe("second answer");
  expect(resolveDetailNode(after, "L")?.id).toBe("L");
  const detail = new DetailScreen(before, id, DEFAULT_THRESHOLDS);
  detail.setData(after);
  expect(detail.allLines(120).join("\n")).toContain("second answer");
  expect(detail.allLines(120).join("\n")).toContain("48 context (31 cached) / 9 out");
});
