import { describe, test, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  compileAgencyOnly,
  compileSandboxed,
  compileValidatedClosure,
} from "./compileSandboxed.js";
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

  test("a relative import compiles from the mirror, never re-reading the caller file", () => {
    const dir = makeDir(".cs-toctou-");
    try {
      fs.writeFileSync(path.join(dir, "helper.agency"), HELPER);
      fs.writeFileSync(path.join(dir, "main.agency"), MAIN);
      const closure = validateClosure({ entry: { file: "main.agency" }, dir });
      // The TOCTOU boundary: after validation the caller's file turns hostile.
      fs.writeFileSync(path.join(dir, "helper.agency"), "this is not agency source :::\n");
      const result = compileValidatedClosure(closure);
      expect(result.success).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("an absolute import inside dir is refused: it would bypass the mirror", () => {
    const dir = makeDir(".cs-abs-");
    try {
      fs.writeFileSync(path.join(dir, "helper.agency"), HELPER);
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        `import { helperValue } from "${path.join(dir, "helper.agency")}"\n` +
          "export node main(): number { return helperValue() }\n",
      );
      const result = compileSandboxed({ entry: { file: "main.agency" }, dir });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.join("\n")).toMatch(/absolute path/);
      }
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

  test("a nested entry keeps its place in the layout so its sibling import resolves", () => {
    const dir = makeDir(".cs-nested-");
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      fs.writeFileSync(path.join(dir, "sub", "helper.agency"), HELPER);
      fs.writeFileSync(path.join(dir, "sub", "main.agency"), MAIN);
      const result = compileSandboxed({ entry: { file: "sub/main.agency" }, dir });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.entryPath).toBe("sub/main.js");
        expect(Object.keys(result.modules ?? {})).toEqual(["sub/helper.js"]);
      }
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

describe("compileAgencyOnly", () => {
  test("writes the entry and each module in its closure beside the sources", () => {
    const dir = makeDir(".aoc-ok-");
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      fs.writeFileSync(path.join(dir, "sub", "helper.agency"), HELPER);
      fs.writeFileSync(path.join(dir, "sub", "main.agency"), MAIN);
      const result = compileAgencyOnly(path.join(dir, "sub", "main.agency"));
      expect(result).toEqual({ ok: true, scriptPath: path.join(dir, "sub", "main.js") });
      expect(fs.existsSync(path.join(dir, "sub", "helper.js"))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("a refusal comes back as errors and writes nothing", () => {
    const dir = makeDir(".aoc-fs-");
    try {
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import fs from "fs"\nexport node main(): number { return 1 }\n',
      );
      const result = compileAgencyOnly(path.join(dir, "main.agency"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join("\n")).toMatch(/not Agency source/);
      expect(fs.existsSync(path.join(dir, "main.js"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});

// --- Bound-names under --agency-only (SANDBOX_JS_GLOBALS). See
// docs/dev/security/roadmap.md A1. Each refused fixture names a capability;
// none performs a side effect, so a regression that lets one compile still
// cannot do harm when the test asserts only the compile result. ---
describe("bound names under --agency-only", () => {
  function compileOne(source: string) {
    // No local imports, so dir "" is fine; the closure is a single source.
    return compileSandboxed({ entry: { source }, dir: "" });
  }
  function refused(source: string): string[] {
    const r = compileOne(source);
    expect(r.success, `expected refusal for: ${source}`).toBe(false);
    return r.success ? [] : r.errors;
  }
  function allowed(source: string): void {
    const r = compileOne(source);
    expect(r.success, `expected to compile: ${source}\n${r.success ? "" : r.errors.join("\n")}`).toBe(true);
  }

  test("refuses host globals and code-from-strings", () => {
    refused('node main() { print(process.env.HOME) }');
    refused('node main() { let m = process.getBuiltinModule("fs") }');
    refused('node main() { eval("print(1)") }');
    refused('node main() { fetch("http://x") }');
    refused('node main() { print(globalThis) }');
  });

  test("refuses new-expression capability constructors", () => {
    refused('node main() { let f = new Function("return 1") }');
    refused('node main() { let p = new Proxy({}, {}) }');
    refused('node main() { let w = new WebSocket("ws://x") }');
    refused('node main() { let x = new XMLHttpRequest() }');
  });

  test("refuses the constructor / prototype walk (literal spellings)", () => {
    refused('def id(x) { return x }\nnode main() { let k = id("a")\n let f = k.constructor.constructor }');
    refused('def id(x) { return x }\nnode main() { let k = id("a")\n let f = k["constructor"] }');
  });

  test("refuses capability names in tag arguments and default values", () => {
    refused('type Foo = {\n  @jsonSchema({ x: process })\n  value: number,\n}\nnode main() { print("hi") }');
    refused('node main(xs = [process]) { print("hi") }');
  });

  test("allows pure values, methods, and safe constructors", () => {
    allowed('node main() {\n  let xs = [3, 1, 2]\n  print(Math.floor(2.5))\n  print(JSON.stringify(xs))\n  print(xs.length)\n}');
    allowed('node main() {\n  let s = new Set()\n  let m = new Map()\n  let d = new Date()\n  let r = new RegExp("a")\n  print("ok")\n}');
    allowed('node main() {\n  let o = { a: 1 }\n  print(Object.keys(o))\n  let ks = "abc"\n  print(o[ks])\n}');
    allowed('def isPositive(n: number): Result<number> {\n  if (n > 0) { return success(n) }\n  return failure("no")\n}\n@validate(isPositive)\ntype Pos = number\nnode main() { let x: Pos = 5 }');
    allowed('node main(xs = [1, 2]) { print(xs) }');
  });
});
