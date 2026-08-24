import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pathToFileURL } from "url";
import * as fs from "node:fs";
import * as path from "node:path";
import { compile, resetCompilationCache } from "@/compiler/defaultSession.js";
import { safeDeleteDirectoryWithin } from "@/utils.js";

/**
 * An abort travels up through compiled code as a value, and node level is
 * where it turns back into an exception. Codegen emits that conversion after
 * every call whose result is bound to a local, but a bare `return foo()` in
 * tail position binds nothing and gets no guard — so before the boundary
 * check in `runNode`, an aborted tail call escaped as the node's return value
 * and the CLI reported runaway recursion as a successful run with no output.
 *
 * This is the exact program from issue #243, which is why the recursion is
 * written in tail position.
 */
describe("an abort in tail position becomes an exception at the node boundary", () => {
  const fixturesRoot = path.resolve(__dirname, "../../.agency-tmp/node-abort-boundary");
  const mainAgency = path.join(fixturesRoot, "main.agency");
  const mainJs = mainAgency.replace(/\.agency$/, ".js");

  beforeAll(() => {
    fs.mkdirSync(fixturesRoot, { recursive: true });
    fs.writeFileSync(
      mainAgency,
      "def foo() { return bar() }\n" +
        "def bar() { return foo() }\n" +
        "\n" +
        "node main() { return foo() }\n",
    );
    resetCompilationCache();
    // A small limit keeps the test fast; the escape happens at any depth.
    compile({ maxCallDepth: 16 }, mainAgency);
  });

  afterAll(() => {
    safeDeleteDirectoryWithin(path.resolve(__dirname, "../.."), fixturesRoot);
  });

  it("rejects instead of returning the aborted value as the node's result", async () => {
    const mod = await import(pathToFileURL(mainJs).href);
    await expect(mod.main()).rejects.toThrow(/Maximum call depth exceeded/);
  });

  it("keeps the frame names and the config knob in the surfaced message", async () => {
    const mod = await import(pathToFileURL(mainJs).href);
    // Naming what recursed and how to raise the limit is the whole point of
    // the diagnostic; the cause carries both across the value transport.
    await expect(mod.main()).rejects.toThrow(/Recent calls:.*foo/);
    await expect(mod.main()).rejects.toThrow(/maxCallDepth/);
  });
});

/**
 * The same escape, one interrupt later. `runResumeLoop` ends a run the same
 * way `runNode` does — graph.run, then createReturnObject — so before it got
 * the same boundary check, resuming past an interrupt into a tail-position
 * abort recorded the AbortedResult as a successful result and exited 0.
 */
describe("the resume path converts a tail-position abort too", () => {
  const fixturesRoot = path.resolve(__dirname, "../../.agency-tmp/resume-abort-boundary");
  const mainAgency = path.join(fixturesRoot, "main.agency");
  const mainJs = mainAgency.replace(/\.agency$/, ".js");

  beforeAll(() => {
    fs.mkdirSync(fixturesRoot, { recursive: true });
    fs.writeFileSync(
      mainAgency,
      "def foo() { return bar() }\n" +
        "def bar() { return foo() }\n" +
        "\n" +
        "node main() {\n" +
        '  raise interrupt("ok?")\n' +
        "  return foo()\n" +
        "}\n",
    );
    resetCompilationCache();
    compile({ maxCallDepth: 16 }, mainAgency);
  });

  afterAll(() => {
    safeDeleteDirectoryWithin(path.resolve(__dirname, "../.."), fixturesRoot);
  });

  it("rejects on resume instead of recording the aborted value as the result", async () => {
    const mod = await import(pathToFileURL(mainJs).href);
    const first = await mod.main();
    // The first pass stops at the interrupt; the recursion has not run yet.
    expect(mod.hasInterrupts(first.data)).toBe(true);
    await expect(mod.respondToInterrupts(first.data, [mod.approve()])).rejects.toThrow(
      /Maximum call depth exceeded/,
    );
  });
});
