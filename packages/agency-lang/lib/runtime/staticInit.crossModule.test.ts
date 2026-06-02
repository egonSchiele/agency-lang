import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pathToFileURL } from "url";
import * as fs from "node:fs";
import * as path from "node:path";
import { compile, resetCompilationCache } from "../cli/commands.js";

/**
 * Cross-module static dependency end-to-end: compile a small two-file
 * program where foo.agency's static initializer reads `barStatic`
 * imported from bar.agency.
 *
 *   - Before PR 2: bar.agency's `__initializeStatic` had not yet run
 *     when foo's body executed, so `barStatic` held the read-before-init
 *     sentinel and the PR-1 trap fired. The test was a canonical PR-1
 *     verifier.
 *   - After PR 2: `compileClosure` topsort + cross-module await prelude
 *     make foo's init wait for bar's. `main()` now returns `"hello!"`.
 *     The PR-1 trap remains as the safety net for indirect references
 *     through function calls (Example 3 in `agent-init-design.md`),
 *     but it should NOT fire for the direct dep this test exercises.
 *
 * Implementation notes:
 *   • Compile in-process via `compile()` from `lib/cli/commands.ts` so
 *     the test always exercises the current source tree.
 *   • The compiled `.js` is written next to its `.agency` source so
 *     generated `agency-lang/runtime` imports can resolve through the
 *     workspace's `node_modules`. Fixtures live under
 *     `.agency-tmp/static-cross-module-trap/` (gitignored).
 *   • `import()` via `pathToFileURL(...).href` for Windows portability.
 */
describe("cross-module static dep resolves correctly via PR-2 topsort", () => {
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

  it("initializes bar.barStatic before foo.fooStatic and returns 'hello!'", async () => {
    const mod = await import(pathToFileURL(mainJs).href);
    const result = await mod.main();
    expect(result.data).toBe("hello!");
  });
});
