import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";

// Redirect the stdlib to a per-test fixture. Mocking getStdlibDir alone is
// NOT enough: resolveAgencyImportPath calls the module-local getStdlibDir
// inside importPaths.ts, which an export mock cannot reach — so the
// resolver is overridden too, delegating non-std:: targets to the real
// one. isNonTemplatedStdlib reports EVERY fixture file as non-templated so
// real compiles need no prelude surface (the templated prelude edge is
// covered against the real stdlib in depFingerprint.test.ts).
const fake = vi.hoisted(() => ({ stdlibDir: "", fixtureRoot: "" }));
vi.mock("../importPaths.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../importPaths.js")>();
  return {
    ...real,
    getStdlibDir: () => fake.stdlibDir,
    // EVERY fixture file (stdlib and user alike) is non-templated, so no
    // fixture needs the ~30-name prelude surface stubbed out.
    isNonTemplatedStdlib: (p: string) =>
      fake.fixtureRoot !== "" && p.startsWith(fake.fixtureRoot + path.sep),
    resolveAgencyImportPath: (importPath: string, fromFile: string) =>
      real.isStdlibImport(importPath)
        ? path.join(fake.stdlibDir, real.normalizeStdlibPath(importPath) + ".agency")
        : real.resolveAgencyImportPath(importPath, fromFile),
  };
});

import { createBuildSession } from "./buildSession.js";
import { loadManifest, hashFile, MANIFEST_DIR_NAME } from "./buildManifest.js";
import { evictParseCache } from "../parseCache.js";
import { clearSpliceCache } from "./splice/cache.js";
import { safeDeleteDirectory } from "../utils.js";

const EPOCH = new Date(0);

let root = "";

beforeEach(() => {
  // Under the package dir (like runGenerator.test.ts), NOT os.tmpdir():
  // splice generators execute in a subprocess whose runner imports the
  // agency-lang package, which only resolves from inside the repo tree.
  fs.mkdirSync(path.join(process.cwd(), ".agency-tmp"), { recursive: true });
  root = fs.mkdtempSync(path.join(process.cwd(), ".agency-tmp", "stdlibdeps-"));
  fake.fixtureRoot = root;
  fake.stdlibDir = path.join(root, "stdlib");
  clearSpliceCache();
});

afterEach(() => {
  clearSpliceCache();
  safeDeleteDirectory(root, false);
});

// index ← helper ← consumer; index ← other. All non-templated under the
// mock, so edges are exactly the explicit imports.
const BASE_FIXTURE: Record<string, string> = {
  "index.agency": `export def i(): number { return 1 }\n`,
  "helper.agency": `import { i } from "std::index"\nexport def h(): number { return i() }\n`,
  "consumer.agency": `import { h } from "std::helper"\nexport def c(): number { return h() }\n`,
  "other.agency": `import { i } from "std::index"\nexport def o(): number { return i() }\n`,
};

function makeFixture(files: Record<string, string> = BASE_FIXTURE): void {
  fs.mkdirSync(fake.stdlibDir, { recursive: true });
  // Anchor manifestDirFor at the fixture root: without a project marker,
  // findProjectRoot would walk up and find the PACKAGE's agency.json
  // (fixtures live under <pkg>/.agency-tmp), putting the manifest there.
  fs.writeFileSync(path.join(root, "agency.json"), "{}\n");
  for (const [rel, content] of Object.entries(files)) {
    write(rel, content);
  }
}

/** Manifest lives at the fixture ROOT (agency.json anchor); entries are
 *  keyed root-relative, e.g. "stdlib/consumer.agency". */
const stdlibRel = (f: string) => path.join("stdlib", f);

function write(rel: string, content: string): void {
  const abs = path.join(fake.stdlibDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  evictParseCache(abs);
}

function rmSource(rel: string): void {
  const abs = path.join(fake.stdlibDir, rel);
  fs.rmSync(abs);
  evictParseCache(abs);
}

function compileDir(): void {
  // Fresh session per logical CLI invocation: a reused session's
  // compiledFiles dedup can skip compilation independently of the
  // manifest and fake incremental results.
  createBuildSession().compile({}, { entries: [fake.stdlibDir], freshness: "incremental", quiet: true });
}

function jsFiles(): string[] {
  return fs
    .readdirSync(fake.stdlibDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(fake.stdlibDir, f));
}

function backdateAllJs(): void {
  for (const f of jsFiles()) {
    fs.utimesSync(f, EPOCH, EPOCH);
  }
}

/** Outputs whose mtime moved off the backdated epoch. */
function rewrittenJs(): string[] {
  return jsFiles()
    .filter((f) => fs.statSync(f).mtimeMs > 0)
    .map((f) => path.basename(f))
    .sort();
}

/** { basename → bytes } for outputs derived from CURRENT sources only.
 *  Deliberately not a directory listing: after delete/rename the
 *  incremental dir legitimately keeps the old orphan .js (output
 *  reconciliation is out of scope), which a clean force run can never
 *  reproduce. */
function jsSnapshotForSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(fake.stdlibDir)) {
    if (!f.endsWith(".agency")) continue;
    const js = f.replace(/\.agency$/, ".js");
    out[js] = fs.readFileSync(path.join(fake.stdlibDir, js), "utf-8");
  }
  return out;
}

describe("BuildSession rewrite sets (selective recompilation)", () => {
  test("warm run rewrites nothing", () => {
    makeFixture();
    compileDir();
    backdateAllJs();
    compileDir();
    expect(rewrittenJs()).toEqual([]);
  });

  test("edit helper → helper + consumer only", () => {
    makeFixture();
    compileDir();
    backdateAllJs();
    write("helper.agency", `import { i } from "std::index"\nexport def h(): number { return i() + 1 }\n`);
    compileDir();
    expect(rewrittenJs()).toEqual(["consumer.js", "helper.js"]);
  });

  test("edit index → all four", () => {
    makeFixture();
    compileDir();
    backdateAllJs();
    write("index.agency", `export def i(): number { return 2 }\n`);
    compileDir();
    expect(rewrittenJs()).toEqual(["consumer.js", "helper.js", "index.js", "other.js"]);
  });

  test("add a source → all current outputs rewrite (names hash)", () => {
    makeFixture();
    compileDir();
    backdateAllJs();
    write("extra.agency", `export def e(): number { return 9 }\n`);
    compileDir();
    expect(rewrittenJs()).toEqual(["consumer.js", "extra.js", "helper.js", "index.js", "other.js"]);
  });

  test("delete an unimported source → all remaining outputs rewrite", () => {
    makeFixture();
    compileDir();
    backdateAllJs();
    rmSource("other.agency");
    compileDir();
    // other.js survives as an orphan but is not rewritten.
    expect(rewrittenJs()).toEqual(["consumer.js", "helper.js", "index.js"]);
  });

  test("deleted dep output → dep and its importer re-emit", () => {
    makeFixture();
    compileDir();
    backdateAllJs();
    fs.rmSync(path.join(fake.stdlibDir, "helper.js"));
    // Explicit entry order (consumer first): compileEntry runs
    // sequentially, and if helper compiled first it would recreate
    // helper.js before consumer's freshness check ran, making the
    // expected set traversal-order-dependent.
    const entry = (f: string) => path.join(fake.stdlibDir, f);
    createBuildSession().compile({}, {
      entries: [entry("consumer.agency"), entry("helper.agency"), entry("index.agency"), entry("other.agency")],
      freshness: "incremental",
      quiet: true,
    });
    expect(rewrittenJs()).toEqual(["consumer.js", "helper.js"]);
  });
});

describe("production manifest wiring", () => {
  test("entries record real std:: deps, transitively", () => {
    makeFixture();
    compileDir();
    const manifest = loadManifest(root);
    const consumer = manifest.entries[stdlibRel("consumer.agency")];
    expect(consumer.deps).toEqual([stdlibRel("helper.agency"), stdlibRel("index.agency")]);
    expect(consumer.cacheable).toBe(true);
    expect(consumer.hasPkgImports).toBe(false);
    const other = manifest.entries[stdlibRel("other.agency")];
    expect(other.deps).toEqual([stdlibRel("index.agency")]);
    for (const entry of Object.values(manifest.entries)) {
      for (const dep of entry.deps) {
        expect(hashFile(path.join(root, dep))).not.toBeNull();
      }
    }
  });

  test("splice-containing stdlib source records cacheable:false and re-emits every run", () => {
    makeFixture({
      ...BASE_FIXTURE,
      // The established declaration-splice shape
      // (tests/agency/splices/declarationSplice*.agency), minus the Code
      // type annotation: an std::agency import would make the compiled
      // generator import the real stdlib's agency.js, which does not
      // exist in an unbuilt tree (typechecking is off here, so the
      // annotation carries no weight anyway).
      "spliceGen.agency": `export def makeGreeter() {\n  return [|\n    def greet(): string {\n      return "generated"\n    }\n  |]\n}\n`,
      "spliceUser.agency": `import { makeGreeter } from "./spliceGen.agency"\n$( makeGreeter() )\nnode main(): string { return greet() }\n`,
    });
    compileDir();
    // Fixture validity first: the splice actually expanded and emitted.
    expect(fs.existsSync(path.join(fake.stdlibDir, "spliceUser.js"))).toBe(true);
    const manifest = loadManifest(root);
    expect(manifest.entries[stdlibRel("spliceUser.agency")].cacheable).toBe(false);
    backdateAllJs();
    clearSpliceCache();
    compileDir();
    expect(rewrittenJs()).toContain("spliceUser.js"); // never skipped
  });

  test("stdlib-copy sibling gets contents flavor and no std:: deps", () => {
    makeFixture();
    const copyDir = path.join(root, "stdlib-copy");
    fs.mkdirSync(copyDir, { recursive: true });
    fs.writeFileSync(path.join(copyDir, "app.agency"), `export def a(): number { return 1 }\n`);
    createBuildSession().compile({}, {
      entries: [path.join(copyDir, "app.agency")],
      freshness: "incremental",
      quiet: true,
    });
    const manifest = loadManifest(root);
    const entry = manifest.entries[path.join("stdlib-copy", "app.agency")];
    expect(entry).toBeDefined();
    expect(entry.deps).toEqual([]);
    // Contents flavor: an edit to a fixture-stdlib FILE changes the
    // recorded hash a fresh tracker computes, so the entry goes stale.
    const before = createBuildSession().compile({}, {
      entries: [path.join(copyDir, "app.agency")],
      freshness: "incremental",
      quiet: true,
    });
    expect(before).toBe(path.join(copyDir, "app.js")); // fresh fast-path
    write("index.agency", `export def i(): number { return 42 }\n`);
    const out = path.join(copyDir, "app.js");
    fs.utimesSync(out, EPOCH, EPOCH);
    createBuildSession().compile({}, {
      entries: [path.join(copyDir, "app.agency")],
      freshness: "incremental",
      quiet: true,
    });
    expect(fs.statSync(out).mtimeMs).toBeGreaterThan(0); // re-emitted
  });
});

describe("single-file guarantee boundary", () => {
  test("re-emits until directory build exists, skips after", () => {
    makeFixture();
    const consumer = path.join(fake.stdlibDir, "consumer.agency");
    createBuildSession().compile({}, { entries: [consumer], freshness: "incremental", quiet: true });
    const out = path.join(fake.stdlibDir, "consumer.js");
    fs.utimesSync(out, EPOCH, EPOCH);
    // Dep entries (helper, index) missing → still stale → re-emits.
    createBuildSession().compile({}, { entries: [consumer], freshness: "incremental", quiet: true });
    expect(fs.statSync(out).mtimeMs).toBeGreaterThan(0);
    // After a full directory build, the same single-file compile skips.
    compileDir();
    fs.utimesSync(out, EPOCH, EPOCH);
    createBuildSession().compile({}, { entries: [consumer], freshness: "incremental", quiet: true });
    expect(fs.statSync(out).mtimeMs).toBe(0);
  });
});

describe("incremental emit is byte-identical to force emit", () => {
  function forceSnapshot(): Record<string, string> {
    fs.rmSync(path.join(root, MANIFEST_DIR_NAME), { recursive: true, force: true });
    createBuildSession().compile({}, { entries: [fake.stdlibDir], freshness: "force", quiet: true });
    return jsSnapshotForSources();
  }

  const mutations: Array<[string, () => void]> = [
    ["edit leaf (helper)", () => write("helper.agency", `import { i } from "std::index"\nexport def h(): number { return i() * 2 }\n`)],
    ["edit hub (index)", () => write("index.agency", `export def i(): number { return 7 }\n`)],
    ["edit a re-export edge", () => write("reexport.agency", `export { h } from "std::helper"\n`)],
    ["edit a cycle pair member", () => write("cycA.agency", `import { cb } from "std::cycB"\nexport def ca(): number { return 10 }\n`)],
    ["add a file", () => write("added.agency", `export def added(): number { return 5 }\n`)],
    ["delete an unimported file", () => rmSource("other.agency")],
    ["rename an unimported file", () => {
      const from = path.join(fake.stdlibDir, "other.agency");
      const to = path.join(fake.stdlibDir, "renamed.agency");
      fs.renameSync(from, to);
      evictParseCache(from);
      evictParseCache(to);
    }],
    ["seeded version-1 manifest", () => {
      const file = path.join(root, MANIFEST_DIR_NAME, "manifest.json");
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      raw.version = 1;
      fs.writeFileSync(file, JSON.stringify(raw));
    }],
  ];

  test.each(mutations)("%s", (_name, mutate) => {
    makeFixture({
      ...BASE_FIXTURE,
      // Legal def-only import cycle (no static initializers) and a
      // re-export edge, so those rows mutate real structures.
      "reexport.agency": `export { i } from "std::index"\n`,
      "cycA.agency": `import { cb } from "std::cycB"\nexport def ca(): number { return 1 }\n`,
      "cycB.agency": `import { ca } from "std::cycA"\nexport def cb(): number { return 2 }\n`,
    });
    compileDir();
    mutate();
    compileDir();
    const incremental = jsSnapshotForSources();
    expect(forceSnapshot()).toEqual(incremental);
  });

  test("seeded v1 manifest re-emits everything (migration)", () => {
    makeFixture();
    compileDir();
    const file = path.join(root, MANIFEST_DIR_NAME, "manifest.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    raw.version = 1;
    fs.writeFileSync(file, JSON.stringify(raw));
    backdateAllJs();
    compileDir();
    expect(rewrittenJs()).toEqual(["consumer.js", "helper.js", "index.js", "other.js"]);
  });
});
