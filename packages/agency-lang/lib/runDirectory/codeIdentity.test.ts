import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { computeCodeIdentity } from "./codeIdentity.js";

function proj(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeid-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

describe("computeCodeIdentity", () => {
  it("lists the entry and its imports relative to the closure base, sorted, with a stable hash", () => {
    const dir = proj({
      "main.agency": 'import { f } from "./lib/util.agency"\nnode main() { return f() }\n',
      "lib/util.agency": 'export def f(): string { return "x" }\n',
    });
    const firstIdentity = computeCodeIdentity(path.join(dir, "main.agency"));
    expect(firstIdentity.entry).toBe("main.agency");
    expect(firstIdentity.closure.map((file) => file.file)).toEqual([
      "lib/util.agency",
      "main.agency",
    ]);
    expect(firstIdentity.closureHash).toMatch(/^[0-9a-f]{64}$/);
    const secondIdentity = computeCodeIdentity(path.join(dir, "main.agency"));
    expect(secondIdentity.closureHash).toBe(firstIdentity.closureHash);
  });

  it("changes the hash when any closure file changes", () => {
    const dir = proj({ "main.agency": "node main() { return 1 }\n" });
    const before = computeCodeIdentity(path.join(dir, "main.agency")).closureHash;
    fs.writeFileSync(path.join(dir, "main.agency"), "node main() { return 2 }\n");
    expect(computeCodeIdentity(path.join(dir, "main.agency")).closureHash).not.toBe(before);
  });
});
