import { describe, expect, test, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { AgencyConfig } from "@/config.js";
import {
  DOC_LEDGER_NAME,
  DOC_LOCK_NAME,
  acquireDocLock,
  buildDocFreshnessContext,
  buildDocLedgerEntry,
  captureDepSnapshot,
  docRenderKey,
  isDocEntryFresh,
  isSafeSourceRel,
  ledgerEntryHasValidShape,
  loadDocLedger,
  outputPathFor,
  releaseDocLock,
  resolveOwnedOutputPath,
  saveDocLedger,
  type DocLedger,
  type DocLedgerEntry,
} from "./docLedger.js";
import { hashBytes } from "@/compiler/buildManifest.js";
import { evictParseCache } from "@/parseCache.js";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agency-docledger-"));
  dirs.push(d);
  return fs.realpathSync(d);
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("keys and paths", () => {
  test("isSafeSourceRel", () => {
    expect(isSafeSourceRel("a.agency")).toBe(true);
    expect(isSafeSourceRel(path.join("web", "a.agency"))).toBe(true);
    // Raw joins, not path.join: path.join normalizes eagerly and would
    // hand isSafeSourceRel an already-clean string.
    for (const bad of [
      "",
      "/abs/a.agency",
      "../a.agency",
      ["x", "..", "..", "a.agency"].join(path.sep),
      "." + path.sep + "a.agency",
      ["x", "..", "a.agency"].join(path.sep),
      "README",
      "notes.md",
      "a.agency.bak",
    ]) {
      expect(isSafeSourceRel(bad), bad).toBe(false);
    }
  });

  test("outputPathFor maps .agency → .md and throws on unsafe keys", () => {
    expect(outputPathFor("client.agency")).toBe("client.md");
    expect(outputPathFor(path.join("web", "b.agency"))).toBe(path.join("web", "b.md"));
    expect(() => outputPathFor("README")).toThrow(/unsafe/);
    expect(() => outputPathFor("../a.agency")).toThrow(/unsafe/);
  });

  test("resolveOwnedOutputPath: containment, symlinked ancestor, leaf symlink, createParents", () => {
    const out = tmp();
    expect(resolveOwnedOutputPath(out, "a.md").abs).toBe(path.join(out, "a.md"));
    expect(() => resolveOwnedOutputPath(out, path.join("..", "a.md"))).toThrow(/escapes/);
    expect(() => resolveOwnedOutputPath(out, path.sep + "abs.md")).toThrow(/absolute/);
    // symlinked ancestor
    const victim = tmp();
    fs.symlinkSync(victim, path.join(out, "sub"));
    expect(() => resolveOwnedOutputPath(out, path.join("sub", "a.md"))).toThrow(
      /symlinked ancestor/,
    );
    // leaf symlink reported, not followed
    fs.writeFileSync(path.join(victim, "real.md"), "x");
    fs.symlinkSync(path.join(victim, "real.md"), path.join(out, "leaf.md"));
    expect(resolveOwnedOutputPath(out, "leaf.md").leafIsSymlink).toBe(true);
    // createParents makes nested dirs and verifies them
    const r = resolveOwnedOutputPath(out, path.join("deep", "nest", "p.md"), {
      createParents: true,
    });
    expect(fs.existsSync(path.dirname(r.abs))).toBe(true);
  });

  test("docRenderKey: structured, base-url- and config-sensitive, stable", () => {
    const a = docRenderKey({}, "https://x");
    expect(docRenderKey({}, "https://x")).toBe(a);
    expect(docRenderKey({}, "https://y")).not.toBe(a);
    expect(docRenderKey({ verbose: true } as AgencyConfig, "https://x")).not.toBe(a);
  });
});

function validEntry(overrides: Partial<DocLedgerEntry> = {}): DocLedgerEntry {
  return {
    sourceHash: "s",
    deps: [],
    depsHash: "d",
    cacheable: true,
    hasPkgImports: false,
    stdlibHash: "sl",
    compilerStamp: "c",
    outputPath: "a.md",
    outputHash: "o",
    registrySymbols: ["x"],
    linkTargets: { Foo: "types.md", Bar: null },
    ...overrides,
  };
}

function validLedger(outDir: string): DocLedger {
  return {
    version: 1,
    outputDir: outDir,
    identity: { inputDir: "/in", ignoreDirs: [] },
    renderKey: "rk",
    entries: { "a.agency": validEntry() },
  };
}

describe("ledger load/save authority", () => {
  test("round trip grants authority", () => {
    const out = tmp();
    saveDocLedger(out, validLedger(out));
    const { ledger, authority } = loadDocLedger(out);
    expect(authority).toBe(true);
    expect(ledger?.entries["a.agency"].registrySymbols).toEqual(["x"]);
  });

  test("missing ledger: no authority", () => {
    expect(loadDocLedger(tmp())).toEqual({ ledger: null, authority: false });
  });

  test.each<[string, (raw: any) => any]>([
    ["not json", () => "not json {{{"],
    ["wrong version", (raw) => ({ ...raw, version: 99 })],
    ["foreign outputDir", (raw) => ({ ...raw, outputDir: "/somewhere/else" })],
    ["missing identity", (raw) => ({ ...raw, identity: undefined })],
    [
      "malformed identity.inputDir",
      (raw) => ({ ...raw, identity: { inputDir: 42, ignoreDirs: [] } }),
    ],
    [
      "malformed ignoreDirs",
      (raw) => ({ ...raw, identity: { inputDir: "/in", ignoreDirs: "tests" } }),
    ],
    ["missing renderKey", (raw) => ({ ...raw, renderKey: undefined })],
    ["array entries", (raw) => ({ ...raw, entries: ["x"] })],
    ["unsafe entry key", (raw) => ({ ...raw, entries: { "../evil.agency": validEntry() } })],
    ["non-.agency entry key", (raw) => ({ ...raw, entries: { README: validEntry() } })],
    ["malformed sourceHash", (raw) => mut(raw, (e) => (e.sourceHash = 1))],
    ["non-array deps", (raw) => mut(raw, (e) => (e.deps = "x"))],
    ["relative dep element", (raw) => mut(raw, (e) => (e.deps = ["not/absolute.agency"]))],
    ["malformed depsHash", (raw) => mut(raw, (e) => (e.depsHash = 7))],
    ["malformed cacheable", (raw) => mut(raw, (e) => (e.cacheable = "yes"))],
    ["malformed hasPkgImports", (raw) => mut(raw, (e) => (e.hasPkgImports = 0))],
    ["malformed stdlibHash", (raw) => mut(raw, (e) => (e.stdlibHash = null))],
    ["malformed compilerStamp", (raw) => mut(raw, (e) => (e.compilerStamp = []))],
    ["malformed outputPath", (raw) => mut(raw, (e) => (e.outputPath = 9))],
    ["malformed outputHash", (raw) => mut(raw, (e) => (e.outputHash = {}))],
    ["non-array registrySymbols", (raw) => mut(raw, (e) => (e.registrySymbols = {}))],
    ["non-string registry symbol", (raw) => mut(raw, (e) => (e.registrySymbols = [42]))],
    ["array linkTargets", (raw) => mut(raw, (e) => (e.linkTargets = ["x"]))],
    ["bad linkTargets value", (raw) => mut(raw, (e) => (e.linkTargets = { Foo: 7 }))],
  ])("authority denied: %s", (_name, corrupt) => {
    const out = tmp();
    saveDocLedger(out, validLedger(out));
    const file = path.join(out, DOC_LEDGER_NAME);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    const mutated = corrupt(raw);
    fs.writeFileSync(file, typeof mutated === "string" ? mutated : JSON.stringify(mutated));
    expect(loadDocLedger(out)).toEqual({ ledger: null, authority: false });
  });

  test("save temp cannot be symlink-hijacked: old predictable name is ignored, victim untouched", () => {
    const out = tmp();
    const victim = tmp();
    fs.writeFileSync(path.join(victim, "precious"), "precious\n");
    // Pre-plant a symlink at the OLD predictable temp name.
    fs.symlinkSync(
      path.join(victim, "precious"),
      path.join(out, `${DOC_LEDGER_NAME}.${process.pid}.tmp`),
    );
    saveDocLedger(out, validLedger(out));
    expect(fs.readFileSync(path.join(victim, "precious"), "utf-8")).toBe("precious\n");
    expect(loadDocLedger(out).authority).toBe(true);
    // No stray temps left behind (the planted one is not ours to remove).
    const temps = fs.readdirSync(out).filter((f) => f.endsWith(".tmp"));
    expect(temps).toEqual([`${DOC_LEDGER_NAME}.${process.pid}.tmp`]);
  });

  test("saveDocLedger refuses an unsafe key and leaves the valid ledger intact", () => {
    const out = tmp();
    saveDocLedger(out, validLedger(out));
    const bad = validLedger(out);
    bad.entries["README" as string] = validEntry();
    expect(() => saveDocLedger(out, bad)).toThrow(/unsafe/);
    expect(loadDocLedger(out).authority).toBe(true);
  });

  test("ledgerEntryHasValidShape accepts the canonical entry", () => {
    expect(ledgerEntryHasValidShape(validEntry())).toBe(true);
    expect(ledgerEntryHasValidShape(null)).toBe(false);
  });
});

function mut(raw: any, f: (entry: any) => void): any {
  f(raw.entries["a.agency"]);
  return raw;
}

describe("lock", () => {
  test("EEXIST throws with holder info; token-verified release; non-EEXIST propagates", () => {
    const dir = tmp();
    const lock = acquireDocLock(dir);
    expect(() => acquireDocLock(dir)).toThrow(/held \(/);
    releaseDocLock(lock);
    expect(fs.existsSync(path.join(dir, DOC_LOCK_NAME))).toBe(false);
    // stale handle vs same-process successor: SAME pid, new token
    const l2 = acquireDocLock(dir);
    releaseDocLock(l2);
    const l3 = acquireDocLock(dir);
    releaseDocLock(l2); // stale handle must NOT remove the new lock
    expect(fs.existsSync(l3.lockPath)).toBe(true);
    releaseDocLock(l3);
    // foreign takeover between read and rm: untouched
    const l4 = acquireDocLock(dir);
    fs.writeFileSync(l4.lockPath, "999:someone-else");
    releaseDocLock(l4);
    expect(fs.readFileSync(l4.lockPath, "utf-8")).toBe("999:someone-else");
    fs.rmSync(l4.lockPath);
    // non-EEXIST propagates
    expect(() => acquireDocLock(path.join(dir, "no-such-dir"))).toThrow(/ENOENT/);
  });
});

describe("entry builder + freshness predicate (writer/checker pair)", () => {
  function pairFixture() {
    const inputDir = tmp();
    const outDir = tmp();
    fs.writeFileSync(
      path.join(inputDir, "a.agency"),
      `import { b } from "./b.agency"\nexport def a(): number { return b() }\n`,
    );
    fs.writeFileSync(path.join(inputDir, "b.agency"), `export def b(): number { return 2 }\n`);
    const ctx = buildDocFreshnessContext(inputDir, outDir);
    const md = "# a\n\ncontent\n";
    fs.writeFileSync(path.join(outDir, "a.md"), md);
    const entry = buildDocLedgerEntry({
      sourceRel: "a.agency",
      ctx,
      config: {},
      registrySymbols: ["a"],
      linkTargets: { Foo: null },
      strayHiddenLines: [],
      writtenBytes: md,
    });
    return { inputDir, outDir, ctx, entry, md };
  }

  test("freshly built entry is fresh; deps recorded absolute and sorted", () => {
    const { ctx, entry, inputDir } = pairFixture();
    expect(entry.deps).toEqual([path.join(inputDir, "b.agency")]);
    expect(entry.outputHash).toBe(hashBytes("# a\n\ncontent\n"));
    expect(isDocEntryFresh("a.agency", entry, ctx)).toBe(true);
  });

  test.each<[string, (f: ReturnType<typeof pairFixture>) => void]>([
    [
      "source edit",
      (f) =>
        fs.writeFileSync(
          path.join(f.inputDir, "a.agency"),
          "export def a(): number { return 9 }\n",
        ),
    ],
    [
      "dep edit",
      (f) =>
        fs.writeFileSync(
          path.join(f.inputDir, "b.agency"),
          "export def b(): number { return 9 }\n",
        ),
    ],
    ["dep deleted", (f) => fs.rmSync(path.join(f.inputDir, "b.agency"))],
    ["output hand-edited", (f) => fs.writeFileSync(path.join(f.outDir, "a.md"), "tampered")],
    ["output deleted", (f) => fs.rmSync(path.join(f.outDir, "a.md"))],
    [
      "output replaced by symlink",
      (f) => {
        fs.rmSync(path.join(f.outDir, "a.md"));
        fs.writeFileSync(path.join(f.outDir, "elsewhere"), f.md);
        fs.symlinkSync(path.join(f.outDir, "elsewhere"), path.join(f.outDir, "a.md"));
      },
    ],
  ])("stale after: %s", (_name, perturb) => {
    const f = pairFixture();
    perturb(f);
    expect(isDocEntryFresh("a.agency", f.entry, f.ctx)).toBe(false);
  });

  test("stale on: compiler stamp / stdlib flavor / cacheable / pkg flags", () => {
    const f = pairFixture();
    expect(isDocEntryFresh("a.agency", f.entry, { ...f.ctx, compilerStamp: "OTHER" })).toBe(false);
    expect(isDocEntryFresh("a.agency", { ...f.entry, cacheable: false }, f.ctx)).toBe(false);
    expect(isDocEntryFresh("a.agency", { ...f.entry, hasPkgImports: true }, f.ctx)).toBe(false);
    // flavor: pretend the source dir IS the stdlib — the entry recorded the
    // contents flavor, so the names flavor must mismatch and stale it.
    expect(
      isDocEntryFresh("a.agency", f.entry, {
        ...f.ctx,
        stdlibDir: f.ctx.inputDir,
        stdlibNamesHash: "N",
      }),
    ).toBe(false);
  });

  test("source drift between parse and entry-build forces cacheable:false", () => {
    const inputDir = tmp();
    const outDir = tmp();
    fs.writeFileSync(path.join(inputDir, "a.agency"), `export def a(): number { return 1 }\n`);
    const ctx = buildDocFreshnessContext(inputDir, outDir);
    const entry = buildDocLedgerEntry({
      sourceRel: "a.agency",
      ctx,
      config: {},
      registrySymbols: ["a"],
      linkTargets: {},
      strayHiddenLines: [],
      writtenBytes: "x",
      // Simulates an editor save mid-render: the hash captured at parse
      // time no longer matches the bytes on disk now.
      sourceHashAtParse: "hash-of-older-bytes",
    });
    expect(entry.cacheable).toBe(false);
  });

  test("dep drift between pre-render snapshot and entry-build forces cacheable:false", () => {
    const inputDir = tmp();
    const outDir = tmp();
    fs.writeFileSync(
      path.join(inputDir, "a.agency"),
      `import { b } from "./b.agency"\nexport def a(): number { return b() }\n`,
    );
    fs.writeFileSync(path.join(inputDir, "b.agency"), `export def b(): number { return 2 }\n`);
    const ctx = buildDocFreshnessContext(inputDir, outDir);
    const preRender = captureDepSnapshot(path.join(inputDir, "a.agency"), {}, ctx.stdlibDir);
    // The dep is saved after the snapshot (i.e. mid-render): bytes drift.
    fs.writeFileSync(path.join(inputDir, "b.agency"), `export def b(): number { return 99 }\n`);
    evictParseCache(path.join(inputDir, "b.agency"));
    const entry = buildDocLedgerEntry({
      sourceRel: "a.agency",
      ctx,
      config: {},
      registrySymbols: ["a"],
      linkTargets: {},
      strayHiddenLines: [],
      writtenBytes: "x",
      preRender,
    });
    expect(entry.cacheable).toBe(false);
  });

  test("missing dep at BUILD time forces cacheable:false", () => {
    const inputDir = tmp();
    const outDir = tmp();
    fs.writeFileSync(
      path.join(inputDir, "a.agency"),
      `import { b } from "./gone.agency"\nexport def a(): number { return 1 }\n`,
    );
    const ctx = buildDocFreshnessContext(inputDir, outDir);
    const entry = buildDocLedgerEntry({
      sourceRel: "a.agency",
      ctx,
      config: {},
      registrySymbols: [],
      linkTargets: {},
      strayHiddenLines: [],
      writtenBytes: "x",
    });
    expect(entry.cacheable).toBe(false);
    expect(isDocEntryFresh("a.agency", entry, ctx)).toBe(false);
  });
});
