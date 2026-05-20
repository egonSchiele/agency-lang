import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import fs from "fs";
import { pathToFileURL } from "url";
import { compile } from "../cli/commands.js";

// Verifies that doc string interpolation referencing a module global is
// correctly resolved at runtime — the compiled JS module loads without
// errors and the resulting tool description contains the interpolated
// global value (not `undefined` or a ReferenceError trace).
//
// We invoke the in-process `compile()` from `lib/cli/commands.ts`
// rather than shelling out to `./dist/scripts/agency.js`, so the test
// always exercises the current source rather than a stale build.
// The compiled `.js` is written next to the `.agency` fixture because
// the generated module imports from `agency-lang/...` and so must sit
// inside the workspace's `node_modules` reach. All `.js` files in the
// repo are gitignored, but we still clean up the artifact in afterAll.
describe("doc string interpolation — runtime resolution", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const agencyFile = path.join(
    repoRoot,
    "tests/agency/docstring-interpolation.agency",
  );
  const jsFile = agencyFile.replace(/\.agency$/, ".js");

  beforeAll(() => {
    compile({}, agencyFile);
  });

  afterAll(() => {
    fs.rmSync(jsFile, { force: true });
  });

  it("compiles to a module whose generated tool description references __ctx.globals.get", () => {
    const compiled = fs.readFileSync(jsFile, "utf-8");

    // Description in the tool definition uses the template literal with
    // the global interpolation expression.
    expect(compiled).toMatch(
      /description: `Greets someone\. Tool version: \$\{__ctx\.globals\.get\([^)]*"toolVersion"\)\}\.`/,
    );

    // Top-level alias and eager init are emitted so the description
    // evaluates correctly at module-load time.
    expect(compiled).toContain("const __ctx = __globalCtx;");
    expect(compiled).toContain("__initializeGlobals(__globalCtx);");
  });

  it("evaluates the tool description to the interpolated global value at runtime", async () => {
    // Importing the compiled module triggers eager init of globals. The
    // tool description is a template literal evaluated at module load
    // time using the now-initialized `__ctx.globals`. We pass through
    // pathToFileURL so this works on Windows as well.
    const mod = await import(pathToFileURL(jsFile).href);
    const toolRegistry = mod.__toolRegistry;
    expect(toolRegistry).toBeDefined();
    const tool = toolRegistry["versionedGreet"];
    expect(tool).toBeDefined();
    expect(tool.toolDefinition.description).toBe(
      "Greets someone. Tool version: 2.0.",
    );
  });
});
