import { describe, it, expect } from "vitest";
import picomatch from "picomatch";
import {
  builtinPolicy,
  builtinPolicyNames,
  BUILTIN_POLICIES,
  approveAllPolicy,
} from "./builtinPolicies.js";

describe("builtinPolicy", () => {
  it("resolves 'recommended' with reads approved and no write rule", () => {
    const p = builtinPolicy("recommended", "/tmp/base");
    expect(p).not.toBeNull();
    expect(p!["std::read"]).toEqual([{ action: "approve" }]);
    expect(p!["std::write"]).toBeUndefined();
  });

  it("resolves 'minimal' with memory approved but reads absent", () => {
    const p = builtinPolicy("minimal", "/tmp/base");
    expect(p!["std::memory::remember"]).toEqual([{ action: "approve" }]);
    expect(p!["std::read"]).toBeUndefined();
  });

  it("scopes 'with-writes' effects on their correct path fields", () => {
    const p = builtinPolicy("with-writes", "/work");
    const scope = "{/work,/work/**}";
    // dir field
    expect(p!["std::write"]).toEqual([{ match: { dir: scope }, action: "approve" }]);
    // target field (remove) — a fat-fingered "dir" here would silently disable scoping
    expect(p!["std::remove"]).toEqual([{ match: { target: scope }, action: "approve" }]);
    // src + dest fields (copy/move)
    expect(p!["std::copy"]).toEqual([
      { match: { src: scope, dest: scope }, action: "approve" },
    ]);
    // cwd field (git)
    expect(p!["std::git::commit"]).toEqual([{ match: { cwd: scope }, action: "approve" }]);
  });

  it("scopes with-writes literally even when baseDir has glob metacharacters", () => {
    const p = builtinPolicy("with-writes", "/a,b");
    const pattern = p!["std::write"][0].match!.dir;
    // Inside the real directory: matches. Widened brace alternatives (/a, b): not.
    expect(picomatch.isMatch("/a,b/file.txt", pattern)).toBe(true);
    expect(picomatch.isMatch("/a/file.txt", pattern)).toBe(false);
    expect(picomatch.isMatch("b", pattern)).toBe(false);
  });

  it("resolves 'approve-all' to a single wildcard approve", () => {
    expect(builtinPolicy("approve-all", "/x")).toEqual(approveAllPolicy);
    expect(approveAllPolicy).toEqual({ "*": [{ action: "approve" }] });
  });

  it("returns null for an unknown name", () => {
    expect(builtinPolicy("bogus", "/x")).toBeNull();
  });

  it("lists the four built-in names", () => {
    expect(builtinPolicyNames()).toEqual([
      "recommended",
      "minimal",
      "with-writes",
      "approve-all",
    ]);
    expect(BUILTIN_POLICIES).toHaveLength(4);
  });
});
