import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// Spread the real fs so behavior is unchanged, but the module namespace becomes
// spyable (ESM namespaces from a bare `import * as fs` are not) — a couple of
// error-path tests spy on unlinkSync/mkdirSync.
vi.mock("fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("fs")>()) }));
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { planSourcePull, applySourcePull } from "./pullPlan.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-pull-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function leftoverTempSiblings(target: string): string[] {
  return fs
    .readdirSync(target)
    .filter((name) => name.startsWith(".pull-") && name.endsWith(".tmp"));
}

describe("planSourcePull", () => {
  it.each(["../x", "..\\x", "/abs", "a/b", "a\\b", ".", "..", "a\0b", ""])(
    "rejects unsafe name %s",
    (name) => {
      expect(() => planSourcePull([{ name, contents: "x" }], dir, false)).toThrow();
    },
  );

  it("rejects NFC-lowercased duplicate names", () => {
    expect(() =>
      planSourcePull(
        [
          { name: "A.agency", contents: "1" },
          { name: "a.agency", contents: "2" },
        ],
        dir,
        false,
      ),
    ).toThrow();
  });

  it("collects ALL existing conflicts before any write (no --force)", () => {
    fs.writeFileSync(path.join(dir, "a.agency"), "old");
    fs.writeFileSync(path.join(dir, "b.agency"), "old");
    expect(() =>
      planSourcePull(
        [
          { name: "a.agency", contents: "n" },
          { name: "b.agency", contents: "n" },
        ],
        dir,
        false,
      ),
    ).toThrow(/a\.agency[\s\S]*b\.agency|b\.agency[\s\S]*a\.agency/);
    expect(fs.readFileSync(path.join(dir, "a.agency"), "utf8")).toBe("old");
  });

  it("refuses a symlink destination even with --force", () => {
    fs.symlinkSync("/etc/hosts", path.join(dir, "a.agency"));
    expect(() => planSourcePull([{ name: "a.agency", contents: "n" }], dir, true)).toThrow();
  });

  it("refuses a directory at a destination", () => {
    fs.mkdirSync(path.join(dir, "a.agency"));
    expect(() => planSourcePull([{ name: "a.agency", contents: "n" }], dir, true)).toThrow();
  });

  it("refuses a symlink or regular file as outputDir", () => {
    const realDir = path.join(dir, "real");
    fs.mkdirSync(realDir);
    const symlinkDir = path.join(dir, "linked");
    fs.symlinkSync(realDir, symlinkDir);
    expect(() =>
      planSourcePull([{ name: "a.agency", contents: "x" }], symlinkDir, false),
    ).toThrow();
    const file = path.join(dir, "not-a-directory");
    fs.writeFileSync(file, "x");
    expect(() => planSourcePull([{ name: "a.agency", contents: "x" }], file, false)).toThrow();
  });
});

describe("applySourcePull", () => {
  it("no --force: publish fails on a destination created after planning, preserving it", () => {
    const plan = planSourcePull([{ name: "a.agency", contents: "new" }], dir, false);
    fs.writeFileSync(path.join(dir, "a.agency"), "concurrent");
    expect(() => applySourcePull(plan)).toThrow();
    expect(fs.readFileSync(path.join(dir, "a.agency"), "utf8")).toBe("concurrent");
    expect(leftoverTempSiblings(dir)).toEqual([]);
  });

  it("--force replaces only a still-regular destination, atomically", () => {
    const destination = path.join(dir, "a.agency");
    fs.writeFileSync(destination, "old");
    applySourcePull(planSourcePull([{ name: "a.agency", contents: "new" }], dir, true));
    expect(fs.readFileSync(destination, "utf8")).toBe("new");
    expect(leftoverTempSiblings(dir)).toEqual([]);
  });

  it("creates a missing output directory and writes UTF-8 contents completely", () => {
    const outputDir = path.join(dir, "new-output");
    applySourcePull(planSourcePull([{ name: "a.agency", contents: "héllo 👋" }], outputDir, false));
    expect(fs.readFileSync(path.join(outputDir, "a.agency"), "utf8")).toBe("héllo 👋");
  });

  it("reports earlier commits when a later destination races", () => {
    const plan = planSourcePull(
      [
        { name: "a.agency", contents: "first" },
        { name: "b.agency", contents: "second" },
      ],
      dir,
      false,
    );
    fs.writeFileSync(path.join(dir, "b.agency"), "concurrent");
    let caught: unknown;
    try {
      applySourcePull(plan);
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(expect.objectContaining({ committed: [path.join(dir, "a.agency")] }));
    // The message is self-contained: a caller that prints only error.message
    // still discloses the already-written a.agency.
    expect((caught as Error).message).toContain("b.agency");
    expect((caught as Error).message).toContain(path.join(dir, "a.agency"));
    expect(fs.readFileSync(path.join(dir, "a.agency"), "utf8")).toBe("first");
    expect(fs.readFileSync(path.join(dir, "b.agency"), "utf8")).toBe("concurrent");
    expect(leftoverTempSiblings(dir)).toEqual([]);
  });

  it("reports a committed destination if redundant-temp cleanup fails", () => {
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
      throw new Error("cleanup denied");
    });
    const destination = path.join(dir, "a.agency");
    let caught: unknown;
    try {
      applySourcePull(planSourcePull([{ name: "a.agency", contents: "new" }], dir, false));
    } catch (error) {
      caught = error;
    }
    const temp = unlink.mock.calls[0]?.[0];
    expect(caught).toEqual(
      expect.objectContaining({ committed: [destination], leftoverTemp: temp }),
    );
    expect((caught as Error).message).toContain("cleanup denied");
    expect(fs.readFileSync(destination, "utf8")).toBe("new");
    expect(typeof temp === "string" && fs.existsSync(temp)).toBe(true);
    unlink.mockRestore();
  });

  it("an output-directory creation failure commits no destination", () => {
    const outputDir = path.join(dir, "new-output");
    const plan = planSourcePull([{ name: "a.agency", contents: "new" }], outputDir, false);
    const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementationOnce(() => {
      throw new Error("permission denied");
    });
    expect(() => applySourcePull(plan)).toThrowError(expect.objectContaining({ committed: [] }));
    expect(fs.existsSync(path.join(outputDir, "a.agency"))).toBe(false);
    mkdir.mockRestore();
  });
});
