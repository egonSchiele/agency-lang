import { describe, it, expect } from "vitest";
import { policyOverlayFromFlags, splitEffects } from "./policyFlags.js";
import type { Policy } from "./policy.js";

describe("splitEffects", () => {
  it("splits on commas, whitespace, or both", () => {
    expect(splitEffects("std::read,std::ls")).toEqual(["std::read", "std::ls"]);
    expect(splitEffects("std::read, std::ls")).toEqual(["std::read", "std::ls"]);
    expect(splitEffects("std::read std::ls")).toEqual(["std::read", "std::ls"]);
    expect(splitEffects(undefined)).toEqual([]);
    expect(splitEffects("")).toEqual([]);
  });
});

describe("policyOverlayFromFlags", () => {
  it("prepends blanket rules and keeps the base's own rules after them", () => {
    const base: Policy = { "std::read": [{ match: { dir: "/tmp/**" }, action: "reject" }] };
    const out = policyOverlayFromFlags("std::read", undefined, base);
    expect(out["std::read"]).toEqual([
      { action: "approve" },
      { match: { dir: "/tmp/**" }, action: "reject" },
    ]);
  });

  it("puts a reject ahead of an approve for the same effect", () => {
    const out = policyOverlayFromFlags("std::write", "std::write", {});
    expect(out["std::write"]).toEqual([{ action: "reject" }, { action: "approve" }]);
  });

  it("leaves unrelated effects' rules alone", () => {
    const base: Policy = { "std::bash": [{ action: "reject" }] };
    const out = policyOverlayFromFlags("std::read", undefined, base);
    expect(out["std::bash"]).toEqual([{ action: "reject" }]);
    expect(out["std::read"]).toEqual([{ action: "approve" }]);
  });

  it("does not mutate the base policy", () => {
    const base: Policy = { "std::read": [{ action: "reject" }] };
    policyOverlayFromFlags("std::read,std::ls", "std::bash", base);
    expect(base).toEqual({ "std::read": [{ action: "reject" }] });
  });

  it("treats prototype-colliding names as ordinary effect keys", () => {
    const out = policyOverlayFromFlags("toString,__proto__", undefined, {});
    expect(out["toString"]).toEqual([{ action: "approve" }]);
    expect(out["__proto__"]).toEqual([{ action: "approve" }]);
  });

  it("returns an equal policy when both flags are empty", () => {
    const base: Policy = { "std::read": [{ action: "approve" }] };
    expect(policyOverlayFromFlags(undefined, "", base)).toEqual(base);
  });
});
