// PROTOTYPE (throwaway) — multi-file compile API options for hosted serve.
//
// Question: what should the agency-lang compile API look like so a host
// (statelog) can compile a multi-file agent — entrypoint + sibling `.agency`
// imports — with relative imports resolving? Today `compileSource` writes to a
// temp dir and loses the file's location, so `./helper.agency` never resolves
// (statelog#9).
//
// Verified root cause: the whole compileSource pipeline keys off one
// `syntheticPath`. If it is REAL (siblings on disk beside it), imports resolve.
// So every option reduces to "compile at a real path"; they differ only in API
// ergonomics. This file runs all three on a 2-file agent, prints a comparison,
// and asserts each resolves the import (and that today's behaviour does not).
//
// Run:  pnpm exec vitest run lib/compiler/multifileOptions.proto.test.ts

import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { compileSource } from "./compile.js";

const HELPERS = `export def helper(x: string): string {\n  """h"""\n  return x\n}\n`;
const MAIN = `import { helper } from "./helpers.agency"\n\nexport node main(x: string) {\n  return helper(x)\n}\n`;

type Compiled = { success: true; code: string } | { success: false; errors: string[] };

/** A 2-file agent on disk (entrypoint + the sibling it imports). */
function writeAgent(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-proto-"));
  fs.writeFileSync(path.join(dir, "helpers.agency"), HELPERS);
  const mainPath = path.join(dir, "main.agency");
  fs.writeFileSync(mainPath, MAIN);
  return mainPath;
}

const resolvesImport = (r: Compiled): boolean =>
  r.success && r.code.includes('from "./helpers.js"');

// ── Option A — compileSource gains a `sourcePath` option (the primitive) ─────
// Host writes files to disk (it already does), then compiles each at its path.
const optionA = (mainPath: string): Compiled =>
  compileSource(fs.readFileSync(mainPath, "utf-8"), { sourcePath: mainPath }) as Compiled;

// ── Option B — new `compileFile(path, config)` (sugar over A) ────────────────
// Reads the file itself; ergonomic for serve, which already has stored paths.
const compileFile = (filePath: string): Compiled =>
  compileSource(fs.readFileSync(filePath, "utf-8"), { sourcePath: filePath }) as Compiled;

// ── Option C — new `compileBundle({ files, entrypoint })` (set-based) ────────
// Host hands over the in-memory upload set; the compiler owns the temp dir and
// resolution, returning one result per file. Host never manages paths itself.
function compileBundle(
  files: { name: string; contents: string }[],
): { name: string; result: Compiled }[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-bundle-"));
  for (const file of files) {
    fs.writeFileSync(path.join(dir, file.name), file.contents);
  }
  return files.map((file) => ({
    name: file.name,
    result: compileSource(file.contents, { sourcePath: path.join(dir, file.name) }) as Compiled,
  }));
}

describe("multi-file compile — API options (PROTOTYPE)", () => {
  it("compares the options and asserts imports resolve", () => {
    const mainPath = writeAgent();
    const bundle = [
      { name: "helpers.agency", contents: HELPERS },
      { name: "main.agency", contents: MAIN },
    ];

    const a = optionA(mainPath);
    const b = compileFile(mainPath);
    const c = compileBundle(bundle);
    const baseline = compileSource(MAIN, {}) as Compiled;

    // eslint-disable-next-line no-console
    console.log(`
Multi-file compile — API options
  agent: main.agency imports { helper } from ./helpers.agency

  A  compileSource(src, { sourcePath })            ${resolvesImport(a) ? "✓ import resolved" : "✗"}
       host writes files to disk, compiles each at its path (minimal change)

  B  compileFile(path, config)                     ${resolvesImport(b) ? "✓ import resolved" : "✗"}
       sugar over A; reads the file — fits serve, which has stored paths

  C  compileBundle({ files, entrypoint }, config)  ${c.every((f) => f.result.success) ? "✓ all compiled" : "✗"}
       compiler owns the temp dir; host just hands over the upload set

  baseline  compileSource(src, {}) today           ${baseline.success ? "compiled" : "✗ " + (baseline as { errors: string[] }).errors.join("; ")}
       (the statelog#9 bug — no location, import can't resolve)
`);

    expect(resolvesImport(a)).toBe(true);
    expect(resolvesImport(b)).toBe(true);
    expect(c.every((f) => f.result.success)).toBe(true);
    // Today's behaviour: the entrypoint fails because the sibling can't resolve.
    expect(baseline.success).toBe(false);
  });
});
