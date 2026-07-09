import { describe, expect, test } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  hashBytes,
  hashFile,
  computeDepsHash,
  loadManifest,
  saveManifest,
  computeStdlibHash,
  computeCompilerStamp,
  isEntryFresh,
  manifestDirFor,
  MANIFEST_DIR_NAME,
  type BuildManifest,
  type FreshnessContext,
} from "./buildManifest.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agency-manifest-"));
}

// A fresh two-entry manifest (main imports dep) + matching on-disk state;
// each test perturbs ONE dimension.
function freshFixture(): { dir: string; manifest: BuildManifest; ctx: FreshnessContext } {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "main.agency"), "node main() {\n  return 1\n}\n");
  fs.writeFileSync(path.join(dir, "dep.agency"), 'export def d(): number {\n  return 2\n}\n');
  fs.writeFileSync(path.join(dir, "main.js"), "// compiled");
  fs.writeFileSync(path.join(dir, "dep.js"), "// compiled dep");
  const depHash = hashFile(path.join(dir, "dep.agency"))!;
  const shared = {
    stdlibHash: "STDLIB",
    hasPkgImports: false,
    configKey: "{}",
    compilerStamp: "COMPILER",
  };
  const manifest: BuildManifest = {
    version: 1,
    entries: {
      "main.agency": {
        ...shared,
        sourceHash: hashFile(path.join(dir, "main.agency"))!,
        deps: ["dep.agency"],
        depsHash: computeDepsHash([depHash]),
        outputPath: "main.js",
      },
      "dep.agency": {
        ...shared,
        sourceHash: depHash,
        deps: [],
        depsHash: computeDepsHash([]),
        outputPath: "dep.js",
      },
    },
  };
  const ctx: FreshnessContext = {
    manifestDir: dir,
    stdlibHash: "STDLIB",
    compilerStamp: "COMPILER",
    configKey: "{}",
  };
  return { dir, manifest, ctx };
}

describe("manifest IO", () => {
  test("loadManifest returns empty for missing, corrupt, and wrong-version files", () => {
    const dir = tmp();
    expect(loadManifest(dir).entries).toEqual({});
    fs.mkdirSync(path.join(dir, MANIFEST_DIR_NAME), { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST_DIR_NAME, "manifest.json"), "{not json");
    expect(loadManifest(dir).entries).toEqual({});
    fs.writeFileSync(
      path.join(dir, MANIFEST_DIR_NAME, "manifest.json"),
      JSON.stringify({ version: 99, entries: { x: {} } }),
    );
    expect(loadManifest(dir).entries).toEqual({});
  });

  test("saveManifest round-trips atomically and leaves no tmp file", () => {
    const dir = tmp();
    const manifest: BuildManifest = { version: 1, entries: {} };
    saveManifest(dir, manifest);
    expect(loadManifest(dir)).toEqual(manifest);
    expect(fs.readdirSync(path.join(dir, MANIFEST_DIR_NAME))).toEqual(["manifest.json"]);
  });

  test("manifestDirFor falls back to the file dir without an agency.json", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "x.agency"), "");
    expect(manifestDirFor(path.join(dir, "x.agency"))).toBe(dir);
  });

  test("manifestDirFor anchors DIRECTORY entries at the directory itself, not its parent", () => {
    const parent = tmp();
    const projectDir = path.join(parent, "someProject");
    fs.mkdirSync(projectDir);
    fs.writeFileSync(path.join(projectDir, "x.agency"), "");
    expect(manifestDirFor(projectDir)).toBe(projectDir);
  });
});

describe("hashing", () => {
  test("hashFile returns null for missing files and a stable hex hash otherwise", () => {
    const dir = tmp();
    expect(hashFile(path.join(dir, "nope"))).toBeNull();
    fs.writeFileSync(path.join(dir, "a"), "hello");
    expect(hashFile(path.join(dir, "a"))).toBe(hashBytes("hello"));
    expect(hashFile(path.join(dir, "a"))).toMatch(/^[0-9a-f]{64}$/);
  });

  test("computeDepsHash is order-sensitive and deterministic", () => {
    expect(computeDepsHash(["a", "b"])).toBe(computeDepsHash(["a", "b"]));
    expect(computeDepsHash(["a", "b"])).not.toBe(computeDepsHash(["b", "a"]));
    expect(computeDepsHash([])).toMatch(/^[0-9a-f]{64}$/);
  });

  test("computeStdlibHash changes when any stdlib source changes and ignores non-agency files", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "a.agency"), "one");
    fs.writeFileSync(path.join(dir, "sub", "b.agency"), "two");
    fs.writeFileSync(path.join(dir, "a.js"), "ignored");
    const before = computeStdlibHash(dir);
    fs.writeFileSync(path.join(dir, "a.js"), "still ignored, changed");
    expect(computeStdlibHash(dir)).toBe(before);
    fs.writeFileSync(path.join(dir, "sub", "b.agency"), "two!");
    expect(computeStdlibHash(dir)).not.toBe(before);
  });

  test("computeCompilerStamp excludes runtime/ and agents/ and keys on content", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "backends"));
    fs.mkdirSync(path.join(dir, "runtime"));
    fs.mkdirSync(path.join(dir, "agents"));
    fs.writeFileSync(path.join(dir, "backends", "gen.js"), "v1");
    fs.writeFileSync(path.join(dir, "runtime", "r.js"), "r1");
    fs.writeFileSync(path.join(dir, "agents", "a.js"), "a1");
    const before = computeCompilerStamp(dir);
    fs.writeFileSync(path.join(dir, "runtime", "r.js"), "r2");
    fs.writeFileSync(path.join(dir, "agents", "a.js"), "a2");
    expect(computeCompilerStamp(dir)).toBe(before);
    fs.writeFileSync(path.join(dir, "backends", "gen.js"), "v2");
    expect(computeCompilerStamp(dir)).not.toBe(before);
  });
});

describe("isEntryFresh — each field is load-bearing", () => {
  test("fresh when everything matches", () => {
    const { manifest, ctx } = freshFixture();
    expect(isEntryFresh("main.agency", manifest, ctx)).toBe(true);
  });

  test("no entry → stale", () => {
    const { manifest, ctx } = freshFixture();
    delete manifest.entries["main.agency"];
    expect(isEntryFresh("main.agency", manifest, ctx)).toBe(false);
  });

  test("source edit → stale", () => {
    const { dir, manifest, ctx } = freshFixture();
    fs.writeFileSync(path.join(dir, "main.agency"), "node main() {\n  return 2\n}\n");
    expect(isEntryFresh("main.agency", manifest, ctx)).toBe(false);
  });

  test("dep content edit → stale", () => {
    const { dir, manifest, ctx } = freshFixture();
    fs.writeFileSync(path.join(dir, "dep.agency"), 'export def d(): number {\n  return 3\n}\n');
    expect(isEntryFresh("main.agency", manifest, ctx)).toBe(false);
  });

  test("missing dep file → stale", () => {
    const { dir, manifest, ctx } = freshFixture();
    fs.unlinkSync(path.join(dir, "dep.agency"));
    expect(isEntryFresh("main.agency", manifest, ctx)).toBe(false);
  });

  test("missing dep OUTPUT → stale (a skip never visits deps)", () => {
    const { dir, manifest, ctx } = freshFixture();
    fs.unlinkSync(path.join(dir, "dep.js"));
    expect(isEntryFresh("main.agency", manifest, ctx)).toBe(false);
  });

  test("missing dep ENTRY → stale", () => {
    const { manifest, ctx } = freshFixture();
    delete manifest.entries["dep.agency"];
    expect(isEntryFresh("main.agency", manifest, ctx)).toBe(false);
  });

  test("stdlibHash mismatch → stale", () => {
    const { manifest, ctx } = freshFixture();
    expect(isEntryFresh("main.agency", manifest, { ...ctx, stdlibHash: "OTHER" })).toBe(false);
  });

  test("compilerStamp mismatch → stale", () => {
    const { manifest, ctx } = freshFixture();
    expect(isEntryFresh("main.agency", manifest, { ...ctx, compilerStamp: "OTHER" })).toBe(false);
  });

  test("configKey mismatch → stale", () => {
    const { manifest, ctx } = freshFixture();
    expect(isEntryFresh("main.agency", manifest, { ...ctx, configKey: '{"verbose":true}' })).toBe(false);
  });

  test("hasPkgImports → never fresh", () => {
    const { manifest, ctx } = freshFixture();
    manifest.entries["main.agency"].hasPkgImports = true;
    expect(isEntryFresh("main.agency", manifest, ctx)).toBe(false);
  });

  test("missing own output → stale", () => {
    const { dir, manifest, ctx } = freshFixture();
    fs.unlinkSync(path.join(dir, "main.js"));
    expect(isEntryFresh("main.agency", manifest, ctx)).toBe(false);
  });
});
