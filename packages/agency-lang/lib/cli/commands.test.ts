import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { forEachSource, resolveInputSources } from "./commands.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agency-resolve-"));
}

describe("resolveInputSources", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps no arguments to a single stdin source", () => {
    expect(resolveInputSources([])).toEqual([{ kind: "stdin" }]);
  });

  it("maps '-' to a stdin source", () => {
    expect(resolveInputSources(["-"])).toEqual([{ kind: "stdin" }]);
  });

  it("keeps a plain file as a file source", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "a.agency");
    fs.writeFileSync(file, "node main() {}\n");
    expect(resolveInputSources([file])).toEqual([{ kind: "file", path: file }]);
  });

  it("expands a directory to its .agency files", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "a.agency"), "node a() {}\n");
    fs.writeFileSync(path.join(dir, "b.agency"), "node b() {}\n");
    fs.writeFileSync(path.join(dir, "ignore.txt"), "not agency\n");
    const result = resolveInputSources([dir]);
    const paths = (result ?? [])
      .filter((s) => s.kind === "file")
      .map((s) => path.basename((s as { path: string }).path))
      .sort();
    expect(paths).toEqual(["a.agency", "b.agency"]);
  });

  it("preserves order across mixed directory and file arguments", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "d.agency"), "node d() {}\n");
    const file = path.join(makeTempDir(), "solo.agency");
    fs.writeFileSync(file, "node solo() {}\n");
    const result = resolveInputSources([dir, file]) ?? [];
    expect(result.map((s) => (s.kind === "file" ? path.basename(s.path) : "-"))).toEqual([
      "d.agency",
      "solo.agency",
    ]);
  });

  it("returns null and prints a notice for a directory with no .agency files", () => {
    const dir = makeTempDir();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(resolveInputSources([dir])).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("No .agency files found"),
    );
  });

  it("exits on a missing path", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("exit");
    }) as never);
    expect(() => resolveInputSources(["does-not-exist.agency"])).toThrow("exit");
  });

  it("exits when stdin is requested twice", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("exit");
    }) as never);
    expect(() => resolveInputSources(["-", "-"])).toThrow("exit");
  });
});

describe("forEachSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands each resolved source's contents to the handler in order", async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "first.agency"), "node first() {}\n");
    fs.writeFileSync(path.join(dir, "second.agency"), "node second() {}\n");
    const seen: string[] = [];
    await forEachSource([dir], (contents, src) => {
      seen.push(src.kind === "file" ? path.basename(src.path) : "-");
      expect(contents.length).toBeGreaterThan(0);
    });
    expect(seen.sort()).toEqual(["first.agency", "second.agency"]);
  });

  it("does nothing when the inputs resolve to no sources", async () => {
    const dir = makeTempDir();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const handle = vi.fn();
    await forEachSource([dir], handle);
    expect(handle).not.toHaveBeenCalled();
  });
});
