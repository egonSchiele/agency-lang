import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { pathToFileURL } from "url";

// Verifies that doc string interpolation referencing a module global is
// correctly resolved at runtime — the compiled JS module loads without
// errors and the resulting tool description contains the interpolated
// global value (not `undefined` or a ReferenceError trace).
//
// The compiled module imports from the workspace's `agency-lang` stdlib
// via a package import, so we must compile next to the source `.agency`
// file (where node_modules is reachable). All `.js` files in the repo
// are gitignored, but we still clean up the artifact to keep the
// working tree tidy.
describe("doc string interpolation — runtime resolution", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const agencyFile = path.join(
    repoRoot,
    "tests/agency/docstring-interpolation.agency",
  );
  const jsFile = agencyFile.replace(/\.agency$/, ".js");

  beforeAll(() => {
    execSync(`node ./dist/scripts/agency.js compile ${agencyFile}`, {
      cwd: repoRoot,
      stdio: "pipe",
    });
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
