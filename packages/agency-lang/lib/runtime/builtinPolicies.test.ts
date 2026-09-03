import { describe, it, expect } from "vitest";
import picomatch from "picomatch";
import {
  builtinPolicy,
  builtinPolicyNames,
  BUILTIN_POLICIES,
  approveAllPolicy,
} from "./builtinPolicies.js";

describe("builtinPolicy", () => {
  it("resolves 'recommended' with reads scoped by token and no write rule", () => {
    const p = builtinPolicy("recommended", "/tmp/base");
    expect(p).not.toBeNull();
    // Both rules are tokens the matcher resolves at match time, so a saved
    // copy pins neither the launch directory nor the install path.
    for (const effect of ["std::read", "std::readBinary", "std::ls", "std::glob", "std::grep"]) {
      expect(p![effect]).toEqual([
        { match: { dir: "{.,./**}" }, action: "approve" },
        { match: { dir: "{<agency>/stdlib/**,<agency>/dist/**}" }, action: "approve" },
        { match: { dir: "{<agent-home>/skills/**,<agent-home>/tools/**}" }, action: "approve" },
      ]);
    }
    // No std::write rule at all: the toolbox use count goes through its
    // own effect, never a write approval.
    expect(p!["std::write"]).toBeUndefined();
  });

  it("scopes every scan like a read under 'recommended' and omits them under 'minimal'", () => {
    const scans = ["std::toolbox::scan", "std::skills::skillsDir", "std::skills::commandsDir"];
    for (const effect of scans) {
      expect(builtinPolicy("recommended", "/tmp/base")![effect]).toEqual(
        builtinPolicy("recommended", "/tmp/base")!["std::read"],
      );
      expect(builtinPolicy("minimal", "/tmp/base")![effect]).toBeUndefined();
    }
  });

  it("approves the toolbox use count only under the agent home's toolbox", () => {
    expect(builtinPolicy("recommended", "/tmp/base")!["std::toolbox::recordUse"]).toEqual([
      { match: { dir: "<agent-home>/tools/**" }, action: "approve" },
    ]);
    expect(builtinPolicy("minimal", "/tmp/base")!["std::toolbox::recordUse"]).toBeUndefined();
  });

  it("leaves the save and review gates undecided under every built-in but approve-all", () => {
    for (const name of ["recommended", "minimal", "with-writes"]) {
      const p = builtinPolicy(name, "/tmp/base")!;
      for (const effect of [
        "std::skills::save",
        "std::skills::review",
        "std::toolbox::save",
        "std::toolbox::review",
      ]) {
        expect(p[effect]).toBeUndefined();
      }
    }
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
