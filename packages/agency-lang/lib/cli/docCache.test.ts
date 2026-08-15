import { describe, expect, test, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { AgencyConfig } from "@/config.js";
import { generateDoc } from "./doc.js";
import {
  DOC_LEDGER_NAME,
  acquireDocLock,
  loadDocLedger,
  releaseDocLock,
  saveDocLedger,
} from "./docLedger.js";
import { evictParseCache } from "../parseCache.js";

const EPOCH = new Date(0);
const dirs: string[] = [];

function tmp(prefix = "agency-doccache-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return fs.realpathSync(d);
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function writeSource(inputDir: string, rel: string, content: string): void {
  const abs = path.join(inputDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  // The fingerprint reads through the process-global parse cache, whose
  // mtime+size key has a same-size-same-granule blind spot.
  evictParseCache(abs);
}

function rmSource(inputDir: string, rel: string): void {
  const abs = path.join(inputDir, rel);
  fs.rmSync(abs);
  evictParseCache(abs);
}

/** { relPath → bytes } of generated .md only; sidecars excluded. */
function mdSnapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.name.startsWith(".agency-doc")) continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".md"))
        out[path.relative(dir, abs)] = fs.readFileSync(abs, "utf-8");
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function backdateMd(dir: string): void {
  for (const rel of Object.keys(mdSnapshot(dir))) {
    fs.utimesSync(path.join(dir, rel), EPOCH, EPOCH);
  }
}

type MutationResult = {
  rewritten: string[];
  incremental: Record<string, string>;
  cold: Record<string, string>;
};

/**
 * The one way behavior tests run a mutation: backdate → ONE incremental
 * run (a second could repair a first-run defect) → capture rewritten set
 * and snapshot → identical request cold into a fresh directory → return
 * both snapshots for byte comparison.
 */
function runMutation(
  inputDir: string,
  ownedOut: string,
  opts: { config?: AgencyConfig; ignoreDirs?: string[]; baseUrl?: string } = {},
): MutationResult {
  backdateMd(ownedOut);
  generateDoc(opts.config ?? {}, inputDir, ownedOut, opts.ignoreDirs ?? [], opts.baseUrl);
  const rewritten = Object.keys(mdSnapshot(ownedOut))
    .filter((rel) => fs.statSync(path.join(ownedOut, rel)).mtimeMs > 0)
    .sort();
  const incremental = mdSnapshot(ownedOut);
  const cold = tmp("agency-doccache-cold-");
  generateDoc(opts.config ?? {}, inputDir, cold, opts.ignoreDirs ?? [], opts.baseUrl);
  return { rewritten, incremental, cold: mdSnapshot(cold) };
}

function assertMutation(r: MutationResult, expectedRewrites: string[]): void {
  expect(r.rewritten).toEqual(expectedRewrites.sort());
  expect(r.incremental).toEqual(r.cold);
}

/** a → x (whose function raises an effect); b is disconnected. */
function baseFixture(): { inputDir: string; out: string } {
  const inputDir = tmp("agency-doccache-in-");
  writeSource(
    inputDir,
    "x.agency",
    `effect docs::alpha { value: string }\neffect docs::beta { value: string }\n\n/** Dep function. */\nexport def x(): string {\n  raise docs::alpha("go", { value: "v" })\n  return "x"\n}\n`,
  );
  writeSource(
    inputDir,
    "a.agency",
    `import { x } from "./x.agency"\nexport type Payload = { p: number }\n\n/** Caller. */\nexport def a(): string { return x() }\n`,
  );
  writeSource(inputDir, "b.agency", `/** Disconnected. */\nexport def b(): number { return 2 }\n`);
  const out = tmp("agency-doccache-out-");
  generateDoc({}, inputDir, out, []);
  return { inputDir, out };
}

describe("freshness behavior (exact rewrite sets + cold parity)", () => {
  test("warm run rewrites nothing; semantic oracle holds cold and warm", () => {
    const { inputDir, out } = baseFixture();
    // Independent semantic oracle, not just parity: a.md carries the
    // imported effect, disconnected b.md does not.
    expect(mdSnapshot(out)["a.md"]).toContain("docs::alpha");
    expect(mdSnapshot(out)["b.md"]).not.toContain("docs::alpha");
    const r = runMutation(inputDir, out);
    assertMutation(r, []);
    expect(r.incremental["a.md"]).toContain("docs::alpha");
  });

  test("docstring edit rewrites exactly that page", () => {
    const { inputDir, out } = baseFixture();
    writeSource(
      inputDir,
      "b.agency",
      `/** Disconnected, edited. */\nexport def b(): number { return 2 }\n`,
    );
    assertMutation(runMutation(inputDir, out), ["b.md"]);
  });

  test("imported-effect mutation rewrites the caller and updates its Throws", () => {
    const { inputDir, out } = baseFixture();
    writeSource(
      inputDir,
      "x.agency",
      `effect docs::alpha { value: string }\neffect docs::beta { value: string }\n\n/** Dep function. */\nexport def x(): string {\n  raise docs::beta("go", { value: "v" })\n  return "x"\n}\n`,
    );
    const r = runMutation(inputDir, out);
    assertMutation(r, ["a.md", "x.md"]);
    expect(r.incremental["a.md"]).toContain("docs::beta");
    expect(r.incremental["a.md"]).not.toContain("`docs::alpha`");
  });

  test("type moved between files rewrites every page that linked it", () => {
    const inputDir = tmp("agency-doccache-in-");
    writeSource(inputDir, "types.agency", `export type Foo = { a: number }\n`);
    writeSource(
      inputDir,
      "user.agency",
      `import { Foo } from "./types.agency"\nexport def use(f: Foo): number { return 1 }\n`,
    );
    writeSource(inputDir, "loner.agency", `export def l(): number { return 3 }\n`);
    const out = tmp("agency-doccache-out-");
    generateDoc({}, inputDir, out, []);
    expect(mdSnapshot(out)["user.md"]).toContain("[Foo](types.md#foo)"); // exact target
    // Move Foo to a NEW file the user never imports; registry answer for
    // "Foo" flips → user.md must re-render even though its closure is
    // unchanged (the linkTargets re-check, staleness case 3).
    writeSource(inputDir, "types.agency", `export type Renamed = { a: number }\n`);
    writeSource(inputDir, "zz-newhome.agency", `export type Foo = { a: number }\n`);
    const r = runMutation(inputDir, out);
    expect(r.rewritten).toContain("user.md");
    expect(r.rewritten).not.toContain("loner.md");
    expect(r.incremental).toEqual(r.cold);
    expect(r.incremental["user.md"]).toContain("[Foo](zz-newhome.md#foo)");
  });

  test("duplicate name appearing in an unrelated later file rewrites linker pages", () => {
    const inputDir = tmp("agency-doccache-in-");
    writeSource(inputDir, "a-types.agency", `export type Foo = { a: number }\n`);
    writeSource(
      inputDir,
      "m-user.agency",
      `import { Foo } from "./a-types.agency"\nexport def use(f: Foo): number { return 1 }\n`,
    );
    const out = tmp("agency-doccache-out-");
    generateDoc({}, inputDir, out, []);
    // A LATER file (traversal order) defines the same name: registry's
    // last-writer-wins answer changes without touching user's closure.
    writeSource(inputDir, "z-dupe.agency", `export type Foo = { b: string }\n`);
    const r = runMutation(inputDir, out);
    expect(r.rewritten).toContain("m-user.md");
    expect(r.incremental).toEqual(r.cold);
  });

  test("--base-url change alone rewrites everything (render key)", () => {
    const { inputDir, out } = baseFixture();
    const all = Object.keys(mdSnapshot(out)).sort();
    assertMutation(runMutation(inputDir, out, { baseUrl: "https://elsewhere" }), all);
  });

  test("config change rewrites everything (render key)", () => {
    const { inputDir, out } = baseFixture();
    const all = Object.keys(mdSnapshot(out)).sort();
    assertMutation(runMutation(inputDir, out, { config: { verbose: true } as AgencyConfig }), all);
  });

  test("reordered-but-equivalent ignore list stays fully fresh", () => {
    const inputDir = tmp("agency-doccache-in-");
    writeSource(inputDir, "a.agency", `export def a(): number { return 1 }\n`);
    const out = tmp("agency-doccache-out-");
    generateDoc({}, inputDir, out, ["zz", "aa"]);
    assertMutation(runMutation(inputDir, out, { ignoreDirs: ["aa", "zz"] }), []);
  });

  test("splice-containing file renders every run, never skips", () => {
    const inputDir = tmp("agency-doccache-in-");
    writeSource(
      inputDir,
      "s.agency",
      `const x = $( gen() )\nexport def s(): number { return 1 }\n`,
    );
    const out = tmp("agency-doccache-out-");
    generateDoc({}, inputDir, out, []);
    const r = runMutation(inputDir, out);
    expect(r.rewritten).toEqual(["s.md"]);
    expect(r.incremental).toEqual(r.cold);
  });

  test("pkg:: (direct and transitive) renders every run", () => {
    const inputDir = tmp("agency-doccache-in-");
    writeSource(
      inputDir,
      "direct.agency",
      `import { x } from "pkg::toolbox"\nexport def d(): number { return 1 }\n`,
    );
    writeSource(
      inputDir,
      "via.agency",
      `import { d } from "./direct.agency"\nexport def v(): number { return d() }\n`,
    );
    writeSource(inputDir, "clean.agency", `export def c(): number { return 1 }\n`);
    const out = tmp("agency-doccache-out-");
    generateDoc({}, inputDir, out, []);
    const r = runMutation(inputDir, out);
    expect(r.rewritten).toEqual(["direct.md", "via.md"]);
    expect(r.incremental).toEqual(r.cold);
  });

  test("unresolvable import still renders and never skips", () => {
    const inputDir = tmp("agency-doccache-in-");
    writeSource(
      inputDir,
      "broken.agency",
      `import { gone } from "./gone.agency"\nexport def br(): number { return 1 }\n`,
    );
    const out = tmp("agency-doccache-out-");
    generateDoc({}, inputDir, out, []);
    expect(mdSnapshot(out)["broken.md"]).toBeDefined();
    const r = runMutation(inputDir, out);
    expect(r.rewritten).toEqual(["broken.md"]);
    expect(r.incremental).toEqual(r.cold);
  });

  test("deleted page is regenerated; hand-edited page is repaired", () => {
    const { inputDir, out } = baseFixture();
    fs.rmSync(path.join(out, "b.md"));
    fs.writeFileSync(path.join(out, "a.md"), "tampered by hand\n");
    const r = runMutation(inputDir, out);
    expect(r.rewritten).toEqual(["a.md", "b.md"]);
    expect(r.incremental).toEqual(r.cold);
  });

  test("registrySymbols fidelity: links identical whether the target page's contribution came from cache or parse", () => {
    const inputDir = tmp("agency-doccache-in-");
    writeSource(
      inputDir,
      "types.agency",
      `export type Foo = { a: number }\ndef _internal(): number { return 0 }\n`,
    );
    writeSource(
      inputDir,
      "user.agency",
      `import { Foo } from "./types.agency"\nexport def use(f: Foo): number { return 1 }\n`,
    );
    const out = tmp("agency-doccache-out-");
    generateDoc({}, inputDir, out, []);
    // Edit ONLY user: types' registry contribution now comes from cache.
    writeSource(
      inputDir,
      "user.agency",
      `import { Foo } from "./types.agency"\n/** edited */\nexport def use(f: Foo): number { return 1 }\n`,
    );
    const r = runMutation(inputDir, out);
    assertMutation(r, ["user.md"]);
    expect(r.incremental["user.md"]).toContain("[Foo](types.md#foo)");
  });

  test("per-page symbol tables preserved: disconnected closures render identically cold vs cached", () => {
    const { inputDir, out } = baseFixture();
    // Stale one page while the disconnected one stays cached; both must
    // equal a cold run byte-for-byte (catches accidental table sharing).
    writeSource(
      inputDir,
      "b.agency",
      `/** Disconnected v2. */\nexport def b(): number { return 2 }\n`,
    );
    const r = runMutation(inputDir, out);
    assertMutation(r, ["b.md"]);
    expect(r.incremental["a.md"]).toContain("docs::alpha");
    expect(r.incremental["b.md"]).not.toContain("docs::alpha");
  });

  test("symlinked input root: safe keys and full parity", () => {
    const { inputDir, out } = baseFixture();
    const aliasParent = tmp("agency-doccache-alias-");
    const alias = path.join(aliasParent, "aliased-input");
    fs.symlinkSync(inputDir, alias);
    generateDoc({}, alias, out, []);
    const { ledger, authority } = loadDocLedger(out);
    expect(authority).toBe(true);
    expect(Object.keys(ledger!.entries).sort()).toEqual(["a.agency", "b.agency", "x.agency"]);
    const cold = tmp("agency-doccache-cold-");
    generateDoc({}, alias, cold, []);
    expect(mdSnapshot(out)).toEqual(mdSnapshot(cold));
  });
});

describe("ownership, transitions, and deletion safety", () => {
  test("source deletion deletes its page; rename swaps pages", () => {
    const { inputDir, out } = baseFixture();
    rmSource(inputDir, "b.agency");
    generateDoc({}, inputDir, out, []);
    expect(fs.existsSync(path.join(out, "b.md"))).toBe(false);
    fs.renameSync(path.join(inputDir, "x.agency"), path.join(inputDir, "y.agency"));
    writeSource(
      inputDir,
      "a.agency",
      `import { x } from "./y.agency"\nexport def a(): string { return x() }\n`,
    );
    generateDoc({}, inputDir, out, []);
    expect(fs.existsSync(path.join(out, "x.md"))).toBe(false);
    expect(fs.existsSync(path.join(out, "y.md"))).toBe(true);
  });

  test("root → nested input over one output: obsolete pages removed, tree matches cold", () => {
    const inputDir = tmp("agency-doccache-in-");
    writeSource(inputDir, "top.agency", `export def t(): number { return 1 }\n`);
    writeSource(
      inputDir,
      path.join("sub", "inner.agency"),
      `export def i(): number { return 2 }\n`,
    );
    const out = tmp("agency-doccache-out-");
    generateDoc({}, inputDir, out, []);
    expect(fs.existsSync(path.join(out, "top.md"))).toBe(true);
    generateDoc({}, path.join(inputDir, "sub"), out, []); // identity transition
    expect(fs.existsSync(path.join(out, "top.md"))).toBe(false);
    expect(fs.existsSync(path.join(out, path.join("sub", "inner.md")))).toBe(false);
    expect(fs.existsSync(path.join(out, "inner.md"))).toBe(true);
    const cold = tmp("agency-doccache-cold-");
    generateDoc({}, path.join(inputDir, "sub"), cold, []);
    expect(mdSnapshot(out)).toEqual(mdSnapshot(cold));
  });

  test("no-ignore → ignore over one output: newly excluded owned pages removed", () => {
    const inputDir = tmp("agency-doccache-in-");
    writeSource(inputDir, "keep.agency", `export def k(): number { return 1 }\n`);
    writeSource(
      inputDir,
      path.join("skipme", "gone.agency"),
      `export def g(): number { return 2 }\n`,
    );
    const out = tmp("agency-doccache-out-");
    generateDoc({}, inputDir, out, []);
    expect(fs.existsSync(path.join(out, "skipme", "gone.md"))).toBe(true);
    generateDoc({}, inputDir, out, ["skipme"]);
    expect(fs.existsSync(path.join(out, "skipme", "gone.md"))).toBe(false);
    expect(fs.existsSync(path.join(out, "keep.md"))).toBe(true);
  });

  test("ownership survives invalidation: source deleted AND base URL changed in one run", () => {
    const { inputDir, out } = baseFixture();
    rmSource(inputDir, "b.agency");
    generateDoc({}, inputDir, out, [], "https://new-base"); // render key flips too
    expect(fs.existsSync(path.join(out, "b.md"))).toBe(false); // entry retained → reconciled
  });

  test("handmade files always survive; no-ledger runs delete nothing but own after", () => {
    const inputDir = tmp("agency-doccache-in-");
    writeSource(inputDir, "real.agency", `export def r(): number { return 1 }\n`);
    const out = tmp("agency-doccache-out-");
    fs.writeFileSync(path.join(out, "handmade.md"), "mine\n");
    fs.writeFileSync(path.join(out, "obsolete-looking.md"), "generated long ago\n");
    generateDoc({}, inputDir, out, []); // no ledger: conservative — deletes nothing
    expect(fs.readFileSync(path.join(out, "handmade.md"), "utf-8")).toBe("mine\n");
    expect(fs.existsSync(path.join(out, "obsolete-looking.md"))).toBe(true);
    // Second act: ownership now exists; deleting the source removes ITS page
    // while the strays still survive.
    rmSource(inputDir, "real.agency");
    writeSource(inputDir, "other.agency", `export def o(): number { return 2 }\n`);
    generateDoc({}, inputDir, out, []);
    expect(fs.existsSync(path.join(out, "real.md"))).toBe(false);
    expect(fs.readFileSync(path.join(out, "handmade.md"), "utf-8")).toBe("mine\n");
    expect(fs.existsSync(path.join(out, "obsolete-looking.md"))).toBe(true);
  });

  test("corrupted ledger: full re-render, zero deletions — with a REAL deletion candidate present", () => {
    const { inputDir, out } = baseFixture();
    rmSource(inputDir, "b.agency"); // b.md becomes an obsolete owned page
    const sentinel = path.join(out, "sentinel.md");
    fs.writeFileSync(sentinel, "handmade\n");
    const file = path.join(out, DOC_LEDGER_NAME);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    raw.version = 99;
    fs.writeFileSync(file, JSON.stringify(raw));
    backdateMd(out);
    generateDoc({}, inputDir, out, []);
    // full re-render of current pages…
    expect(fs.statSync(path.join(out, "a.md")).mtimeMs).toBeGreaterThan(0);
    // …but no deletion authority: the obsolete page AND the sentinel survive.
    expect(fs.existsSync(path.join(out, "b.md"))).toBe(true);
    expect(fs.readFileSync(sentinel, "utf-8")).toBe("handmade\n");
    // The corrupt run wrote a fresh ledger that never owned b.md, so the
    // orphan is PERMANENT under the conservative contract (documented
    // escape: delete the output directory). The next run must not
    // suddenly claim it.
    generateDoc({}, inputDir, out, []);
    expect(fs.existsSync(path.join(out, "b.md"))).toBe(true);
    expect(fs.readFileSync(sentinel, "utf-8")).toBe("handmade\n");
    // Ownership works again for pages the new ledger DOES record:
    rmSource(inputDir, "a.agency");
    generateDoc({}, inputDir, out, []);
    expect(fs.existsSync(path.join(out, "a.md"))).toBe(false);
  });

  test("hostile stored outputPath is never dereferenced; reconciliation still runs", () => {
    const { inputDir, out } = baseFixture();
    rmSource(inputDir, "b.agency");
    const victimDir = tmp("agency-doccache-victim-");
    fs.writeFileSync(path.join(victimDir, "victim.md"), "precious\n");
    const file = path.join(out, DOC_LEDGER_NAME);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    raw.entries["b.agency"].outputPath = path.join(victimDir, "victim.md"); // hostile
    fs.writeFileSync(file, JSON.stringify(raw));
    generateDoc({}, inputDir, out, []);
    // Both sides: the DERIVED path was deleted (reconciliation ran)…
    expect(fs.existsSync(path.join(out, "b.md"))).toBe(false);
    // …and the hostile stored path was never touched.
    expect(fs.readFileSync(path.join(victimDir, "victim.md"), "utf-8")).toBe("precious\n");
  });

  test("descendant symlink: reconciliation refuses to delete through out/sub -> victim", () => {
    const inputDir = tmp("agency-doccache-in-");
    writeSource(inputDir, path.join("sub", "a.agency"), `export def a(): number { return 1 }\n`);
    const out = tmp("agency-doccache-out-");
    generateDoc({}, inputDir, out, []);
    // Replace out/sub with a symlink to a victim tree holding a.md.
    const victimDir = tmp("agency-doccache-victim-");
    fs.writeFileSync(path.join(victimDir, "a.md"), "victim bytes\n");
    fs.rmSync(path.join(out, "sub"), { recursive: true, force: true });
    fs.symlinkSync(victimDir, path.join(out, "sub"));
    rmSource(inputDir, path.join("sub", "a.agency"));
    writeSource(inputDir, "other.agency", `export def o(): number { return 1 }\n`);
    generateDoc({}, inputDir, out, []);
    expect(fs.readFileSync(path.join(victimDir, "a.md"), "utf-8")).toBe("victim bytes\n");
  });

  test("single-file mode refuses to write through a leaf symlink (owned-output boundary)", () => {
    const { inputDir, out } = baseFixture();
    const victimDir = tmp("agency-doccache-victim-");
    fs.writeFileSync(path.join(victimDir, "victim.md"), "precious\n");
    const single = tmp("agency-doccache-single-");
    fs.symlinkSync(path.join(victimDir, "victim.md"), path.join(single, "a.md"));
    expect(() => generateDoc({}, path.join(inputDir, "a.agency"), single, [])).toThrow(/symlink/);
    expect(fs.readFileSync(path.join(victimDir, "victim.md"), "utf-8")).toBe("precious\n");
  });

  test("reconciliation skips (not crashes) when an owned path is now a directory", () => {
    const { inputDir, out } = baseFixture();
    rmSource(inputDir, "b.agency");
    fs.rmSync(path.join(out, "b.md"));
    fs.mkdirSync(path.join(out, "b.md")); // a directory now occupies the path
    generateDoc({}, inputDir, out, []); // must not throw
    expect(fs.statSync(path.join(out, "b.md")).isDirectory()).toBe(true); // untouched
  });

  test("descendant symlink: stale rendering refuses to write through out/sub -> victim", () => {
    const inputDir = tmp("agency-doccache-in-");
    writeSource(inputDir, path.join("sub", "a.agency"), `export def a(): number { return 1 }\n`);
    const out = tmp("agency-doccache-out-");
    const victimDir = tmp("agency-doccache-victim-");
    const victimSnapshot = mdSnapshot(victimDir);
    fs.symlinkSync(victimDir, path.join(out, "sub"));
    expect(() => generateDoc({}, inputDir, out, [])).toThrow(/symlink/);
    expect(mdSnapshot(victimDir)).toEqual(victimSnapshot); // untouched
  });
});

describe("locking", () => {
  test("directory run against a held lock throws and mutates nothing", () => {
    const { inputDir, out } = baseFixture();
    writeSource(inputDir, "b.agency", `export def b(): number { return 99 }\n`);
    backdateMd(out);
    const before = mdSnapshot(out);
    const ledgerBefore = fs.readFileSync(path.join(out, DOC_LEDGER_NAME), "utf-8");
    const lock = acquireDocLock(out);
    try {
      expect(() => generateDoc({}, inputDir, out, [])).toThrow(/held \(/);
    } finally {
      releaseDocLock(lock);
    }
    expect(mdSnapshot(out)).toEqual(before);
    for (const rel of Object.keys(before)) {
      expect(fs.statSync(path.join(out, rel)).mtimeMs).toBe(0); // nothing rewritten
    }
    expect(fs.readFileSync(path.join(out, DOC_LEDGER_NAME), "utf-8")).toBe(ledgerBefore);
  });

  test("single-file run against the same output is also refused (lock, not cache)", () => {
    const { inputDir, out } = baseFixture();
    const lock = acquireDocLock(out);
    try {
      expect(() => generateDoc({}, path.join(inputDir, "a.agency"), out, [])).toThrow(/held \(/);
    } finally {
      releaseDocLock(lock);
    }
  });

  test("a different output directory proceeds while the first is locked", () => {
    const { inputDir, out } = baseFixture();
    const other = tmp("agency-doccache-out2-");
    const lock = acquireDocLock(out);
    try {
      generateDoc({}, inputDir, other, []);
    } finally {
      releaseDocLock(lock);
    }
    expect(Object.keys(mdSnapshot(other)).length).toBeGreaterThan(0);
  });

  test("an exception after acquisition releases the lock (finally)", () => {
    const inputDir = tmp("agency-doccache-in-");
    writeSource(inputDir, path.join("sub", "a.agency"), `export def a(): number { return 1 }\n`);
    const out = tmp("agency-doccache-out-");
    const victimDir = tmp("agency-doccache-victim-");
    fs.symlinkSync(victimDir, path.join(out, "sub"));
    expect(() => generateDoc({}, inputDir, out, [])).toThrow(); // mid-run failure
    fs.unlinkSync(path.join(out, "sub")); // remove the dir symlink itself
    generateDoc({}, inputDir, out, []); // lock was released → this acquires
    expect(fs.existsSync(path.join(out, "sub", "a.md"))).toBe(true);
  });

  test("symlinked alias of the output dir contends on the same lock and ledger", () => {
    const { inputDir, out } = baseFixture();
    const aliasParent = tmp("agency-doccache-alias-");
    const alias = path.join(aliasParent, "out-alias");
    fs.symlinkSync(out, alias);
    const lock = acquireDocLock(out);
    try {
      expect(() => generateDoc({}, inputDir, alias, [])).toThrow(/held \(/);
    } finally {
      releaseDocLock(lock);
    }
    generateDoc({}, inputDir, alias, []); // and it shares the ledger:
    expect(loadDocLedger(out).authority).toBe(true);
  });

  test("two output dirs for the same input keep independent ledgers", () => {
    const { inputDir, out } = baseFixture();
    const out2 = tmp("agency-doccache-out2-");
    generateDoc({}, inputDir, out2, []);
    expect(loadDocLedger(out).authority).toBe(true);
    expect(loadDocLedger(out2).authority).toBe(true);
    expect(mdSnapshot(out)).toEqual(mdSnapshot(out2));
  });
});
