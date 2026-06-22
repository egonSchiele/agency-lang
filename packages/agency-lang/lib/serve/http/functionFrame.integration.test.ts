import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pathToFileURL } from "url";
import * as fs from "node:fs";
import * as path from "node:path";
import { compile, resetCompilationCache } from "../../cli/commands.js";
import { discoverExports } from "../discovery.js";
import { createHttpHandler } from "./adapter.js";
import { createLogger } from "../../logger.js";
import type { AgencyFunction } from "../../runtime/agencyFunction.js";

/**
 * Regression test for `agency serve` invoking exported FUNCTIONS.
 *
 * Generated function bodies assume an ambient Agency execution frame
 * (their first lines read `getRuntimeContext().ctx`, the base stack /
 * thread store via `setupFunction()`, and globals via `__globals()`).
 * Nodes get that frame from `runNode`; functions used to be invoked cold
 * by the serve adapters, so every `POST /function/:name` threw
 * "getRuntimeContext() called outside an Agency execution frame".
 *
 * The fix routes function calls through the module's generated
 * `__invokeFunction`, which installs a node-grade frame via
 * `runExportedFunction`. This test compiles a real module and drives it
 * through the actual HTTP handler — the adapter unit tests use plain-JS
 * fake function bodies that never touch the runtime context, so only an
 * end-to-end compile + invoke exercises the regression.
 */
describe("serve http invokes exported functions inside a runtime frame", () => {
  const fixturesRoot = path.resolve(
    __dirname,
    "../../../.agency-tmp/serve-function-frame",
  );
  const mainAgency = path.join(fixturesRoot, "main.agency");
  const mainJs = mainAgency.replace(/\.agency$/, ".js");

  // Use a static const so the body depends on bootstrap init having run
  // inside the frame (an uninitialized static read would throw), and an
  // explicit return so we can assert the exact value.
  const source = [
    'static const GREETING = "Hello"',
    "",
    "export def greet(name: string): string {",
    '  return "${GREETING}, ${name}!"',
    "}",
    "",
    "node main() {",
    '  print(greet("world"))',
    "}",
    "",
  ].join("\n");

  let handler: ReturnType<typeof createHttpHandler>;

  beforeAll(async () => {
    fs.mkdirSync(fixturesRoot, { recursive: true });
    fs.writeFileSync(mainAgency, source);
    resetCompilationCache();
    compile({}, mainAgency);

    const mod = (await import(pathToFileURL(mainJs).href)) as Record<string, unknown>;
    const toolRegistry = (mod.__toolRegistry ?? {}) as Record<string, AgencyFunction>;
    // Derive the moduleId the compiler baked into each AgencyFunction so
    // discovery's `fn.module === moduleId` filter matches.
    const greetFn = Object.values(toolRegistry).find((f) => f.name === "greet");
    const moduleId = greetFn?.module ?? "";

    const exports = discoverExports({
      toolRegistry,
      moduleExports: mod,
      moduleId,
    });

    handler = createHttpHandler({
      exports,
      port: 0,
      logger: createLogger("error"),
      hasInterrupts: mod.hasInterrupts as (data: unknown) => boolean,
      respondToInterrupts: mod.respondToInterrupts as (
        i: unknown[],
        r: unknown[],
      ) => Promise<unknown>,
    });
  });

  afterAll(() => {
    fs.rmSync(fixturesRoot, { recursive: true, force: true });
  });

  it("POST /function/greet returns the computed value (no frame error)", async () => {
    const result = await handler("POST", "/function/greet", { name: "foo" });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true, value: "Hello, foo!" });
  });

  it("lists greet as an exported function", async () => {
    const result = await handler("GET", "/list", undefined);
    const body = result.body as { functions: Array<{ name: string }> };
    expect(body.functions.map((f) => f.name)).toContain("greet");
  });
});
