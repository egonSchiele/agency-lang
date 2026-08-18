import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { computeCodeIdentity, withCodeIdentity } from "./codeIdentity.js";

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

  it("does not depend on the working directory", () => {
    const dir = proj({ "main.agency": "node main() { return 1 }\n" });
    const fromOutside = computeCodeIdentity(path.join(dir, "main.agency"));
    const previous = process.cwd();
    process.chdir(path.dirname(dir));
    try {
      expect(computeCodeIdentity(path.join(dir, "main.agency"))).toEqual(fromOutside);
    } finally {
      process.chdir(previous);
    }
    expect(fromOutside.entry).toBe("main.agency");
  });

  it("changes the hash when any closure file changes", () => {
    const dir = proj({ "main.agency": "node main() { return 1 }\n" });
    const before = computeCodeIdentity(path.join(dir, "main.agency")).closureHash;
    fs.writeFileSync(path.join(dir, "main.agency"), "node main() { return 2 }\n");
    expect(computeCodeIdentity(path.join(dir, "main.agency")).closureHash).not.toBe(before);
  });
});

describe("withCodeIdentity", () => {
  it("keeps every inherited override but replaces an inherited log.code with the entry file's own", () => {
    const dir = proj({ "main.agency": "node main() { return 1 }" });
    const inherited = {
      observability: true,
      log: {
        logFile: "harness.jsonl",
        code: { entry: "other.agency", closureHash: "stale", closure: [] },
      },
    };
    const merged = withCodeIdentity(inherited, path.join(dir, "main.agency"));
    expect(merged.observability).toBe(true);
    expect(merged.log?.logFile).toBe("harness.jsonl");
    expect(merged.log?.code?.entry).toBe("main.agency");
    expect(merged.log?.code?.closureHash).not.toBe("stale");
  });
});
