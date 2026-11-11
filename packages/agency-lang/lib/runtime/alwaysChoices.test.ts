import { describe, expect, it } from "vitest";
import {
  MAX_FOLDER_CHOICES,
  describeScope,
  folderChoices,
  inSharedApprovalSet,
  resolvedScopes,
  sharedApprovalSet,
} from "./alwaysChoices.js";

const under = (field: string) => ({ field, matchSubpaths: true });
const exact = (field: string) => ({ field, matchSubpaths: false });

describe("describeScope", () => {
  it("prints an exact field", () => {
    expect(describeScope([exact("name")], { name: "HOME" })).toBe("name = HOME");
  });
  it("prints a subpath field with 'and below'", () => {
    expect(describeScope([under("dir")], { dir: "/x/y" })).toBe("dir = /x/y and below");
  });
  it("joins several fields with a comma", () => {
    const data = { method: "GET", baseUrl: "https://a.b" };
    expect(describeScope([exact("method"), exact("baseUrl")], data)).toBe(
      "method = GET, baseUrl = https://a.b",
    );
  });
});

describe("folderChoices", () => {
  const dirs = { cwd: "/Users/me/proj", home: "/Users/me" };
  const paths = (value: string, where = dirs) => folderChoices(value, where).map((c) => c.path);

  it("stops at the launch directory for a folder inside it", () => {
    expect(folderChoices("/Users/me/proj/.w/a", dirs)).toEqual([
      { path: "/Users/me/proj/.w/a", note: "" },
      { path: "/Users/me/proj/.w", note: "" },
      { path: "/Users/me/proj", note: "the launch directory" },
    ]);
  });
  it("never offers the home directory", () => {
    expect(paths("/Users/me/bench/jobs")).toEqual(["/Users/me/bench/jobs", "/Users/me/bench"]);
  });
  it("never offers a folder above home, or the root", () => {
    expect(paths("/Users/other/x")).toEqual(["/Users/other/x", "/Users/other"]);
    expect(paths("/etc/ssh/keys")).toEqual(["/etc/ssh/keys", "/etc/ssh", "/etc"]);
    expect(paths("/etc")).toEqual(["/etc"]);
  });
  it("offers nothing for the home directory itself or a folder above it", () => {
    expect(paths("/Users/me")).toEqual([]);
    expect(paths("/Users")).toEqual([]);
    expect(paths("/")).toEqual([]);
  });
  it("compares whole path segments", () => {
    // proj2 is not inside proj, so the list does not stop at /Users/me/proj.
    expect(paths("/Users/me/proj2/x")).toEqual(["/Users/me/proj2/x", "/Users/me/proj2"]);
  });
  it("does not offer the launch directory when it is the home directory", () => {
    const atHome = { cwd: "/Users/me", home: "/Users/me" };
    expect(paths("/Users/me/a/b", atHome)).toEqual(["/Users/me/a/b", "/Users/me/a"]);
  });
  it("returns the folder alone when it is the launch directory", () => {
    expect(folderChoices("/Users/me/proj", dirs)).toEqual([
      { path: "/Users/me/proj", note: "the launch directory" },
    ]);
  });
  it("returns a value that is not an absolute path alone", () => {
    expect(paths("")).toEqual([""]);
    expect(paths("sub/dir")).toEqual(["sub/dir"]);
  });
  it("keeps the nearest folders and the outermost one when there are too many", () => {
    const deep = "/Users/me/proj/a/b/c/d/e/f/g/h/i";
    const choices = folderChoices(deep, dirs);
    expect(choices).toHaveLength(MAX_FOLDER_CHOICES);
    expect(choices[0].path).toBe(deep);
    expect(choices[6].path).toBe("/Users/me/proj/a/b/c");
    expect(choices[7]).toEqual({ path: "/Users/me/proj", note: "the launch directory" });
  });
});

describe("sharedApprovalSet", () => {
  const sets = {
    FileRead: {
      name: "FileRead",
      doc: "",
      members: ["std::read", "std::ls", "std::vision"],
      composedOf: [],
    },
    Other: { name: "Other", doc: "", members: ["std::read", "x::y"], composedOf: [] },
  };
  it("returns the listed set when every known member shares the scope", () => {
    const scopes = { "std::read": [under("dir")], "std::ls": [under("dir")] };
    expect(sharedApprovalSet("std::ls", scopes, sets)?.name).toBe("FileRead");
  });
  it("returns null when a member's scope differs", () => {
    const scopes = { "std::read": [exact("dir")], "std::ls": [under("dir")] };
    expect(sharedApprovalSet("std::ls", scopes, sets)).toBeNull();
  });
  it("returns null when a member's scope was overridden to empty", () => {
    const registered = { "std::read": [under("dir")], "std::ls": [under("dir")] };
    const scopes = resolvedScopes(registered, { "std::read": [] });
    expect(sharedApprovalSet("std::ls", scopes, sets)).toBeNull();
  });
  it("returns null for an effect in no listed set", () => {
    expect(sharedApprovalSet("x::y", { "x::y": [exact("a")] }, sets)).toBeNull();
  });
  it("returns null for an effect with no scope", () => {
    expect(sharedApprovalSet("std::ls", {}, sets)).toBeNull();
  });
  it("says whether an effect is in a listed set", () => {
    expect(inSharedApprovalSet("std::vision", sets)).toBe(true);
    expect(inSharedApprovalSet("x::y", sets)).toBe(false);
  });
});

describe("resolvedScopes", () => {
  it("lets an override replace a registered scope, an empty one included", () => {
    const registered = { "a::b": [under("dir")], "c::d": [exact("x")] };
    expect(resolvedScopes(registered, { "a::b": [] })).toEqual({
      "a::b": [],
      "c::d": [exact("x")],
    });
  });
});
