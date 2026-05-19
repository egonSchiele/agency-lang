import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";

// Verifies that doc string interpolation referencing a module global is
// correctly resolved at runtime — the compiled JS module loads without
// errors and the resulting tool description contains the interpolated
// global value (not `undefined` or a ReferenceError trace).
describe("doc string interpolation — runtime resolution", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const agencyFile = path.join(
    repoRoot,
    "tests/agency/docstring-interpolation.agency",
  );

  it("compiles to a module whose generated tool description references __ctx.globals.get", () => {
    execSync(`node ./dist/scripts/agency.js compile ${agencyFile}`, {
      cwd: repoRoot,
      stdio: "pipe",
    });
    const jsFile = agencyFile.replace(/\.agency$/, ".js");
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
    // time using the now-initialized `__ctx.globals`.
    const jsFile = agencyFile.replace(/\.agency$/, ".js");
    const mod = await import(jsFile);
    // The compiled module exports a default graph. The tool registry is
    // populated as a side effect of module load. Read versionedGreet's
    // description from the toolRegistry.
    const toolRegistry = mod.__toolRegistry;
    expect(toolRegistry).toBeDefined();
    const tool = toolRegistry["versionedGreet"];
    expect(tool).toBeDefined();
    expect(tool.toolDefinition.description).toBe(
      "Greets someone. Tool version: 2.0.",
    );
  });
});
