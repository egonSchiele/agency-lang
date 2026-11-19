import { describe, it, expect } from "vitest";
import { _resolveRunPolicy } from "./runPolicy.js";
import { builtinPolicy } from "../runtime/builtinPolicies.js";

describe("_resolveRunPolicy", () => {
  it("gives null when no flag is given", () => {
    expect(_resolveRunPolicy({}, "/x")).toEqual({ success: true, value: null });
  });

  it("approves what --approve names", () => {
    const result = _resolveRunPolicy({ approve: "std::read" }, "/x");
    expect(result.success && result.value?.["std::read"]).toEqual([{ action: "approve" }]);
  });

  it("gives a built-in policy's rules", () => {
    const result = _resolveRunPolicy({ policy: "minimal" }, "/x");
    expect(result.success && result.value).toEqual(builtinPolicy("minimal", "/x"));
  });

  it("fails on an unknown policy name", () => {
    const result = _resolveRunPolicy({ policy: "bogus" }, "/x");
    expect(!result.success && result.error).toMatch(/unknown policy "bogus"/);
  });
});
