import { describe, it, expect } from "vitest";
import picomatch from "picomatch";
import {
  builtinPolicy,
  builtinPolicyNames,
  BUILTIN_POLICIES,
  approveAllPolicy,
  migrateCatchAllReads,
  readScopeRules,
  READ_EFFECTS,
} from "./builtinPolicies.js";

describe("builtinPolicy", () => {
  it("resolves 'recommended' with reads scoped by token and no write rule", () => {
    const p = builtinPolicy("recommended", "/tmp/base");
    expect(p).not.toBeNull();
    // Both rules are tokens the matcher resolves at match time, so a saved
    // copy pins neither the launch directory nor the install path.
    for (const effect of READ_EFFECTS) {
      expect(p![effect]).toEqual([
        { match: { dir: "{.,./**}" }, action: "approve" },
        { match: { dir: "{<agency>/stdlib/**,<agency>/dist/**}" }, action: "approve" },
      ]);
    }
    expect(p!["std::write"]).toBeUndefined();
  });

  it("migrates a saved policy's catch-all reads and leaves edited rules alone", () => {
    const saved = {
      "std::read": [{ action: "approve" as const }],
      "std::ls": [{ action: "approve" as const }],
      // The user scoped this one by hand: not the catch-all, so untouched.
      "std::glob": [{ match: { dir: "/data/**" }, action: "approve" as const }],
      "std::write": [{ action: "approve" as const }],
    };
    const { policy, migrated } = migrateCatchAllReads(saved);
    expect(migrated).toEqual(["std::read", "std::ls"]);
    expect(policy["std::read"]).toEqual(readScopeRules());
    expect(policy["std::ls"]).toEqual(readScopeRules());
    expect(policy["std::glob"]).toEqual(saved["std::glob"]);
    // Only read effects are considered, and the input is not mutated.
    expect(policy["std::write"]).toEqual([{ action: "approve" }]);
    expect(saved["std::read"]).toEqual([{ action: "approve" }]);
    expect(migrateCatchAllReads(policy).migrated).toEqual([]);
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
    expect(p!["std::copy"]).toEqual([{ match: { src: scope, dest: scope }, action: "approve" }]);
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
    expect(builtinPolicyNames()).toEqual(["recommended", "minimal", "with-writes", "approve-all"]);
    expect(BUILTIN_POLICIES).toHaveLength(4);
  });
});
