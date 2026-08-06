import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Doc-faithful fake stdlib, isolated in its own file so the module-wide
// mock cannot leak into the other doc tests. Unlike the compiler harness,
// this mock mirrors the REAL carve-out — only index.agency/array.agency
// are non-templated — because doc's pass-1 rendering parse applies the
// template unconditionally; an all-non-templated policy would hide the
// prelude edge that rendering actually sees. State is hoisted (vi.mock
// factories run before imports) and reset every test.
const fake = vi.hoisted(() => ({ stdlibDir: "" }));
vi.mock("../importPaths.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../importPaths.js")>();
  return {
    ...real,
    getStdlibDir: () => (fake.stdlibDir !== "" ? fake.stdlibDir : real.getStdlibDir()),
    isNonTemplatedStdlib: (p: string) =>
      fake.stdlibDir !== ""
        ? p === path.join(fake.stdlibDir, "index.agency") ||
          p === path.join(fake.stdlibDir, "array.agency")
        : real.isNonTemplatedStdlib(p),
    resolveAgencyImportPath: (importPath: string, fromFile: string) =>
      fake.stdlibDir !== "" && real.isStdlibImport(importPath)
        ? path.join(fake.stdlibDir, real.normalizeStdlibPath(importPath) + ".agency")
        : real.resolveAgencyImportPath(importPath, fromFile),
  };
});

import { generateDoc } from "./doc.js";
import { loadDocLedger } from "./docLedger.js";
import { evictParseCache } from "../parseCache.js";
import { PRELUDE_NAMES } from "../prelude.js";

const EPOCH = new Date(0);
const dirs: string[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return fs.realpathSync(d);
}

beforeEach(() => {
  fake.stdlibDir = "";
});

afterEach(() => {
  fake.stdlibDir = "";
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const PRELUDE_STUBS = PRELUDE_NAMES.map(
  (n) => `export def ${n}(): number { return 0 }`,
).join("\n");

function write(rel: string, content: string): void {
  const abs = path.join(fake.stdlibDir, rel);
  fs.writeFileSync(abs, content);
  evictParseCache(abs);
}

/** index (non-templated, full prelude surface) ← helper (templated,
 *  raises an effect) ← user (templated, imports std::helper). */
function makeFixture(): { out: string } {
  fake.stdlibDir = tmp("agency-docstdlib-in-");
  write("index.agency", `export def i(): number { return 1 }\n${PRELUDE_STUBS}\n`);
  write(
    "helper.agency",
    `effect fake::alpha { value: string }\neffect fake::beta { value: string }\n\nexport def h(): string {\n  raise fake::alpha("go", { value: "v" })\n  return "h"\n}\n`,
  );
  write(
    "user.agency",
    `import { h } from "std::helper"\nexport def u(): string { return h() }\n`,
  );
  const out = tmp("agency-docstdlib-out-");
  generateDoc({}, fake.stdlibDir, out, []);
  return { out };
}

function mdSnapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(".agency-doc") || !f.endsWith(".md")) continue;
    out[f] = fs.readFileSync(path.join(dir, f), "utf-8");
  }
  return out;
}

function backdateAndRun(out: string): string[] {
  for (const rel of Object.keys(mdSnapshot(out))) {
    fs.utimesSync(path.join(out, rel), EPOCH, EPOCH);
  }
  generateDoc({}, fake.stdlibDir, out, []);
  return Object.keys(mdSnapshot(out))
    .filter((rel) => fs.statSync(path.join(out, rel)).mtimeMs > 0)
    .sort();
}

function assertColdParity(out: string): void {
  const cold = tmp("agency-docstdlib-cold-");
  generateDoc({}, fake.stdlibDir, cold, []);
  expect(mdSnapshot(out)).toEqual(mdSnapshot(cold));
}

describe("doc cache over a fake stdlib (std:: edges, real carve-out)", () => {
  test("ledger records std::-resolved deps incl. the template's prelude edge", () => {
    const { out } = makeFixture();
    const { ledger, authority } = loadDocLedger(out);
    expect(authority).toBe(true);
    const user = ledger!.entries["user.agency"];
    expect(user.deps).toContain(path.join(fake.stdlibDir, "helper.agency"));
    expect(user.deps).toContain(path.join(fake.stdlibDir, "index.agency")); // prelude
    const helper = ledger!.entries["helper.agency"];
    expect(helper.deps).toEqual([path.join(fake.stdlibDir, "index.agency")]); // prelude only
    // Semantic oracle: the imported effect reached the caller's page.
    expect(mdSnapshot(out)["user.md"]).toContain("fake::alpha");
  });

  test("std:: dep edit rewrites the importer's page with updated Throws, equal to cold", () => {
    const { out } = makeFixture();
    write(
      "helper.agency",
      `effect fake::alpha { value: string }\neffect fake::beta { value: string }\n\nexport def h(): string {\n  raise fake::beta("go", { value: "v" })\n  return "h"\n}\n`,
    );
    const rewritten = backdateAndRun(out);
    expect(rewritten).toEqual(["helper.md", "user.md"]); // index untouched
    expect(mdSnapshot(out)["user.md"]).toContain("fake::beta");
    expect(mdSnapshot(out)["user.md"]).not.toContain("`fake::alpha`");
    assertColdParity(out);
  });

  test("editing index.agency (the prelude) rewrites every templated page, equal to cold", () => {
    const { out } = makeFixture();
    write("index.agency", `export def i(): number { return 2 }\n${PRELUDE_STUBS}\n`);
    const rewritten = backdateAndRun(out);
    expect(rewritten).toEqual(["helper.md", "index.md", "user.md"]);
    assertColdParity(out);
  });

  test("warm run over the fake stdlib rewrites nothing", () => {
    const { out } = makeFixture();
    expect(backdateAndRun(out)).toEqual([]);
    assertColdParity(out);
  });
});
