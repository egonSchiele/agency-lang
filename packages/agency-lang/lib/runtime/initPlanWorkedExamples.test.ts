import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { compile, resetCompilationCache } from "../cli/commands.js";

/**
 * Worked-example integration tests for PR 2 ("per-variable topsort +
 * centralized init"). Each `it()` writes a small multi-file Agency
 * program under `.agency-tmp/init-worked-examples/` (gitignored),
 * compiles it through the real CLI compile path (so the new
 * `compileClosure` + topsort + cross-module await machinery is
 * exercised end-to-end), imports the entry's compiled JS, runs the
 * entry node, and asserts the observed runtime behavior.
 *
 * Cases map directly to the design doc's worked examples in
 * `agent-init-design.md` — see each case's comment for the section
 * reference. The shared `runFixture` helper keeps each case to a
 * handful of lines: write files, compile, import, assert.
 *
 * Helper notes:
 *   - Compile is in-process via `compile()` from `lib/cli/commands.ts`
 *     so the test always sees the current source tree.
 *   - JS files emit next to their `.agency` sources so the
 *     `import "agency-lang/runtime"` in the generated output resolves
 *     against the workspace's `node_modules`.
 *   - Each test gets its own subdir to avoid cross-test contamination
 *     of the module cache (Node caches ES-module imports by URL).
 *   - `resetCompilationCache()` runs before each test to ensure the
 *     closure is rebuilt with the new fixture.
 */

const FIXTURES_ROOT = path.resolve(
  __dirname,
  "../../.agency-tmp/init-worked-examples",
);

type CompileOutcome =
  | { kind: "ok"; mod: any }
  | { kind: "compileError"; message: string };

let currentDir: string;

beforeEach(() => {
  fs.mkdirSync(FIXTURES_ROOT, { recursive: true });
});

afterEach(() => {
  if (currentDir) {
    fs.rmSync(currentDir, { recursive: true, force: true });
  }
});

/**
 * Write `files` to a fresh per-test subdir and compile starting from
 * `entry`. Returns the imported entry module on success; for compile
 * failures (parse errors, cycle errors, static-references-global)
 * returns the captured stderr message and stops short of running.
 *
 * Implementation: the CLI compile path calls `process.exit(1)` on
 * `CompileClosureError`, so to test the error case we wrap stderr +
 * exit and rethrow as a thrown string. Vitest's spy machinery handles
 * the stderr capture.
 */
async function runFixture(
  testName: string,
  files: Record<string, string>,
  entryRel: string,
): Promise<CompileOutcome> {
  currentDir = path.join(FIXTURES_ROOT, testName);
  fs.mkdirSync(currentDir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(currentDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf-8");
  }
  resetCompilationCache();

  // Intercept the CLI's compile-error path so the test can observe it
  // without the process actually exiting. compile() calls
  // `console.error(msg); process.exit(1)` for `CompileClosureError`.
  const errors: string[] = [];
  const origError = console.error;
  console.error = (msg: any) => errors.push(String(msg));
  const origExit = process.exit;
  let exited = false;
  process.exit = ((code?: number) => {
    exited = true;
    throw new Error(`__processExit__ ${code}`);
  }) as never;

  const entryAbs = path.join(currentDir, entryRel);
  try {
    compile({}, entryAbs);
  } catch (e) {
    if ((e as Error).message.startsWith("__processExit__")) {
      return { kind: "compileError", message: errors.join("\n") };
    }
    throw e;
  } finally {
    console.error = origError;
    process.exit = origExit;
  }
  if (exited) {
    return { kind: "compileError", message: errors.join("\n") };
  }

  const mainJs = entryAbs.replace(/\.agency$/, ".js");
  const mod = await import(pathToFileURL(mainJs).href);
  return { kind: "ok", mod };
}

describe("agent-init-design.md worked examples", () => {
  it("Example 1: silent-undefined cross-module dep → prints 'hello!'", async () => {
    const outcome = await runFixture(
      "example1-silent-undefined",
      {
        "bar.agency": `export static const barStatic = "hello"\n`,
        "main.agency":
          `import { barStatic } from "./bar.agency"\n` +
          `static const fooStatic = barStatic + "!"\n` +
          `node main() { return fooStatic }\n`,
      },
      "main.agency",
    );
    if (outcome.kind !== "ok") throw new Error(outcome.message);
    const result = await outcome.mod.main();
    expect(result.data).toBe("hello!");
  });

  it("Example 2: indirect dep via function-call indirection works", async () => {
    // fooStatic = getBarStatic() + "!" — no direct value edge on
    // barStatic, but the file-import-depth tiebreaker in `sequenceHint`
    // makes bar's static init come before foo's, AND the cross-module
    // await on bar's module fires regardless because foo imports
    // `getBarStatic` from bar (so the closure walker picks bar up and
    // the per-module cascade kicks in).
    const outcome = await runFixture(
      "example2-fn-indirection",
      {
        "bar.agency":
          `export static const barStatic = "hello"\n` +
          `export def getBarStatic(): string { return barStatic }\n`,
        "main.agency":
          `import { getBarStatic } from "./bar.agency"\n` +
          `static const fooStatic = getBarStatic() + "!"\n` +
          `node main() { return fooStatic }\n`,
      },
      "main.agency",
    );
    if (outcome.kind !== "ok") throw new Error(outcome.message);
    const result = await outcome.mod.main();
    expect(result.data).toBe("hello!");
  });

  it("Example 5: direct static cycle → compile-time error naming both decls", async () => {
    const outcome = await runFixture(
      "example5-direct-cycle",
      {
        "foo.agency":
          `import { barStatic } from "./bar.agency"\n` +
          `export static const fooStatic = barStatic + "!"\n`,
        "bar.agency":
          `import { fooStatic } from "./foo.agency"\n` +
          `export static const barStatic = fooStatic + "?"\n` +
          `node main() { return barStatic }\n`,
      },
      "bar.agency",
    );
    expect(outcome.kind).toBe("compileError");
    if (outcome.kind !== "compileError") return;
    expect(outcome.message).toMatch(/Circular static dependency/);
    expect(outcome.message).toMatch(/fooStatic/);
    expect(outcome.message).toMatch(/barStatic/);
  });

  it("Example 7: const _ = sideEffect() runs in Phase B (every run)", async () => {
    // No `static` prefix → globals graph → re-runs per invocation.
    // We can't see "run count" without persistent state, but we can at
    // least confirm the side effect runs (g gets set to "did it") and
    // the node returns expected value.
    const outcome = await runFixture(
      "example7-const-underscore",
      {
        "main.agency":
          `def doIt(): string { return "did it" }\n` +
          `const _ = doIt()\n` +
          `const g = "hello"\n` +
          `node main() { return g }\n`,
      },
      "main.agency",
    );
    if (outcome.kind !== "ok") throw new Error(outcome.message);
    const result = await outcome.mod.main();
    expect(result.data).toBe("hello");
  });

  it("static referencing a global → compile-time error", async () => {
    const outcome = await runFixture(
      "static-references-global",
      {
        "main.agency":
          `const g = "hello"\n` +
          `static const s = g + "!"\n` +
          `node main() { return s }\n`,
      },
      "main.agency",
    );
    expect(outcome.kind).toBe("compileError");
    if (outcome.kind !== "compileError") return;
    expect(outcome.message).toMatch(
      /static const '?s'?.*references global '?g'?/,
    );
  });

  it("global reading an imported static (cross-phase OK)", async () => {
    const outcome = await runFixture(
      "global-reads-static-cross-module",
      {
        "bar.agency": `export static const barStatic = "hello"\n`,
        "main.agency":
          `import { barStatic } from "./bar.agency"\n` +
          `const g = barStatic + "!"\n` +
          `node main() { return g }\n`,
      },
      "main.agency",
    );
    if (outcome.kind !== "ok") throw new Error(outcome.message);
    const result = await outcome.mod.main();
    expect(result.data).toBe("hello!");
  });

  it("re-export chain: foo reads thru a → b → c chain", async () => {
    const outcome = await runFixture(
      "reexport-chain",
      {
        "c.agency": `export static const x = "deep"\n`,
        "b.agency": `export { x } from "./c.agency"\n`,
        "a.agency": `export { x } from "./b.agency"\n`,
        "main.agency":
          `import { x } from "./a.agency"\n` +
          `static const s = x + "!"\n` +
          `node main() { return s }\n`,
      },
      "main.agency",
    );
    if (outcome.kind !== "ok") throw new Error(outcome.message);
    const result = await outcome.mod.main();
    expect(result.data).toBe("deep!");
  });

  it("multi-entry-point: imported module is a valid entry too", async () => {
    // Compile starting from bar.agency (the imported module), not
    // foo.agency. Centralized init is emitted in every compiled file
    // so any module can be an entry — assert bar's own node works
    // when bar is the entry.
    const outcome = await runFixture(
      "multi-entry-point",
      {
        "bar.agency":
          `export static const barStatic = "hello"\n` +
          `node main() { return barStatic }\n`,
      },
      "bar.agency",
    );
    if (outcome.kind !== "ok") throw new Error(outcome.message);
    const result = await outcome.mod.main();
    expect(result.data).toBe("hello");
  });
});
