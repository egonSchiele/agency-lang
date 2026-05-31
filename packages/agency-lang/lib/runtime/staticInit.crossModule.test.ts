import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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
 */
describe("cross-module read-before-init throws friendly trap", () => {
  const tmpRoot = path.join(__dirname, "../../.agency-tmp/cross-module-trap");

  beforeAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "bar.agency"),
      'export static const barStatic = "hello"\n',
    );
    fs.writeFileSync(
      path.join(tmpRoot, "main.agency"),
      'import { barStatic } from "./bar.agency";\n' +
      'static const fooStatic = barStatic + "!"\n' +
      '\n' +
      'node main() {\n' +
      '  return fooStatic;\n' +
      '}\n',
    );

    const cli = path.join(__dirname, "../../dist/scripts/agency.js");
    const result = spawnSync(
      process.execPath,
      [cli, "compile", path.join(tmpRoot, "main.agency")],
      { encoding: "utf-8" },
    );
    if (result.status !== 0) {
      throw new Error(
        `compile failed: ${result.stdout}\n${result.stderr}`,
      );
    }
  });

  it("throws an error naming the variable", async () => {
    const mod = await import(path.join(tmpRoot, "main.js"));
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
