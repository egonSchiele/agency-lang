import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { aliasAdd, aliasList, aliasRemove, formatRefreshOutput } from "./local.js";

let dir: string;
let aliasFile: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cli-")));
  aliasFile = path.join(dir, "agency.json");
  fs.writeFileSync(aliasFile, "{}");
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("agency local CLI helpers", () => {
  it("alias add/list/remove round-trips through agency.json and prints the file", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      aliasAdd("my7b", "hf:org/repo:Q4_K_M", aliasFile);
      expect(JSON.parse(fs.readFileSync(aliasFile, "utf-8")).client.modelAliases.my7b)
        .toBe("hf:org/repo:Q4_K_M");
      expect(log.mock.calls.flat().some((s) => String(s).includes(aliasFile))).toBe(true);

      expect(aliasList(aliasFile).some((m) => m.name === "my7b" && m.source === "alias")).toBe(true);

      aliasRemove("my7b", aliasFile);
      expect(JSON.parse(fs.readFileSync(aliasFile, "utf-8")).client.modelAliases.my7b)
        .toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });
});

describe("formatRefreshOutput", () => {
  it("renders skip notices (kept + remote) and a summary line", () => {
    const lines = formatRefreshOutput({
      url: "https://x/c.json",
      file: "/tmp/agency.json",
      added: ["a", "b"],
      updated: [],
      unchanged: ["c"],
      removed: ["old"],
      skipped: [{ name: "dupe", keptUri: "hf:mine:Q4_K_M", remoteUri: "hf:remote:Q4_K_M" }],
      modelCount: 4, // a, b, c, dupe (= added + updated + unchanged + skipped)
    });
    expect(lines[0]).toBe('Skipped "dupe": kept your alias (hf:mine:Q4_K_M);');
    expect(lines[1]).toBe("  remote would have set hf:remote:Q4_K_M");
    // Summary mentions total catalog size, then breakdown.
    expect(lines.some((l) => l.includes("4 models from https://x/c.json"))).toBe(true);
    expect(
      lines.some((l) => l.includes("2 added, 0 updated, 1 unchanged, 1 removed, 1 skipped")),
    ).toBe(true);
  });
});
