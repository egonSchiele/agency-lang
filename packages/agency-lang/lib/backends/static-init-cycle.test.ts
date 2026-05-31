import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import fs from "fs";
import { pathToFileURL } from "url";
import { compile } from "@/cli/commands.js";

// Verifies the runtime cycle-detection path from #232's design:
// a `static const` whose value depends on another `static const`
// that depends back on it triggers `__initVar`'s `running` flag at
// re-entry and throws a "Init cycle on …" error naming the var.
describe("static init cycle — runtime detection", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const agencyFile = path.join(
    repoRoot,
    "tests/agency/static-init-cycle/cycle-same-module.agency",
  );
  const jsFile = agencyFile.replace(/\.agency$/, ".js");

  beforeAll(() => {
    compile({}, agencyFile);
  });

  afterAll(() => {
    fs.rmSync(jsFile, { force: true });
  });

  it("throws an 'Init cycle on …' error naming one of the participating vars", async () => {
    const mod = await import(pathToFileURL(jsFile).href);
    let caught: Error | null = null;
    try {
      await mod.main();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    // The cycle is `a → b → a`, so whichever getter the orchestrator
    // fires first names that var in the thrown error. Either `:a` or
    // `:b` is acceptable.
    expect(caught!.message).toMatch(
      /Init cycle on tests\/agency\/static-init-cycle\/cycle-same-module\.agency:(a|b)\b/,
    );
    // Confirm the JS stack trace contains both cyclic compute frames.
    // The codegen emits `async function __init_<X>_compute(__ctx) {…}`
    // (a named function declaration, not an anonymous arrow) so V8's
    // stack-frame inference picks up both names — backing the
    // `__initVar` error message's promise that "every frame named
    // `__init_*` is a participating variable."
    expect(caught!.stack).toMatch(/__init_a_compute\b/);
    expect(caught!.stack).toMatch(/__init_b_compute\b/);
  });
});
