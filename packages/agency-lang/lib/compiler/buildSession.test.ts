import { afterEach, describe, expect, test, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createBuildSession, findCrossConfigConflicts } from "./buildSession.js";
import { CompileClosureError } from "./compileClosure.js";
import { compile, resetCompilationCache } from "../cli/commands.js";

const TRIVIAL = 'node main() {\n  return "ok"\n}\n';
const HELPER = 'export def helper(): string {\n  return "shared"\n}\n';
const IMPORTS_HELPER =
  'import { helper } from "./helper.agency"\n\nnode main() {\n  return helper()\n}\n';

function writeTempDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-buildsession-"));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

// Back-date a file so any re-emit measurably moves its mtime, independent
// of filesystem timestamp granularity vs compile duration.
const BACKDATE = new Date("2020-01-01T00:00:00Z");
function backdate(file: string): number {
  fs.utimesSync(file, BACKDATE, BACKDATE);
  return fs.statSync(file).mtimeMs;
}

// Count progress lines ("<input> → <output> (in Nms)") for a source file.
function emitCount(spy: ReturnType<typeof vi.spyOn>, sourceName: string): number {
  return spy.mock.calls.filter(
    (args: unknown[]) => typeof args[0] === "string" && args[0].includes(`${sourceName} → `),
  ).length;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createBuildSession", () => {
  test("compiles a single file and returns the output path", () => {
    const dir = writeTempDir({ "main.agency": TRIVIAL });
    const session = createBuildSession();
    const out = session.compile({}, path.join(dir, "main.agency"), undefined, { quiet: true });
    expect(out).toBe(path.join(dir, "main.js"));
    expect(fs.existsSync(out!)).toBe(true);
  });

  test("dedupes within a session: second compile of the same entry is a no-op", () => {
    const dir = writeTempDir({ "main.agency": TRIVIAL });
    const session = createBuildSession();
    const entry = path.join(dir, "main.agency");
    session.compile({}, entry, undefined, { quiet: true });
    const stamped = backdate(path.join(dir, "main.js"));
    session.compile({}, entry, undefined, { quiet: true });
    expect(fs.statSync(path.join(dir, "main.js")).mtimeMs).toBe(stamped);
  });

  test("sessions are isolated: a fresh session recompiles", () => {
    const dir = writeTempDir({ "main.agency": TRIVIAL });
    const entry = path.join(dir, "main.agency");
    createBuildSession().compile({}, entry, undefined, { quiet: true });
    const stamped = backdate(path.join(dir, "main.js"));
    createBuildSession().compile({}, entry, undefined, { quiet: true });
    expect(fs.statSync(path.join(dir, "main.js")).mtimeMs).toBeGreaterThan(stamped);
  });

  test("reset() drops the dedupe state", () => {
    const dir = writeTempDir({ "main.agency": TRIVIAL });
    const entry = path.join(dir, "main.agency");
    const session = createBuildSession();
    session.compile({}, entry, undefined, { quiet: true });
    const stamped = backdate(path.join(dir, "main.js"));
    session.reset();
    session.compile({}, entry, undefined, { quiet: true });
    expect(fs.statSync(path.join(dir, "main.js")).mtimeMs).toBeGreaterThan(stamped);
  });

  test("compileMany compiles the shared import exactly once (union closure)", () => {
    const dir = writeTempDir({
      "helper.agency": HELPER,
      "a.agency": IMPORTS_HELPER,
      "b.agency": IMPORTS_HELPER,
    });
    const spy = vi.spyOn(console, "log");
    createBuildSession().compileMany({}, [
      path.join(dir, "a.agency"),
      path.join(dir, "b.agency"),
    ]);
    for (const out of ["a.js", "b.js", "helper.js"]) {
      expect(fs.existsSync(path.join(dir, out))).toBe(true);
    }
    // The property under test: helper compiles ONCE. A closure-per-entry
    // regression compiles it twice and still leaves all files existing.
    expect(emitCount(spy, "helper.agency")).toBe(1);
  });

  test("directory entries compile every member with one union closure", () => {
    const dir = writeTempDir({
      "helper.agency": HELPER,
      "a.agency": IMPORTS_HELPER,
      "b.agency": IMPORTS_HELPER,
    });
    const spy = vi.spyOn(console, "log");
    const result = createBuildSession().compile({}, dir);
    expect(result).toBeNull();
    for (const out of ["a.js", "b.js", "helper.js"]) {
      expect(fs.existsSync(path.join(dir, out))).toBe(true);
    }
    expect(emitCount(spy, "helper.agency")).toBe(1);
  });

  test("compileMany throws CompileClosureError for programmatic callers", () => {
    const dir = writeTempDir({
      "main.agency":
        'import { gone } from "./missing.agency"\n\nnode main() {\n  return gone()\n}\n',
    });
    expect(() =>
      createBuildSession().compileMany({}, [path.join(dir, "main.agency")], { quiet: true }),
    ).toThrow(CompileClosureError);
  });

  test("allowTestImports gates import test compilation", () => {
    const dir = writeTempDir({
      "lib.agency": 'def secret(): string {\n  return "s"\n}\n',
      "main.agency":
        'import test { secret } from "./lib.agency"\n\nnode main() {\n  return secret()\n}\n',
    });
    const files = [path.join(dir, "main.agency")];
    expect(() => createBuildSession().compileMany({}, files, { quiet: true })).toThrow();
    createBuildSession().compileMany({}, files, { quiet: true, allowTestImports: true });
    expect(fs.existsSync(path.join(dir, "main.js"))).toBe(true);
  });

  test("outDir routes output into the configured directory", () => {
    // The outDir branch joins outDir with the INPUT-derived path, so it is
    // designed for CWD-relative inputs (`agency compile main.agency` with
    // an outDir config). Exercise it the way the CLI does: chdir into the
    // project dir and pass a bare relative path.
    const dir = writeTempDir({ "main.agency": TRIVIAL });
    const outDir = path.join(dir, "built");
    const previousCwd = process.cwd();
    try {
      process.chdir(dir);
      const out = createBuildSession().compile({ outDir }, "main.agency", undefined, {
        quiet: true,
      });
      expect(out).toBe(path.join(outDir, "main.js"));
      expect(fs.existsSync(out!)).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe("findCrossConfigConflicts", () => {
  test("no conflict when groups with the same config share a module", () => {
    const conflicts = findCrossConfigConflicts([
      { label: "a", configKey: "{}", modules: ["/shared.agency"] },
      { label: "b", configKey: "{}", modules: ["/shared.agency"] },
    ]);
    expect(conflicts).toEqual([]);
  });

  test("conflict when groups with differing configs share a module", () => {
    const conflicts = findCrossConfigConflicts([
      { label: "a", configKey: "{}", modules: ["/shared.agency", "/a.agency"] },
      { label: "b", configKey: '{"verbose":true}', modules: ["/shared.agency"] },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].module).toBe("/shared.agency");
    expect(conflicts[0].labels.sort()).toEqual(["a", "b"]);
  });

  test("no conflict when differing-config groups touch disjoint modules", () => {
    const conflicts = findCrossConfigConflicts([
      { label: "a", configKey: "{}", modules: ["/a.agency"] },
      { label: "b", configKey: '{"verbose":true}', modules: ["/b.agency"] },
    ]);
    expect(conflicts).toEqual([]);
  });
});

describe("compileGroups", () => {
  test("asserts loudly when differing configs share a module", () => {
    const dir = writeTempDir({
      "helper.agency": HELPER,
      "a.agency": IMPORTS_HELPER,
      "b.agency": IMPORTS_HELPER,
    });
    const groups = [
      { label: "a", config: {}, files: [path.join(dir, "a.agency")] },
      { label: "b", config: { verbose: false }, files: [path.join(dir, "b.agency")] },
    ];
    expect(() =>
      createBuildSession().compileGroups(groups, { quiet: true }),
    ).toThrow(/helper\.agency/);
  });

  test("compiles compatible groups", () => {
    const dir = writeTempDir({ "main.agency": TRIVIAL });
    const groups = [
      { label: "<base config>", config: {}, files: [path.join(dir, "main.agency")] },
    ];
    createBuildSession().compileGroups(groups, { quiet: true });
    expect(fs.existsSync(path.join(dir, "main.js"))).toBe(true);
  });
});

describe("commands.ts delegates", () => {
  test("module-level compile + resetCompilationCache re-emits", () => {
    const dir = writeTempDir({ "main.agency": TRIVIAL });
    const entry = path.join(dir, "main.agency");
    compile({}, entry, undefined, { quiet: true });
    const stamped = backdate(path.join(dir, "main.js"));
    compile({}, entry, undefined, { quiet: true });
    expect(fs.statSync(path.join(dir, "main.js")).mtimeMs).toBe(stamped); // deduped
    resetCompilationCache();
    compile({}, entry, undefined, { quiet: true });
    expect(fs.statSync(path.join(dir, "main.js")).mtimeMs).toBeGreaterThan(stamped);
  });
});
