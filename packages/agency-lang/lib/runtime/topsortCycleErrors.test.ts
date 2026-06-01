import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { compile, resetCompilationCache } from "../cli/commands.js";

/**
 * Runs the cycle + runtime-trap fixtures under
 * `tests/agency/topsort/cycles/`. The Agency test framework can't
 * express "expected compile error" or "expected runtime trap with
 * message X", so these cases live as bare `.agency` fixtures (no
 * `.test.json`) and are exercised by this vitest test.
 *
 * Why the fixtures sit under `tests/agency/topsort/` instead of
 * adjacent to this file: every PR-2 topsort behavior (success and
 * failure) is then browsable from one directory tree. The success
 * cases have `.test.json` files and run via `agency test`; this file
 * covers the rest.
 *
 * Each fixture is one directory containing a multi-file Agency program.
 * The fixture's `main.agency` (or, when none exists, an explicit entry
 * name passed to the helper) is the entry point. The helper invokes
 * the same CLI `compile()` path users hit when running `agency test`
 * so the closure walker + per-module init plan + runtime registration
 * are fully exercised end-to-end.
 */

const FIXTURES_ROOT = path.resolve(
  __dirname,
  "../../tests/agency/topsort/cycles",
);

type CompileOutcome =
  | { kind: "ok"; mod: any }
  | { kind: "compileError"; message: string };

let lastOutputs: string[] = [];

beforeEach(() => {
  lastOutputs = [];
});

afterEach(() => {
  // Remove the .js outputs the compile() pass dropped next to each
  // fixture source so the next run starts clean. Stale outputs from a
  // crashed run can mask real failures (the test framework imports
  // them straight from disk).
  for (const f of lastOutputs) {
    try {
      fs.unlinkSync(f);
    } catch {
      // best-effort
    }
  }
});

/**
 * Compile `entry` via the real CLI compile path. Intercepts the
 * `process.exit(1)` the CLI fires for `CompileClosureError` so the
 * caller can assert on the captured stderr instead.
 */
async function runFixture(
  fixtureDir: string,
  entryRel: string,
): Promise<CompileOutcome> {
  const entryAbs = path.join(fixtureDir, entryRel);
  resetCompilationCache();

  const errors: string[] = [];
  const origError = console.error;
  console.error = (msg: any) => errors.push(String(msg));
  const origExit = process.exit;
  let exited = false;
  process.exit = ((code?: number) => {
    exited = true;
    throw new Error(`__processExit__ ${code}`);
  }) as never;

  try {
    compile({}, entryAbs);
  } catch (e) {
    if ((e as Error).message.startsWith("__processExit__")) {
      return { kind: "compileError", message: errors.join("\n") };
    }
    throw e;
  } finally {
    console.error = origError;
    process.exit = origExit;
  }
  if (exited) {
    return { kind: "compileError", message: errors.join("\n") };
  }

  // Track the per-file .js outputs so afterEach can clean them up.
  for (const entry of fs.readdirSync(fixtureDir)) {
    if (entry.endsWith(".js")) {
      lastOutputs.push(path.join(fixtureDir, entry));
    }
  }

  const mainJs = entryAbs.replace(/\.agency$/, ".js");
  const mod = await import(pathToFileURL(mainJs).href);
  return { kind: "ok", mod };
}

describe("tests/agency/topsort/cycles fixtures", () => {
  it("same-file cycle → compile error names both decls", async () => {
    const outcome = await runFixture(
      path.join(FIXTURES_ROOT, "same-file-cycle"),
      "main.agency",
    );
    expect(outcome.kind).toBe("compileError");
    if (outcome.kind !== "compileError") return;
    expect(outcome.message).toMatch(/Circular static dependency/);
    expect(outcome.message).toMatch(/\ba\b/);
    expect(outcome.message).toMatch(/\bb\b/);
  });

  it("two-file cycle → compile error names both decls", async () => {
    const outcome = await runFixture(
      path.join(FIXTURES_ROOT, "two-file-cycle"),
      "bar.agency",
    );
    expect(outcome.kind).toBe("compileError");
    if (outcome.kind !== "compileError") return;
    expect(outcome.message).toMatch(/Circular static dependency/);
    expect(outcome.message).toMatch(/fooValue/);
    expect(outcome.message).toMatch(/barValue/);
  });

  it("three-file triangle cycle → compile error names all three decls", async () => {
    const outcome = await runFixture(
      path.join(FIXTURES_ROOT, "three-file-cycle"),
      "c.agency",
    );
    expect(outcome.kind).toBe("compileError");
    if (outcome.kind !== "compileError") return;
    expect(outcome.message).toMatch(/Circular static dependency/);
    expect(outcome.message).toMatch(/\bx\b/);
    expect(outcome.message).toMatch(/\by\b/);
    expect(outcome.message).toMatch(/\bz\b/);
  });

  it("runtime trap: indirect static read fires PR-1 trap with source moduleId", async () => {
    // This fixture compiles cleanly (the dep graph can't see edges
    // through function bodies) but the trap fires at agent-run time
    // when `a`'s initializer calls `readB()` and reads `b` before
    // `b`'s init has run.
    //
    // `readB` is an AgencyFunction, so the trap thrown inside its
    // Runner step is caught and converted to a `failure(...)` result.
    // `a` then holds the failure; `node main() { return a }` surfaces
    // it as `result.data.error` — that's where the trap message
    // arrives in user-visible form.
    const outcome = await runFixture(
      path.join(FIXTURES_ROOT, "runtime-trap"),
      "main.agency",
    );
    if (outcome.kind !== "ok") {
      throw new Error(
        `expected fixture to compile cleanly, got compile error:\n${outcome.message}`,
      );
    }
    const result = await outcome.mod.main();
    expect(result.data?.success).toBe(false);
    expect(result.data?.error).toMatch(/Tried to read static `b`/);
    expect(result.data?.error).toMatch(
      /tests\/agency\/topsort\/cycles\/runtime-trap\/main\.agency/,
    );
  });
});
