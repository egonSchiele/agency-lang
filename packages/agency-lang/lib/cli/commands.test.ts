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

  it("returns null and prints a notice to stderr for a directory with no .agency files", () => {
    const dir = makeTempDir();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveInputSources([dir])).toBeNull();
    expect(err).toHaveBeenCalledWith(
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

  it("hands each source's contents to the handler in argument order", async () => {
    // Explicit file arguments keep a deterministic order (resolveInputSources
    // preserves argument order), so this asserts ordering without sorting.
    const dir = makeTempDir();
    const zeta = path.join(dir, "zeta.agency");
    const alpha = path.join(dir, "alpha.agency");
    fs.writeFileSync(zeta, "node zeta() {}\n");
    fs.writeFileSync(alpha, "node alpha() {}\n");
    const seen: string[] = [];
    await forEachSource([zeta, alpha], (contents, src) => {
      seen.push(src.kind === "file" ? path.basename(src.path) : "-");
      expect(contents.length).toBeGreaterThan(0);
    });
    expect(seen).toEqual(["zeta.agency", "alpha.agency"]);
  });

  it("awaits an async handler before moving to the next source", async () => {
    const dir = makeTempDir();
    const one = path.join(dir, "one.agency");
    const two = path.join(dir, "two.agency");
    fs.writeFileSync(one, "node one() {}\n");
    fs.writeFileSync(two, "node two() {}\n");
    const order: string[] = [];
    await forEachSource([one, two], async (_contents, src) => {
      const name = src.kind === "file" ? path.basename(src.path) : "-";
      order.push(`start:${name}`);
      await Promise.resolve();
      order.push(`end:${name}`);
    });
    expect(order).toEqual([
      "start:one.agency",
      "end:one.agency",
      "start:two.agency",
      "end:two.agency",
    ]);
  });

  it("does nothing when the inputs resolve to no sources", async () => {
    const dir = makeTempDir();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = vi.fn();
    await forEachSource([dir], handle);
    expect(handle).not.toHaveBeenCalled();
  });
});
