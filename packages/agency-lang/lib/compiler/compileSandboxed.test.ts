import { describe, test, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compileSandboxed, compileValidatedClosure } from "./compileSandboxed.js";
import { validateClosure } from "./closureValidator.js";
import { compileSource } from "./compile.js";
import { materializeCompiledScript } from "../runtime/ipc.js";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { createRequire } from "module";

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
      const trusted = compileSource(
        fs.readFileSync(path.join(trustedDir, "main.agency"), "utf-8"),
        {
          typechecker: { enabled: true },
          sourcePath: path.join(trustedDir, "main.agency"),
        },
      );
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

  test("pkg:: imports compile from the mirror and their bare specifiers resolve at runtime", () => {
    const dir = makeDir(".cs-pkg-");
    try {
      // Same package shape as closureValidator.test.ts, plus compiled JS so
      // the emitted bare specifier is resolvable the way runtime Node
      // resolution would do it.
      const writePkg = (name: string, dirName: string) => {
        const pkgDir = path.join(dir, "node_modules", ...dirName.split("/"));
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(
          path.join(pkgDir, "package.json"),
          JSON.stringify({ name, version: "1.0.0", agency: "./index.agency", main: "./index.js" }),
        );
        fs.writeFileSync(path.join(pkgDir, "index.agency"), HELPER);
        fs.writeFileSync(path.join(pkgDir, "index.js"), "export const helperValue = () => 7;\n");
        return pkgDir;
      };
      const pkgDir = writePkg("testpkg", "testpkg");
      const scopedDir = writePkg("@scope/tools", "@scope/tools");
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { helperValue } from "pkg::testpkg"\n' +
          'import { helperValue as scoped } from "pkg::@scope/tools"\n' +
          "export node main(): number { return helperValue() + scoped() }\n",
      );
      const result = compileSandboxed({ entry: { file: "main.agency" }, dir });
      expect(result.success).toBe(true);
      if (!result.success) return;
      // The generated JS names the packages by bare specifier.
      expect(result.code).toContain('"testpkg"');
      expect(result.code).toContain('"@scope/tools"');
      expect(result.pkgAnchors).toEqual([
        { packageName: "testpkg", packageRoot: fs.realpathSync(pkgDir) },
        { packageName: "@scope/tools", packageRoot: fs.realpathSync(scopedDir) },
      ]);

      // Runtime leg: the materialized script dir gets node_modules links, so
      // Node resolution from the script finds each package's compiled JS.
      const scriptPath = materializeCompiledScript({
        moduleId: result.moduleId,
        code: result.code,
        pkgAnchors: result.pkgAnchors,
      });
      try {
        const req = createRequire(scriptPath);
        expect(fs.realpathSync(req.resolve("testpkg"))).toBe(
          fs.realpathSync(path.join(pkgDir, "index.js")),
        );
        expect(fs.realpathSync(req.resolve("@scope/tools"))).toBe(
          fs.realpathSync(path.join(scopedDir, "index.js")),
        );
      } finally {
        safeDeleteDirectoryWithin(
          path.join(process.cwd(), ".agency-tmp"),
          path.dirname(scriptPath),
        );
      }
    } finally {
      cleanup(dir);
    }
  });

  test("a nested package.json inside a package does not shadow the named root", () => {
    const dir = makeDir(".cs-pkg-nested-");
    try {
      // pkg::foo/sub/tool resolves to <foo>/sub/tool.agency, and <foo>/sub
      // carries its own package.json (a module-type boundary). The anchor
      // must still be <foo> — the nearest-package.json rule would link
      // node_modules/foo -> <foo>/sub and the subpath would resolve
      // twice-nested.
      const fooDir = path.join(dir, "node_modules", "foo");
      fs.mkdirSync(path.join(fooDir, "sub"), { recursive: true });
      fs.writeFileSync(
        path.join(fooDir, "package.json"),
        JSON.stringify({ name: "foo", version: "1.0.0", agency: "./index.agency" }),
      );
      fs.writeFileSync(
        path.join(fooDir, "sub", "package.json"),
        JSON.stringify({ type: "module" }),
      );
      fs.writeFileSync(
        path.join(fooDir, "sub", "tool.agency"),
        "export def value(): number { return 7 }\n",
      );
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { value } from "pkg::foo/sub/tool"\nexport node main(): number { return value() }\n',
      );
      const result = compileSandboxed({ entry: { file: "main.agency" }, dir });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.pkgAnchors).toEqual([
        { packageName: "foo", packageRoot: fs.realpathSync(fooDir) },
      ]);
    } finally {
      cleanup(dir);
    }
  });

  test("dir '' with a relative import fails from validation", () => {
    const result = compileSandboxed({
      entry: {
        source: 'import { x } from "./x.agency"\nexport node main(): number { return 1 }\n',
      },
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
