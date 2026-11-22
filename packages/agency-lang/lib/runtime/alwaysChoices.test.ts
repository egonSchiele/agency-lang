import { describe, expect, it } from "vitest";
import {
  EXACT_PREFIX,
  MAX_FOLDER_CHOICES,
  MAX_PREFIX_CHOICES,
  prefixChoices,
  prefixPattern,
  describeScope,
  folderChoices,
  getsFolderStep,
  inSharedApprovalSet,
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
  it("prints a list field as its items joined with spaces", () => {
    const prefix = { field: "args", matchSubpaths: false, matchPrefix: true };
    const data = { command: "pnpm", args: ["run", "build"], cwd: "/x" };
    expect(describeScope([exact("command"), prefix, under("cwd")], data)).toBe(
      "command = pnpm, args = run build, cwd = /x and below",
    );
  });
});

describe("prefixChoices", () => {
  it("offers the exact list, then each prefix down to one item, narrowest first", () => {
    expect(prefixChoices(0)).toEqual([{ id: EXACT_PREFIX, keep: 0, rest: false }]);
    expect(prefixChoices(1)).toHaveLength(2);
    expect(prefixChoices(5)).toHaveLength(6);
    expect(prefixChoices(2).map((choice) => choice.id)).toEqual(["exact", "2", "1"]);
  });
  it("never offers a prefix of no items, which would cover any arguments", () => {
    expect(prefixChoices(3).some((choice) => choice.keep === 0 && choice.rest)).toBe(false);
  });
  it("keeps the narrowest choices and the widest when there are too many", () => {
    const many = prefixChoices(20);
    expect(many).toHaveLength(MAX_PREFIX_CHOICES);
    expect(many[0].id).toBe(EXACT_PREFIX);
    expect(many[many.length - 1]).toEqual({ id: "1", keep: 1, rest: true });
  });
});

describe("prefixPattern", () => {
  const exactChoice = { id: EXACT_PREFIX, keep: 2, rest: false };
  it("keeps the leading items and adds the rest marker", () => {
    expect(prefixPattern(["run", "a*b"], { id: "1", keep: 1, rest: true })).toEqual(["run", "**"]);
  });
  it("escapes every kept item", () => {
    expect(prefixPattern(["run", "a*b"], exactChoice)).toEqual(["run", "a\\*b"]);
    expect(prefixPattern(["**"], { id: EXACT_PREFIX, keep: 1, rest: false })).toEqual(["\\*\\*"]);
  });
});

describe("folderChoices", () => {
  const dirs = { cwd: "/Users/me/proj", home: "/Users/me", agentHome: "/Users/me/.agency-agent" };
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
  it("never offers a folder that holds an agent home outside the home directory", () => {
    const elsewhere = { ...dirs, agentHome: "/data/agent-home" };
    expect(paths("/data/project/src", elsewhere)).toEqual(["/data/project/src", "/data/project"]);
    // A folder inside the agent home is offered. The agent home is not.
    expect(paths("/data/agent-home/sessions", elsewhere)).toEqual(["/data/agent-home/sessions"]);
  });
  it("does not offer the launch directory when it is the home directory", () => {
    const atHome = { ...dirs, cwd: "/Users/me" };
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
  // std::vision is absent from every registry below: its module is not loaded.
  const registered = { "std::read": [under("dir")], "std::ls": [under("dir")] };

  it("returns the listed set when every known member shares the scope", () => {
    expect(sharedApprovalSet("std::ls", registered, {}, sets)?.name).toBe("FileRead");
  });
  it("returns null when a member's scope differs", () => {
    const differing = { "std::read": [exact("dir")], "std::ls": [under("dir")] };
    expect(sharedApprovalSet("std::ls", differing, {}, sets)).toBeNull();
  });
  it("returns null when a member's scope was overridden to empty", () => {
    expect(sharedApprovalSet("std::ls", registered, { "std::read": [] }, sets)).toBeNull();
  });
  it("does not take an unloaded member to agree with an override", () => {
    // Every loaded member is overridden to the same exact scope. std::vision
    // declares a subpath scope, so the set no longer agrees.
    const overrides = { "std::read": [exact("dir")], "std::ls": [exact("dir")] };
    expect(sharedApprovalSet("std::ls", registered, overrides, sets)).toBeNull();
  });
  it("lets an override that only repeats the declared scope keep the set", () => {
    const overrides = { "std::ls": [under("dir")] };
    expect(sharedApprovalSet("std::ls", registered, overrides, sets)?.name).toBe("FileRead");
  });
  it("returns null for an effect in no listed set", () => {
    expect(sharedApprovalSet("x::y", { "x::y": [exact("a")] }, {}, sets)).toBeNull();
    // A name an object inherits from its prototype must not be read as a scope.
    expect(sharedApprovalSet("constructor", {}, {}, sets)).toBeNull();
    expect(sharedApprovalSet("constructor", registered, {}, sets)).toBeNull();
  });
  it("returns null for an effect with no scope", () => {
    expect(sharedApprovalSet("std::ls", {}, {}, sets)).toBeNull();
  });
  it("gives the folder step to a listed set's members and to the effects named for it", () => {
    expect(getsFolderStep("std::read", sets)).toBe(true);
    expect(getsFolderStep("std::exec", sets)).toBe(true);
    expect(getsFolderStep("std::remove", sets)).toBe(false);
  });
  it("says whether an effect is in a listed set", () => {
    expect(inSharedApprovalSet("std::vision", sets)).toBe(true);
    expect(inSharedApprovalSet("x::y", sets)).toBe(false);
  });
});
