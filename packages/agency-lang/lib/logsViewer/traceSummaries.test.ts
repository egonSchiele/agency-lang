import { it, expect } from "vitest";
import { traceEvents, errorEvent } from "./traceFixture.js";
import { buildForest } from "./tree.js";
import { traceSummaries } from "./traceSummaries.js";
// traceSummaries.test.ts
it("summarizes each trace from its rounds and its forest totals", () => {
  const roots = buildForest(traceEvents("A", { answer: "hi", toolOutput: "out" }));
  const [summary] = traceSummaries(roots, { A: "notes · score 0.70" });
  expect(summary).toMatchObject({
    traceId: "A",
    rounds: 1,
    ask: "ask for A",
    annotation: "notes · score 0.70",
    hasError: false,
  });
});

it("knows when a trace holds an error", () => {
  const events = [...traceEvents("A", { answer: "hi", toolOutput: "out" }), errorEvent("A")];
  expect(traceSummaries(buildForest(events), {})[0].hasError).toBe(true);
});

it("does not read inherited annotations", () => {
  const root = buildForest(traceEvents("__proto__", { answer: "hi", toolOutput: "out" }));
  expect(traceSummaries(root, {})[0].annotation).toBeUndefined();
});
