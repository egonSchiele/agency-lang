import { describe, test, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compileSandboxed, compileValidatedClosure } from "./compileSandboxed.js";
import { validateClosure } from "./closureValidator.js";
import { compileSource } from "./compile.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

// ESM live bindings can't be spied on after the fact, so wrap runGenerator
// at module-mock time: the wrapper counts calls and delegates to the real
// implementation, giving the splice tests their observable.
const generatorCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("./splice/runGenerator.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./splice/runGenerator.js")>();
  return {
    ...mod,
    runGenerator: (...args: Parameters<typeof mod.runGenerator>) => {
      generatorCalls.count++;
      return mod.runGenerator(...args);
    },
  };
});

function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(process.cwd(), prefix));
}

function cleanup(dir: string): void {
  expect(safeDeleteDirectoryWithin(process.cwd(), dir).success).toBe(true);
}

afterEach(() => {
  vi.restoreAllMocks();
});

const HELPER = "export def helperValue(): number { return 7 }\n";
const MAIN =
  'import { helperValue } from "./helper.agency"\nexport node main(): number { return helperValue() }\n';

/** A generator pair modeled on tests/agency/splices/builtWithFill*: the
 *  generator is pure (splice generators are effect-blocked), so the
 *  observable side effect of expansion is runGenerator executing at all. */
function writeSpliceFixture(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "gen.agency"),
    'import { Code, fill } from "std::agency"\n' +
      "export def makeNamed(): Code {\n" +
      "  const tpl = [|\n" +
      "    def #fnName(): string {\n" +
      "      return #greeting: string\n" +
      "    }\n" +
      "  |]\n" +
      '  const filled = fill(tpl, { fnName: "describe", greeting: "spliced" })\n' +
      "  if (isFailure(filled)) {\n" +
      "    return [| 0 |]\n" +
      "  }\n" +
      "  return filled.value\n" +
      "}\n",
  );
  // The splice sits in the ENTRY file: compileSource expands entry-file
  // splices at lib/compiler/compile.ts:142, which is the execution this
  // fixture exists to observe.
  fs.writeFileSync(
    path.join(dir, "main.agency"),
    'import { makeNamed } from "./gen.agency"\n\n$( makeNamed() )\n\nexport node main(): string {\n  return describe()\n}\n',
  );
}

describe("compileSandboxed", () => {
  test("two-file relative import compiles", () => {
    const dir = makeDir(".cs-rel-");
    try {
      fs.writeFileSync(path.join(dir, "helper.agency"), HELPER);
      fs.writeFileSync(path.join(dir, "main.agency"), MAIN);
      const result = compileSandboxed({ entry: { file: "main.agency" }, dir });
      expect(result.success).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("absolute-inside-dir import compiles from the mirror, never re-reading the caller file", () => {
    const dir = makeDir(".cs-abs-");
    try {
      fs.writeFileSync(path.join(dir, "helper.agency"), HELPER);
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        `import { helperValue } from "${path.join(dir, "helper.agency")}"\n` +
          "export node main(): number { return helperValue() }\n",
      );
      const closure = validateClosure({ entry: { file: "main.agency" }, dir });
      // The TOCTOU boundary: after validation the caller's file turns hostile.
      fs.writeFileSync(path.join(dir, "helper.agency"), "this is not agency source :::\n");
      const result = compileValidatedClosure(closure);
      expect(result.success).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("symlink-alias import compiles from saved bytes after alias and target are destroyed", () => {
    const dir = makeDir(".cs-alias-");
    try {
      fs.writeFileSync(path.join(dir, "real.agency"), HELPER);
      fs.symlinkSync(path.join(dir, "real.agency"), path.join(dir, "alias.agency"));
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { helperValue } from "./alias.agency"\nexport node main(): number { return helperValue() }\n',
      );
      const closure = validateClosure({ entry: { file: "main.agency" }, dir });
      fs.unlinkSync(path.join(dir, "alias.agency"));
      fs.writeFileSync(path.join(dir, "real.agency"), "garbage :::\n");
      const result = compileValidatedClosure(closure);
      expect(result.success).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("swap seam: a splice swapped in after validation never executes its generator", () => {
    const dir = makeDir(".cs-swap-");
    try {
      fs.writeFileSync(path.join(dir, "helper.agency"), HELPER);
      fs.writeFileSync(path.join(dir, "main.agency"), MAIN);
      const closure = validateClosure({ entry: { file: "main.agency" }, dir });
      // Swap BOTH validated files for content that would run a generator at
      // compile time if anything re-read them (the entry is where
      // compileSource expands splices, so swapping it is the sharp case).
      writeSpliceFixture(dir);
      fs.writeFileSync(
        path.join(dir, "helper.agency"),
        'import { makeNamed } from "./gen.agency"\n\n$( makeNamed() )\n\nexport def helperValue(): number { return 7 }\n',
      );
      const callsBefore = generatorCalls.count;
      const result = compileValidatedClosure(closure);
      expect(result.success).toBe(true);
      expect(generatorCalls.count).toBe(callsBefore);
    } finally {
      cleanup(dir);
    }
  });

  test("positive control: trusted compileSource runs the generator; sandboxed compile refuses without running it", () => {
    const trustedDir = makeDir(".cs-splice-pos-");
    const sandboxDir = makeDir(".cs-splice-neg-");
    try {
      // Positive control proves this fixture's generator actually executes
      // under the trusted pipeline — otherwise the zero-calls assertion
      // below could never fail.
      writeSpliceFixture(trustedDir);
      const controlBefore = generatorCalls.count;
      const trusted = compileSource(fs.readFileSync(path.join(trustedDir, "main.agency"), "utf-8"), {
        typechecker: { enabled: true },
        sourcePath: path.join(trustedDir, "main.agency"),
      });
      expect(trusted.success).toBe(true);
      expect(generatorCalls.count).toBeGreaterThan(controlBefore);

      // Fresh copy in a different dir: a different generator path is a
      // different splice-cache slot, so a cache hit cannot mask a call.
      writeSpliceFixture(sandboxDir);
      const callsBefore = generatorCalls.count;
      const result = compileSandboxed({ entry: { file: "main.agency" }, dir: sandboxDir });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.join("\n")).toMatch(/compile-time splice/);
      }
      expect(generatorCalls.count).toBe(callsBefore);
    } finally {
      cleanup(trustedDir);
      cleanup(sandboxDir);
    }
  });

  test("dir '' with a relative import fails from validation", () => {
    const result = compileSandboxed({
      entry: { source: 'import { x } from "./x.agency"\nexport node main(): number { return 1 }\n' },
      dir: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.join("\n")).toMatch(/no sandbox dir/i);
    }
  });

  test("rewrites only parser-owned path locations, not comments or strings", () => {
    const dir = makeDir(".cs-onlypath-");
    try {
      fs.writeFileSync(path.join(dir, "helper.agency"), HELPER);
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        `// mentions "${path.join(dir, "helper.agency")}" in a comment\n` +
          `import { helperValue } from "${path.join(dir, "helper.agency")}"\n` +
          `export node main(): string { return "${path.join(dir, "helper.agency")}" }\n`,
      );
      const result = compileSandboxed({ entry: { file: "main.agency" }, dir });
      expect(result.success).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("delimiter-aware rewrite: a target filename containing a double quote compiles via an alias import", () => {
    const dir = makeDir(".cs-quote-");
    try {
      fs.writeFileSync(path.join(dir, 're"al.agency'), HELPER);
      fs.symlinkSync(path.join(dir, 're"al.agency'), path.join(dir, "alias.agency"));
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { helperValue } from "./alias.agency"\nexport node main(): number { return helperValue() }\n',
      );
      const result = compileSandboxed({ entry: { file: "main.agency" }, dir });
      expect(result.success).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("missing imports, broken symlinks, and parse errors come back as diagnostics, not throws", () => {
    const dir = makeDir(".cs-diag-");
    try {
      fs.symlinkSync(path.join(dir, "nowhere.agency"), path.join(dir, "broken.agency"));
      fs.writeFileSync(path.join(dir, "bad.agency"), "def oops(:::\n");
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { a } from "./missing.agency"\nimport { b } from "./broken.agency"\nimport { c } from "./bad.agency"\nexport node main(): number { return 1 }\n',
      );
      const result = compileSandboxed({ entry: { file: "main.agency" }, dir });
      expect(result.success).toBe(false);
      if (!result.success) {
        const text = result.errors.join("\n");
        expect(text).toContain("./missing.agency");
        expect(text).toContain("./broken.agency");
        expect(text).toContain("bad.agency");
      }
    } finally {
      cleanup(dir);
    }
  });

  test("unexpected validation exceptions become CompileResult failures", () => {
    const result = compileSandboxed({
      entry: { file: "main.agency" },
      dir: path.join(process.cwd(), ".does-not-exist-anywhere"),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test("the mirror is removed on success and on compile failure", () => {
    const dir = makeDir(".cs-clean-");
    try {
      fs.writeFileSync(path.join(dir, "helper.agency"), HELPER);
      fs.writeFileSync(path.join(dir, "main.agency"), MAIN);
      // Node builtins cannot be spied on under ESM, so the observable is the
      // tmpdir itself: no agency-sandbox-* mirror survives either compile.
      const listMirrors = () =>
        fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("agency-sandbox-"));
      const before = listMirrors();

      const ok = compileSandboxed({ entry: { file: "main.agency" }, dir });
      expect(ok.success).toBe(true);

      // Type error inside the entry: compile fails after the mirror exists.
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { helperValue } from "./helper.agency"\nexport node main(): number {\n  const x: number = "not a number"\n  return helperValue()\n}\n',
      );
      const bad = compileSandboxed({ entry: { file: "main.agency" }, dir });
      expect(bad.success).toBe(false);

      const leaked = listMirrors().filter((name) => !before.includes(name));
      expect(leaked).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });
});
