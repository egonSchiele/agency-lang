import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { aliasAdd, aliasList, aliasRemove } from "./local.js";

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
