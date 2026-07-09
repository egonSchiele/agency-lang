import { describe, expect, test } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { syncAgents } from "./stage-agents.mjs";

function tree(spec: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agency-stage-"));
  for (const [rel, contents] of Object.entries(spec)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return root;
}

describe("syncAgents", () => {
  test("copies sources over and preserves live compiled outputs", () => {
    const src = tree({ "review/agent.agency": "src-v2" });
    const dest = tree({
      "review/agent.agency": "src-v1",
      "review/agent.js": "compiled",
    });
    syncAgents(src, dest);
    expect(fs.readFileSync(path.join(dest, "review/agent.agency"), "utf-8")).toBe("src-v2");
    expect(fs.existsSync(path.join(dest, "review/agent.js"))).toBe(true);
  });

  test("deletes orphaned sources AND their compiled siblings", () => {
    const src = tree({ "review/keep.agency": "k" });
    const dest = tree({
      "review/keep.agency": "k",
      "review/gone.agency": "old-source",
      "review/gone.js": "old-output",
    });
    const { deleted } = syncAgents(src, dest);
    expect(fs.existsSync(path.join(dest, "review/gone.agency"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "review/gone.js"))).toBe(false);
    expect(deleted.sort()).toEqual(["review/gone.agency", "review/gone.js"]);
  });

  test("never touches the docs/ subtree", () => {
    const src = tree({ "review/agent.agency": "a" });
    const dest = tree({ "docs/guide/x.md": "doc" });
    syncAgents(src, dest);
    expect(fs.existsSync(path.join(dest, "docs/guide/x.md"))).toBe(true);
  });

  test("creates dest when missing", () => {
    const src = tree({ "review/agent.agency": "a" });
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agency-stage-")), "not-yet");
    syncAgents(src, dest);
    expect(fs.readFileSync(path.join(dest, "review/agent.agency"), "utf-8")).toBe("a");
  });
});
