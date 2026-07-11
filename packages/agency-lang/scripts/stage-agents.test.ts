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

  test("never overwrites a dest compiled .js with a stale src .js (issue #498)", () => {
    // A .js with a .agency sibling in src is a stale compiled artifact
    // left in the SOURCE tree; the compiler is the sole author of the dest
    // .js. Copying it would clobber the compiler's fresh dest output, and
    // the manifest's fresh-skip would then never re-emit it.
    const src = tree({
      "agency-agent/lib/defaultPolicy.agency": "src-v2",
      "agency-agent/lib/defaultPolicy.js": "STALE-compiled-output",
    });
    const dest = tree({
      "agency-agent/lib/defaultPolicy.agency": "src-v1",
      "agency-agent/lib/defaultPolicy.js": "FRESH-compiled-output",
    });
    syncAgents(src, dest);
    // Source is synced; the compiler-owned output is left untouched.
    expect(fs.readFileSync(path.join(dest, "agency-agent/lib/defaultPolicy.agency"), "utf-8")).toBe(
      "src-v2",
    );
    expect(fs.readFileSync(path.join(dest, "agency-agent/lib/defaultPolicy.js"), "utf-8")).toBe(
      "FRESH-compiled-output",
    );
  });

  test("still copies handwritten .js helpers that have no .agency sibling", () => {
    const src = tree({ "agency-agent/toolWiring.js": "handwritten" });
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agency-stage-")), "dest");
    syncAgents(src, dest);
    expect(fs.readFileSync(path.join(dest, "agency-agent/toolWiring.js"), "utf-8")).toBe(
      "handwritten",
    );
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
