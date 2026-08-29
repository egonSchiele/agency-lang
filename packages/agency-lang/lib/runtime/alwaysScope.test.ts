import { describe, it, expect } from "vitest";
import {
  __registerAlwaysScope,
  adoptAlwaysScope,
  alwaysScopeFor,
  allAlwaysScopes,
} from "./alwaysScope.js";

describe("always-scope registry", () => {
  it("returns [] for an unknown effect", () => {
    expect(alwaysScopeFor("test::never")).toEqual([]);
  });

  it("returns what was registered", () => {
    __registerAlwaysScope("test::a", [{ field: "name", matchSubpaths: false }]);
    expect(alwaysScopeFor("test::a")).toEqual([{ field: "name", matchSubpaths: false }]);
    expect(allAlwaysScopes()["test::a"]).toBeDefined();
  });

  it("ignores an identical re-registration", () => {
    __registerAlwaysScope("test::b", [{ field: "dir", matchSubpaths: true }]);
    __registerAlwaysScope("test::b", [{ field: "dir", matchSubpaths: true }]);
    expect(alwaysScopeFor("test::b")).toHaveLength(1);
  });

  it("throws on a conflicting re-registration", () => {
    __registerAlwaysScope("test::c", [{ field: "dir", matchSubpaths: true }]);
    expect(() =>
      __registerAlwaysScope("test::c", [{ field: "cwd", matchSubpaths: false }]),
    ).toThrow(/test::c/);
  });

  it("does not resolve prototype keys", () => {
    expect(alwaysScopeFor("constructor")).toEqual([]);
  });

  it("returns copies, so callers cannot mutate the registry", () => {
    __registerAlwaysScope("test::d", [{ field: "x", matchSubpaths: false }]);
    alwaysScopeFor("test::d").push({ field: "y", matchSubpaths: false });
    expect(alwaysScopeFor("test::d")).toHaveLength(1);
    allAlwaysScopes()["test::d"].push({ field: "z", matchSubpaths: false });
    expect(alwaysScopeFor("test::d")).toHaveLength(1);
  });

  it("treats an empty registration as a no-op", () => {
    __registerAlwaysScope("test::e", []);
    expect(allAlwaysScopes()["test::e"]).toBeUndefined();
    __registerAlwaysScope("test::f", [{ field: "x", matchSubpaths: false }]);
    expect(() => __registerAlwaysScope("test::f", [])).not.toThrow();
    expect(alwaysScopeFor("test::f")).toHaveLength(1);
  });

  it("adopts a child scope only for an effect it does not know", () => {
    adoptAlwaysScope("test::h", [{ field: "name", matchSubpaths: false }]);
    expect(alwaysScopeFor("test::h")).toEqual([{ field: "name", matchSubpaths: false }]);
    adoptAlwaysScope("test::h", [{ field: "other", matchSubpaths: true }]);
    expect(alwaysScopeFor("test::h")).toEqual([{ field: "name", matchSubpaths: false }]);
  });

  it("ignores a malformed child scope instead of throwing", () => {
    expect(() => adoptAlwaysScope("test::i", "nope")).not.toThrow();
    expect(() => adoptAlwaysScope("test::i", [{ field: 1 }])).not.toThrow();
    expect(() => adoptAlwaysScope("test::i", undefined)).not.toThrow();
    expect(alwaysScopeFor("test::i")).toEqual([]);
  });

  it("accepts the same fields in a different order", () => {
    __registerAlwaysScope("test::g", [
      { field: "a", matchSubpaths: false },
      { field: "b", matchSubpaths: true },
    ]);
    expect(() =>
      __registerAlwaysScope("test::g", [
        { field: "b", matchSubpaths: true },
        { field: "a", matchSubpaths: false },
      ]),
    ).not.toThrow();
  });
});
