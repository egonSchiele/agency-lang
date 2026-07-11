import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { resolveRunPolicy } from "./runPolicy.js";

describe("resolveRunPolicy", () => {
  it("returns null when no policy flags are set", () => {
    expect(resolveRunPolicy({ cwd: "/x" })).toBeNull();
  });

  it("resolves a built-in name", () => {
    const r = resolveRunPolicy({ policy: "recommended", cwd: "/x" });
    const p = JSON.parse(r!.policyJson);
    expect(p["std::read"]).toEqual([{ action: "approve" }]);
    expect(r!.interactive).toBe(false);
  });

  it("loads and validates a policy file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pol-"));
    const file = path.join(dir, "p.json");
    writeFileSync(file, JSON.stringify({ "std::read": [{ action: "approve" }] }));
    const r = resolveRunPolicy({ policy: file, cwd: "/x" });
    expect(JSON.parse(r!.policyJson)["std::read"]).toEqual([{ action: "approve" }]);
  });

  it("throws on an unknown name that is not a file", () => {
    expect(() => resolveRunPolicy({ policy: "bogus", cwd: "/x" })).toThrow(/bogus/);
  });

  it("throws on an invalid policy file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pol-"));
    const file = path.join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ "std::read": "nope" }));
    expect(() => resolveRunPolicy({ policy: file, cwd: "/x" })).toThrow();
  });

  it("builds a standalone policy from inline --approve/--reject", () => {
    const r = resolveRunPolicy({
      approve: "std::read, std::ls",
      reject: "std::write",
      cwd: "/x",
    });
    const p = JSON.parse(r!.policyJson);
    expect(p["std::read"]).toEqual([{ action: "approve" }]);
    expect(p["std::ls"]).toEqual([{ action: "approve" }]);
    expect(p["std::write"]).toEqual([{ action: "reject" }]);
  });

  it("splits effect lists on commas and/or whitespace", () => {
    const r = resolveRunPolicy({ approve: "std::read std::ls,std::grep", cwd: "/x" });
    const p = JSON.parse(r!.policyJson);
    expect(p["std::read"]).toEqual([{ action: "approve" }]);
    expect(p["std::ls"]).toEqual([{ action: "approve" }]);
    expect(p["std::grep"]).toEqual([{ action: "approve" }]);
  });

  it("layers inline over a built-in base, inline first", () => {
    const r = resolveRunPolicy({
      policy: "recommended",
      reject: "std::read",
      cwd: "/x",
    });
    const p = JSON.parse(r!.policyJson);
    // reject rule prepended ahead of the built-in's approve rule
    expect(p["std::read"]).toEqual([
      { action: "reject" },
      { action: "approve" },
    ]);
  });

  it("rejects on overlap: reject rule sits ahead of approve", () => {
    const r = resolveRunPolicy({
      approve: "std::write",
      reject: "std::write",
      cwd: "/x",
    });
    const p = JSON.parse(r!.policyJson);
    expect(p["std::write"][0]).toEqual({ action: "reject" });
  });

  it("installs a handler for --interactive alone (empty base)", () => {
    const r = resolveRunPolicy({ interactive: true, cwd: "/x" });
    expect(r).not.toBeNull();
    expect(JSON.parse(r!.policyJson)).toEqual({});
    expect(r!.interactive).toBe(true);
  });

  it("threads cwd into the 'with-writes' base scope", () => {
    const r = resolveRunPolicy({ policy: "with-writes", cwd: "/work" });
    const p = JSON.parse(r!.policyJson);
    expect(p["std::write"]).toEqual([
      { match: { dir: "{/work,/work/**}" }, action: "approve" },
    ]);
  });

  it("leaves base rules for unaffected effects untouched", () => {
    const r = resolveRunPolicy({
      policy: "recommended",
      reject: "std::write",
      cwd: "/x",
    });
    const p = JSON.parse(r!.policyJson);
    // std::read (in base, not in inline flags) keeps its built-in rule
    expect(p["std::read"]).toEqual([{ action: "approve" }]);
    expect(p["std::write"]).toEqual([{ action: "reject" }]);
  });
});
