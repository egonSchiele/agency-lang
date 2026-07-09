import { afterEach, describe, expect, test, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createBuildSession, findCrossConfigConflicts } from "./buildSession.js";
import { loadManifest, MANIFEST_DIR_NAME } from "./buildManifest.js";
import { _internal as parseCacheInternal } from "../parseCache.js";
import { RunStrategy } from "../importStrategy.js";
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
    const out = session.compile({}, { entries: [path.join(dir, "main.agency")], quiet: true });
    expect(out).toBe(path.join(dir, "main.js"));
    expect(fs.existsSync(out!)).toBe(true);
  });

  test("dedupes within a session: second compile of the same entry is a no-op", () => {
    const dir = writeTempDir({ "main.agency": TRIVIAL });
    const session = createBuildSession();
    const entry = path.join(dir, "main.agency");
    session.compile({}, { entries: [entry], quiet: true });
    const stamped = backdate(path.join(dir, "main.js"));
    session.compile({}, { entries: [entry], quiet: true });
    expect(fs.statSync(path.join(dir, "main.js")).mtimeMs).toBe(stamped);
  });

  test("sessions are isolated: a fresh session recompiles (manifest removed)", () => {
    // The dedupe set is SESSION state; the manifest is durable and would
    // legitimately let a fresh session skip. Remove it so re-emission is
    // the isolation observable again.
    const dir = writeTempDir({ "main.agency": TRIVIAL });
    const entry = path.join(dir, "main.agency");
    const first = createBuildSession();
    first.compile({}, { entries: [entry], quiet: true });
    fs.rmSync(path.join(dir, MANIFEST_DIR_NAME), { recursive: true, force: true });
    const stamped = backdate(path.join(dir, "main.js"));
    first.compile({}, { entries: [entry], quiet: true });
    expect(fs.statSync(path.join(dir, "main.js")).mtimeMs).toBe(stamped); // same session: deduped
    createBuildSession().compile({}, { entries: [entry], quiet: true });
    expect(fs.statSync(path.join(dir, "main.js")).mtimeMs).toBeGreaterThan(stamped); // fresh session: re-emits
  });

  test("reset() drops the dedupe state (manifest removed)", () => {
    const dir = writeTempDir({ "main.agency": TRIVIAL });
    const entry = path.join(dir, "main.agency");
    const session = createBuildSession();
    session.compile({}, { entries: [entry], quiet: true });
    fs.rmSync(path.join(dir, MANIFEST_DIR_NAME), { recursive: true, force: true });
    const stamped = backdate(path.join(dir, "main.js"));
    session.reset();
    session.compile({}, { entries: [entry], quiet: true });
    expect(fs.statSync(path.join(dir, "main.js")).mtimeMs).toBeGreaterThan(stamped);
  });

  test("compileMany compiles the shared import exactly once (union closure)", () => {
    const dir = writeTempDir({
      "helper.agency": HELPER,
      "a.agency": IMPORTS_HELPER,
      "b.agency": IMPORTS_HELPER,
    });
    const spy = vi.spyOn(console, "log");
    createBuildSession().compile({}, {
      entries: [path.join(dir, "a.agency"), path.join(dir, "b.agency")],
    });
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
    const result = createBuildSession().compile({}, { entries: [dir] });
    expect(result).toBeNull();
    for (const out of ["a.js", "b.js", "helper.js"]) {
      expect(fs.existsSync(path.join(dir, out))).toBe(true);
    }
    expect(emitCount(spy, "helper.agency")).toBe(1);
  });

  test("multi-entry compile throws CompileClosureError for programmatic callers", () => {
    // The throw contract belongs to the union-closure path (2+ entries);
    // a single entry keeps the legacy exit-on-closure-error behavior.
    const dir = writeTempDir({
      "ok.agency": TRIVIAL,
      "main.agency":
        'import { gone } from "./missing.agency"\n\nnode main() {\n  return gone()\n}\n',
    });
    expect(() =>
      createBuildSession().compile({}, {
        entries: [path.join(dir, "ok.agency"), path.join(dir, "main.agency")],
        quiet: true,
      }),
    ).toThrow(CompileClosureError);
  });

  test("allowTestImports gates import test compilation", () => {
    const dir = writeTempDir({
      "lib.agency": 'def secret(): string {\n  return "s"\n}\n',
      "main.agency":
        'import test { secret } from "./lib.agency"\n\nnode main() {\n  return secret()\n}\n',
    });
    const files = [path.join(dir, "main.agency")];
    expect(() => createBuildSession().compile({}, { entries: files, quiet: true })).toThrow(
      /only allowed under the test harness/,
    );
    createBuildSession().compile({}, { entries: files, quiet: true, allowTestImports: true });
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
      const out = createBuildSession().compile({ outDir }, { entries: ["main.agency"], quiet: true });
      expect(out).toBe(path.join(outDir, "main.js"));
      expect(fs.existsSync(out!)).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("single entry returns the output path; multiple entries return null", () => {
    const dir = writeTempDir({ "a.agency": TRIVIAL, "b.agency": TRIVIAL });
    const single = createBuildSession().compile({}, { entries: [path.join(dir, "a.agency")], quiet: true });
    expect(single).toBe(path.join(dir, "a.js"));
    const multi = createBuildSession().compile(
      {},
      { entries: [path.join(dir, "a.agency"), path.join(dir, "b.agency")], quiet: true },
    );
    expect(multi).toBeNull();
  });

  test("outputFile with multiple entries throws", () => {
    const dir = writeTempDir({ "a.agency": TRIVIAL, "b.agency": TRIVIAL });
    expect(() =>
      createBuildSession().compile({}, {
        entries: [path.join(dir, "a.agency"), path.join(dir, "b.agency")],
        outputFile: path.join(dir, "out.js"),
        quiet: true,
      }),
    ).toThrow(/outputFile/);
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
    fs.rmSync(path.join(dir, MANIFEST_DIR_NAME), { recursive: true, force: true });
    resetCompilationCache();
    compile({}, entry, undefined, { quiet: true });
    expect(fs.statSync(path.join(dir, "main.js")).mtimeMs).toBeGreaterThan(stamped);
  });
});

describe("manifest write path", () => {
  test("compiling records an entry per emitted module with recorded deps", () => {
    const dir = writeTempDir({ "helper.agency": HELPER, "main.agency": IMPORTS_HELPER });
    createBuildSession().compile({}, { entries: [path.join(dir, "main.agency")], quiet: true });
    const manifest = loadManifest(dir);
    expect(manifest.entries["main.agency"].deps).toEqual(["helper.agency"]);
    expect(manifest.entries["main.agency"].outputPath).toBe("main.js");
    expect(manifest.entries["main.agency"].hasPkgImports).toBe(false);
    expect(manifest.entries["helper.agency"].deps).toEqual([]);
  });

  test("allowTestImports sessions write no manifest", () => {
    const dir = writeTempDir({
      "lib.agency": 'def secret(): string {\n  return "s"\n}\n',
      "main.agency":
        'import test { secret } from "./lib.agency"\n\nnode main() {\n  return secret()\n}\n',
    });
    createBuildSession().compile({}, {
      entries: [path.join(dir, "main.agency")],
      quiet: true,
      allowTestImports: true,
    });
    expect(fs.existsSync(path.join(dir, MANIFEST_DIR_NAME))).toBe(false);
  });

  test("--ts mode writes no manifest", () => {
    const dir = writeTempDir({ "main.agency": TRIVIAL });
    createBuildSession().compile({}, { entries: [path.join(dir, "main.agency")], quiet: true, ts: true });
    expect(fs.existsSync(path.join(dir, MANIFEST_DIR_NAME))).toBe(false);
  });
});

describe("manifest read path (incremental skip)", () => {
  test("second compile skips: no emit, no parse (fully-clean fast path)", () => {
    const dir = writeTempDir({ "helper.agency": HELPER, "main.agency": IMPORTS_HELPER });
    const entry = path.join(dir, "main.agency");
    createBuildSession().compile({}, { entries: [entry], quiet: true });
    const stamped = backdate(path.join(dir, "main.js"));
    parseCacheInternal.clear();
    const before = { ...parseCacheInternal.stats };
    const out = createBuildSession().compile({}, { entries: [entry], quiet: true });
    expect(out).toBe(path.join(dir, "main.js"));
    expect(fs.statSync(path.join(dir, "main.js")).mtimeMs).toBe(stamped);
    expect(parseCacheInternal.stats.misses).toBe(before.misses);
    expect(parseCacheInternal.stats.hits).toBe(before.hits);
  });

  test("editing a dep recompiles the dependent", () => {
    const dir = writeTempDir({ "helper.agency": HELPER, "main.agency": IMPORTS_HELPER });
    const entry = path.join(dir, "main.agency");
    createBuildSession().compile({}, { entries: [entry], quiet: true });
    const stamped = backdate(path.join(dir, "main.js"));
    fs.writeFileSync(path.join(dir, "helper.agency"), HELPER.replace("shared", "changed"));
    createBuildSession().compile({}, { entries: [entry], quiet: true });
    expect(fs.statSync(path.join(dir, "main.js")).mtimeMs).toBeGreaterThan(stamped);
  });

  test("deleting a DEP output recompiles the entry", () => {
    const dir = writeTempDir({ "helper.agency": HELPER, "main.agency": IMPORTS_HELPER });
    const entry = path.join(dir, "main.agency");
    createBuildSession().compile({}, { entries: [entry], quiet: true });
    fs.unlinkSync(path.join(dir, "helper.js"));
    createBuildSession().compile({}, { entries: [entry], quiet: true });
    expect(fs.existsSync(path.join(dir, "helper.js"))).toBe(true); // re-emitted
  });

  test("a caller-supplied importStrategy is never skip-eligible in either direction", () => {
    const dir = writeTempDir({ "main.agency": TRIVIAL });
    const entry = path.join(dir, "main.agency");
    createBuildSession().compile({}, { entries: [entry], quiet: true });
    const stamped = backdate(path.join(dir, "main.js"));
    createBuildSession().compile({}, {
      entries: [entry],
      quiet: true,
      importStrategy: new RunStrategy(),
    });
    expect(fs.statSync(path.join(dir, "main.js")).mtimeMs).toBeGreaterThan(stamped);
    fs.rmSync(path.join(dir, MANIFEST_DIR_NAME), { recursive: true, force: true });
    createBuildSession().compile({}, { entries: [entry], quiet: true, importStrategy: new RunStrategy() });
    const runStamped = backdate(path.join(dir, "main.js"));
    createBuildSession().compile({}, { entries: [entry], quiet: true });
    expect(fs.statSync(path.join(dir, "main.js")).mtimeMs).toBeGreaterThan(runStamped);
  });

  test("deleting the output recompiles", () => {
    const dir = writeTempDir({ "main.agency": TRIVIAL });
    const entry = path.join(dir, "main.agency");
    createBuildSession().compile({}, { entries: [entry], quiet: true });
    fs.unlinkSync(path.join(dir, "main.js"));
    createBuildSession().compile({}, { entries: [entry], quiet: true });
    expect(fs.existsSync(path.join(dir, "main.js"))).toBe(true);
  });

  test("freshness force recompiles and rewrites the manifest", () => {
    const dir = writeTempDir({ "main.agency": TRIVIAL });
    const entry = path.join(dir, "main.agency");
    createBuildSession().compile({}, { entries: [entry], quiet: true });
    const stamped = backdate(path.join(dir, "main.js"));
    createBuildSession().compile({}, { entries: [entry], quiet: true, freshness: "force" });
    expect(fs.statSync(path.join(dir, "main.js")).mtimeMs).toBeGreaterThan(stamped);
    expect(loadManifest(dir).entries["main.agency"]).toBeDefined();
  });

  test("mixed closure: dirty member recompiles, clean sibling skips emit", () => {
    const dir = writeTempDir({
      "helper.agency": HELPER,
      "a.agency": IMPORTS_HELPER,
      "b.agency": TRIVIAL,
    });
    const entries = [path.join(dir, "a.agency"), path.join(dir, "b.agency")];
    createBuildSession().compile({}, { entries, quiet: true });
    const bStamped = backdate(path.join(dir, "b.js"));
    fs.writeFileSync(path.join(dir, "a.agency"), IMPORTS_HELPER + "\n// touched\n");
    createBuildSession().compile({}, { entries, quiet: true });
    expect(fs.statSync(path.join(dir, "b.js")).mtimeMs).toBe(bStamped);
  });

  test("directory entry: fully-clean directory skips with zero parses", () => {
    const dir = writeTempDir({ "helper.agency": HELPER, "a.agency": IMPORTS_HELPER });
    createBuildSession().compile({}, { entries: [dir], quiet: true });
    parseCacheInternal.clear();
    const before = { ...parseCacheInternal.stats };
    createBuildSession().compile({}, { entries: [dir], quiet: true });
    expect(parseCacheInternal.stats.misses).toBe(before.misses);
    expect(parseCacheInternal.stats.hits).toBe(before.hits);
  });
});
