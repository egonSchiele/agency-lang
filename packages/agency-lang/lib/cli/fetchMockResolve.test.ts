import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveFetchMocks } from "./fetchMockResolve.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("resolveFetchMocks", () => {
  it("orders per-test entries before file-level entries", () => {
    const out = resolveFetchMocks(
      [{ url: "a", return: "file" }],
      [{ url: "a", return: "test" }],
      dir,
    );
    expect(out.map((mock) => mock.return)).toEqual(["test", "file"]);
  });

  it("throws (pointing at the test file) when an entry has neither return nor returnFile", () => {
    expect(() => resolveFetchMocks(undefined, [{ url: "a" }], dir))
      .toThrow(/needs a "return" or a "returnFile"/);
  });

  it("inlines returnFile contents into return and strips returnFile", () => {
    fs.writeFileSync(path.join(dir, "page.html"), "<h1>Hi</h1>");
    const out = resolveFetchMocks(undefined, [{ url: "a", returnFile: "page.html" }], dir);
    expect(out[0].return).toBe("<h1>Hi</h1>");
    expect(out[0].returnFile).toBeUndefined();
  });

  it("throws when returnFile is missing", () => {
    expect(() => resolveFetchMocks(undefined, [{ url: "a", returnFile: "nope.html" }], dir))
      .toThrow(/returnFile not found/);
  });

  it("throws when both return and returnFile are set", () => {
    fs.writeFileSync(path.join(dir, "f.txt"), "x");
    expect(() => resolveFetchMocks(undefined, [{ url: "a", return: "y", returnFile: "f.txt" }], dir))
      .toThrow(/only one of "return" or "returnFile"/);
  });

  it("returns [] for two undefined inputs", () => {
    expect(resolveFetchMocks(undefined, undefined, dir)).toEqual([]);
  });
});
