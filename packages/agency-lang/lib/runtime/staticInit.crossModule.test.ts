import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pathToFileURL } from "url";
import * as fs from "node:fs";
import * as path from "node:path";
import { compile, resetCompilationCache } from "../cli/commands.js";

/**
 * Cross-module read-before-init: compile a small two-file program where
 * foo.agency's static initializer reads `barStatic` imported from
 * bar.agency. Today (before PR 2's topological-sort fix) bar.agency's
 * `__initializeStatic` has not yet run when foo's body executes, so
 * `barStatic` holds the sentinel. The wrap installed by the codegen for
 * agency-imported reads in user expressions catches this and throws a
 * clear error naming the variable.
 *
 * This test is the canonical PR 1 trap verifier — same-module reads
 * cannot trigger the trap because source order naturally orders
 * statics within a module.
 *
 * Implementation notes:
 *   • We compile in-process (via `compile()` from `lib/cli/commands.ts`)
 *     rather than shelling out to a `dist/` binary, so the test always
 *     exercises the current source tree.
 *   • The compiled `.js` is written next to its `.agency` source so the
 *     generated `agency-lang/runtime` imports can resolve through the
 *     workspace's `node_modules`. The fixtures live under
 *     `.agency-tmp/static-cross-module-trap/` (gitignored as a
 *     dot-prefixed directory) and are cleaned up in `afterAll`.
 *   • We `import()` via `pathToFileURL(...).href` for Windows
 *     portability — bare filesystem paths fail on win32.
 */
describe("cross-module read-before-init throws friendly trap", () => {
  const fixturesRoot = path.resolve(
    __dirname,
    "../../.agency-tmp/static-cross-module-trap",
  );
  const mainAgency = path.join(fixturesRoot, "main.agency");
  const barAgency = path.join(fixturesRoot, "bar.agency");
  const mainJs = mainAgency.replace(/\.agency$/, ".js");

  beforeAll(() => {
    fs.mkdirSync(fixturesRoot, { recursive: true });
    fs.writeFileSync(
      barAgency,
      'export static const barStatic = "hello"\n',
    );
    fs.writeFileSync(
      mainAgency,
      'import { barStatic } from "./bar.agency";\n' +
        'static const fooStatic = barStatic + "!"\n' +
        '\n' +
        'node main() {\n' +
        '  return fooStatic;\n' +
        '}\n',
    );
    resetCompilationCache();
    compile({}, mainAgency);
  });

  afterAll(() => {
    fs.rmSync(fixturesRoot, { recursive: true, force: true });
  });

  it("throws an error naming the variable", async () => {
    const mod = await import(pathToFileURL(mainJs).href);
    let caught: any = null;
    try {
      await mod.main();
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught.message).toMatch(
      /Tried to read static `barStatic`.*before its initializer ran/i,
    );
  });
});
