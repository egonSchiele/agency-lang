import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pathToFileURL } from "url";
import * as fs from "node:fs";
import * as path from "node:path";
import { compile, resetCompilationCache } from "@/compiler/defaultSession.js";
import { discoverExports } from "../discovery.js";
import { createHttpHandler } from "./adapter.js";
import { createLogger } from "../../logger.js";
import type { AgencyFunction } from "../../runtime/agencyFunction.js";
import type { ServedInvocationOutcome } from "../../runtime/invocationUsage.js";

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
    "export def needsApproval(): string {",
    '  raise app::confirm("proceed?")',
    '  return "done"',
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
      logger: createLogger("error"),
      hasInterrupts: mod.hasInterrupts as (data: unknown) => boolean,
      respondToInterrupts: mod.__respondToInterruptsForServe as (
        i: unknown[],
        r: unknown[],
      ) => Promise<ServedInvocationOutcome<unknown>>,
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

  // Pins the real wire behavior of a served function that raises an unhandled
  // interrupt: functions are one-shot (no checkpoint/resume), so this is NOT a
  // node-style pause. The function fails at checkpoint creation, and the adapter
  // wraps that failed AgencyResult in a success envelope. So `remote call
  // --function` cannot offer a resume loop — it prints this as a normal serve
  // result. (This is why the spec does not promise a special "unsupported"
  // message; the wire carries only a generic failure.)
  it("a served function raising an unhandled interrupt fails one-shot (no pause)", async () => {
    const result = await handler("POST", "/function/needsApproval", {});
    expect(result.status).toBe(200);
    const body = result.body as {
      success: boolean;
      value: { __type?: string; success?: boolean; error?: string };
    };
    expect(body.success).toBe(true);
    expect(body.value.__type).toBe("resultType");
    expect(body.value.success).toBe(false);
    expect(body.value.error).toContain("Cannot create checkpoint");
  });
});
