import { describe, it, expect, vi, afterEach } from "vitest";
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

describe("effect sets in flag values", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a set name expands to one blanket rule per member effect", () => {
    const out = policyOverlayFromFlags("FileRead", undefined, {});
    for (const effect of ["std::read", "std::readBinary", "std::ls", "std::glob", "std::grep"]) {
      expect(out[effect]).toEqual([{ action: "approve" }]);
    }
    expect(out["FileRead"]).toBeUndefined();
  });

  it("an effect rejected alongside its approving set gets reject first", () => {
    const out = policyOverlayFromFlags("FileSystem", "std::remove", {});
    expect(out["std::remove"]).toEqual([{ action: "reject" }, { action: "approve" }]);
    expect(out["std::write"]).toEqual([{ action: "approve" }]);
  });

  it("overlapping sets collapse to one rule per effect", () => {
    const out = policyOverlayFromFlags("FileRead,FileSystem", undefined, {});
    expect(out["std::read"]).toEqual([{ action: "approve" }]);
  });

  it("a bare name matching no set passes through as an effect name", () => {
    // Both are legal invocations today: bare effect declarations
    // (`effect confirm { ... }`) and the bare interrupt form, whose
    // effect is named "unknown".
    const out = policyOverlayFromFlags("confirm", "unknown", {});
    expect(out["confirm"]).toEqual([{ action: "approve" }]);
    expect(out["unknown"]).toEqual([{ action: "reject" }]);
  });

  it("warns on stderr for a near-miss of a set name, and still passes it through", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = policyOverlayFromFlags("FileReed", undefined, {});
    expect(out["FileReed"]).toEqual([{ action: "approve" }]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("FileRead");
  });

  it("warns on a case-only mismatch of a set name", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = policyOverlayFromFlags(undefined, "fileread", {});
    expect(out["fileread"]).toEqual([{ action: "reject" }]);
    expect(warn.mock.calls[0][0]).toContain("FileRead");
  });

  it("does not warn on an unrelated bare name", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    policyOverlayFromFlags("confirm", undefined, {});
    expect(warn).not.toHaveBeenCalled();
  });
});
