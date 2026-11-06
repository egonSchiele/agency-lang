import { describe, expect, it } from "vitest";
import type { Entry } from "../host/host.js";
import { completeMention, mentionAtEnd, type ListDir } from "./pathCompletion.js";

function entry(name: string, type: Entry["type"] = "file"): Entry {
  return { name, type, size: 0 };
}

const TREE: Record<string, Entry[]> = {
  ".": [entry("lib", "dir"), entry("license.md"), entry("README.md"), entry(".env")],
  "lib/": [entry("agents", "dir"), entry("agency.ts"), entry("cli.ts")],
};

const listDir: ListDir = async (dir) => TREE[dir] ?? [];

describe("mentionAtEnd", () => {
  it("finds a mention in the last word", () => {
    expect(mentionAtEnd("look at @lib/ag")).toBe("@lib/ag");
  });

  it("is null when the last word is not a mention", () => {
    expect(mentionAtEnd("see @lib/cli.ts please")).toBeNull();
  });

  it("is null for an email-like word", () => {
    expect(mentionAtEnd("mail me@example.com")).toBeNull();
  });
});

describe("completeMention", () => {
  it("completes a name in the working directory", async () => {
    expect(await completeMention("@li", listDir)).toEqual(["@lib/", "@license.md"]);
  });

  it("completes inside a directory and keeps the directory in the mention", async () => {
    expect(await completeMention("@lib/ag", listDir)).toEqual(["@lib/agency.ts", "@lib/agents/"]);
  });

  it("lists a whole directory for a bare mention, without dot files", async () => {
    expect(await completeMention("@", listDir)).toEqual(["@README.md", "@lib/", "@license.md"]);
  });

  it("offers dot files once the dot is typed", async () => {
    expect(await completeMention("@.e", listDir)).toEqual(["@.env"]);
  });

  it("offers nothing for a directory that cannot be listed", async () => {
    expect(await completeMention("@missing/x", listDir)).toEqual([]);
  });
});
