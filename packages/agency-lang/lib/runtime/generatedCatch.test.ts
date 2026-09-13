import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pathToFileURL } from "url";
import * as fs from "node:fs";
import * as path from "node:path";
import { compile, resetCompilationCache } from "@/compiler/defaultSession.js";
import { safeDeleteDirectoryWithin } from "@/utils.js";

/**
 * Every generated function and node body wraps its steps in a catch that
 * turns a thrown error into a Failure. A run-control signal (restore, pause)
 * must pass through that catch untouched, or a pause inside a `def` would
 * come back as a failed result instead of unwinding the run.
 *
 * The compiled program loads the runtime from `agency-lang/runtime`, a
 * different module instance from the one this test imports, so the
 * assertions compare the error name rather than the class.
 */
describe("generated catch blocks re-throw a PauseSignal", () => {
  const fixturesRoot = path.resolve(__dirname, "../../.agency-tmp/generated-catch");
  const mainAgency = path.join(fixturesRoot, "main.agency");
  const mainJs = mainAgency.replace(/\.agency$/, ".js");

  beforeAll(() => {
    fs.mkdirSync(fixturesRoot, { recursive: true });
    fs.writeFileSync(
      path.join(fixturesRoot, "thrower.js"),
      'import { PauseSignal, Checkpoint, StateStack, GlobalStore } from "agency-lang/runtime";\n' +
        "export function throwPause() {\n" +
        "  const checkpoint = new Checkpoint({\n" +
        "    stack: new StateStack().toJSON(),\n" +
        "    globals: new GlobalStore().toJSON(),\n" +
        '    nodeId: "main",\n' +
        "  });\n" +
        "  throw new PauseSignal(checkpoint);\n" +
        "}\n",
    );
    fs.writeFileSync(
      mainAgency,
      'import { throwPause } from "./thrower.js"\n' +
        "\n" +
        "def inner(): string {\n" +
        "  throwPause()\n" +
        '  return "unreachable"\n' +
        "}\n" +
        "\n" +
        "node viaFunction(): string {\n" +
        "  return inner()\n" +
        "}\n" +
        "\n" +
        "node viaNode(): string {\n" +
        "  throwPause()\n" +
        '  return "unreachable"\n' +
        "}\n",
    );
    resetCompilationCache();
    compile({}, mainAgency);
  });

  afterAll(() => {
    safeDeleteDirectoryWithin(path.resolve(__dirname, "../.."), fixturesRoot);
  });

  it("a PauseSignal thrown inside a def is not converted to a Failure", async () => {
    const mod = await import(pathToFileURL(mainJs).href);
    await expect(mod.viaFunction()).rejects.toMatchObject({ name: "PauseSignal" });
  });

  it("a PauseSignal thrown inside a node body is not converted to a Failure", async () => {
    const mod = await import(pathToFileURL(mainJs).href);
    await expect(mod.viaNode()).rejects.toMatchObject({ name: "PauseSignal" });
  });
});
