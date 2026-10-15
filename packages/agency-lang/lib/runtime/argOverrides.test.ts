import { describe, expect, it } from "vitest";
import { __takeArgOverrides } from "./argOverrides.js";

const frame = () => ({ moduleId: "m.agency", scopeName: "plan", args: { spec: 1, note: "a" } });

describe("__takeArgOverrides", () => {
  it("returns undefined and leaves the frame alone when nothing is pending", () => {
    const ctx = {};
    const f = frame();
    expect(__takeArgOverrides(ctx, f, ["spec", "note"])).toBeUndefined();
    expect(f.args).toEqual({ spec: 1, note: "a" });
  });

  it("ignores overrides pending for another frame", () => {
    const pending = { moduleId: "m.agency", scopeName: "other", values: { spec: 2 } };
    const ctx = { _pendingArgOverrides: pending };
    const f = frame();
    expect(__takeArgOverrides(ctx, f, ["spec", "note"])).toBeUndefined();
    expect(f.args.spec).toBe(1);
    expect(ctx._pendingArgOverrides).toBe(pending);
  });

  it("writes the named parameters, clears the pending overrides, and lists the names in declaration order", () => {
    const ctx = {
      _pendingArgOverrides: {
        moduleId: "m.agency",
        scopeName: "plan",
        values: { note: "b", spec: 2, unknown: 3 },
      },
    };
    const f = frame();
    expect(__takeArgOverrides(ctx, f, ["spec", "note"])).toEqual(["spec", "note"]);
    expect(f.args).toEqual({ spec: 2, note: "b" });
    expect(ctx._pendingArgOverrides).toBeUndefined();
  });

  it("returns an empty list when the pending overrides name no parameter", () => {
    const ctx = {
      _pendingArgOverrides: { moduleId: "m.agency", scopeName: "plan", values: { other: 1 } },
    };
    const f = frame();
    expect(__takeArgOverrides(ctx, f, ["spec"])).toEqual([]);
    expect(f.args).toEqual({ spec: 1, note: "a" });
    expect(ctx._pendingArgOverrides).toBeUndefined();
  });
});
