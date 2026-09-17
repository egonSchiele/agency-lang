import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { forEachSource, loadConfig, mergeFixtureConfig, resolveInputSources } from "./commands.js";
import { fileTarget, projectTarget } from "../config/target.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agency-resolve-"));
}

describe("loadConfig diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A machine-consumed command (e.g. `remote logs --json`) reads config on the
  // way in; neither verbose source may write to stdout, or it corrupts the JSON.
  it("routes both the --verbose and config.verbose diagnostics to stderr, never stdout", () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, "agency.json");
    fs.writeFileSync(configPath, JSON.stringify({ verbose: true }));
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    loadConfig(fileTarget(configPath), true);

    expect(out).not.toHaveBeenCalled();
    const lines = err.mock.calls.map((call) => call.join(" "));
    const stderr = lines.join("\n");
    expect(stderr).toContain("Looking for config at"); // the --verbose flag source
    const loadedLines = lines.filter((line) => line.startsWith("Loaded config from"));
    expect(loadedLines).toEqual([`Loaded config from ${configPath}`]); // config.verbose, once
    expect(safeDeleteDirectoryWithin(os.tmpdir(), dir).success).toBe(true);
  });

  it("merges agency.local.json for a project target", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "agency.json"),
      JSON.stringify({ outDir: "base", verbose: false }),
    );
    fs.writeFileSync(path.join(dir, "agency.local.json"), JSON.stringify({ outDir: "local" }));

    expect(loadConfig(projectTarget(dir))).toEqual({ verbose: false, outDir: "local" });
    expect(safeDeleteDirectoryWithin(os.tmpdir(), dir).success).toBe(true);
  });

  it("uses the current directory when no target is given", () => {
    const dir = fs.realpathSync(makeTempDir());
    fs.writeFileSync(path.join(dir, "agency.local.json"), JSON.stringify({ outDir: "local" }));
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      expect(loadConfig().outDir).toBe("local");
    } finally {
      process.chdir(previousCwd);
    }
    expect(safeDeleteDirectoryWithin(os.tmpdir(), dir).success).toBe(true);
  });

  it("prints each loaded file once when config.verbose is set", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "agency.json"), JSON.stringify({}));
    fs.writeFileSync(path.join(dir, "agency.local.json"), JSON.stringify({ verbose: true }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    loadConfig(projectTarget(dir));

    const loadedLines = err.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("Loaded config from"));
    expect(loadedLines).toEqual([
      `Loaded config from ${path.join(dir, "agency.json")}`,
      `Loaded config from ${path.join(dir, "agency.local.json")}`,
    ]);
    expect(safeDeleteDirectoryWithin(os.tmpdir(), dir).success).toBe(true);
  });

  it("exits when the local file is invalid", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "agency.local.json"), "{ not json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    expect(() => loadConfig(projectTarget(dir))).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(safeDeleteDirectoryWithin(os.tmpdir(), dir).success).toBe(true);
  });
});

describe("mergeFixtureConfig", () => {
  it("merges a fixture's config over the base", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "agency.local.json"), JSON.stringify({ verbose: true }));
    expect(mergeFixtureConfig({ outDir: "base" }, dir)).toEqual({ outDir: "base", verbose: true });
    expect(safeDeleteDirectoryWithin(os.tmpdir(), dir).success).toBe(true);
  });

  it("returns the base unchanged when the fixture has no config", () => {
    const dir = makeTempDir();
    const base = { outDir: "base", refuseSplices: true };
    expect(mergeFixtureConfig(base, dir)).toEqual(base);
    expect(safeDeleteDirectoryWithin(os.tmpdir(), dir).success).toBe(true);
  });

  it("keeps a refusal from the command line", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "agency.json"), JSON.stringify({ refuseSplices: false }));
    expect(mergeFixtureConfig({ refuseSplices: true }, dir).refuseSplices).toBe(true);
    expect(safeDeleteDirectoryWithin(os.tmpdir(), dir).success).toBe(true);
  });
});

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
    expect(err).toHaveBeenCalledWith(expect.stringContaining("No .agency files found"));
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
