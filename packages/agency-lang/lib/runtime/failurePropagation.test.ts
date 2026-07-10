import { describe, it, expect } from "vitest";
import { failure, propagateFailure } from "./result.js";

describe("propagateFailure", () => {
  it("failure() initializes skippedFunctions to an empty array", () => {
    const f = failure("boom");
    expect(f.skippedFunctions).toEqual([]);
  });

  it("appends a skip entry, preserving every other field, without mutating the original", () => {
    const orig = failure("boom", {
      functionName: "getReport",
      retryable: true,
      checkpoint: { step: 3 },
      args: { id: "abc" },
    });
    const propagated = propagateFailure(orig, { name: "wordCount", param: "text" });
    expect(propagated.skippedFunctions).toEqual([{ name: "wordCount", param: "text" }]);
    expect(propagated.error).toBe("boom");
    expect(propagated.functionName).toBe("getReport");
    expect(propagated.retryable).toBe(true);
    expect(propagated.checkpoint).toEqual({ step: 3 });
    expect(propagated.args).toEqual({ id: "abc" });
    expect(orig.skippedFunctions).toEqual([]);
  });

  it("accumulates entries across hops", () => {
    const orig = failure("boom");
    const hop1 = propagateFailure(orig, { name: "a", param: "x" });
    const hop2 = propagateFailure(hop1, { name: "b", param: "y" });
    expect(hop2.skippedFunctions).toEqual([
      { name: "a", param: "x" },
      { name: "b", param: "y" },
    ]);
  });
});
