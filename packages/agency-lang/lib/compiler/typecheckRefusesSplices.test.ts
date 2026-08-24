import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { safeDeleteDirectory } from "../utils.js";
import { typeCheckSource } from "./typecheck.js";
import { _typecheckFile } from "../stdlib/agency.js";

/**
 * Type checking RUNS splice generators.
 *
 * `_typecheckFile` hands the checker a real on-disk path so relative imports
 * resolve, which means a splice resolves its generator against that directory
 * and executes it. The comment justifying that path ("typechecking is
 * read-only") does not hold for a file containing a splice, and unlike
 * `compile` this path never passes through the closure validator.
 *
 * These tests pin the boundary: the agent-reachable entry points decline
 * generator execution, and the underlying pipeline still allows it when a
 * caller explicitly asks.
 */
let dir: string;

beforeEach(() => {
  dir = path.join(process.cwd(), ".agency-tmp", `tc-refuse-${nanoid()}`);
  fs.mkdirSync(dir, { recursive: true });
  // A generator that writes a file when it runs. Nothing should create it.
  fs.writeFileSync(
    path.join(dir, "gen.agency"),
    `import { Code } from "std::agency"\n\nexport def makeGreet(): Code {\n  return [|\n    def greet(): string {\n      return "hi"\n    }\n  |]\n}\n`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "host.agency"),
    `import { makeGreet } from "./gen.agency"\n\n$( makeGreet() )\n\nnode main() {\n  print(greet())\n}\n`,
    "utf-8",
  );
});

afterEach(() => {
  safeDeleteDirectory(dir, false);
});

describe("agent-reachable type checking declines generator execution", () => {
  // A refusal is not a diagnostic in the report: continuing would answer as
  // though the file had no splice, reporting every generated name as
  // undefined. It throws, which the Result-returning stdlib entry points
  // surface to the agent as a failure.
  it("typecheckFile refuses instead of running the generator", () => {
    expect(() => _typecheckFile(dir, "host.agency")).toThrow(/AG8016/);
  });

  it("the refusal names the generator, so the caller knows what was declined", () => {
    expect(() => _typecheckFile(dir, "host.agency")).toThrow(/makeGreet/);
  });

  it("a file with no splice still checks normally", () => {
    fs.writeFileSync(path.join(dir, "plain.agency"), `node main() {\n  print("hi")\n}\n`, "utf-8");
    const report = _typecheckFile(dir, "plain.agency");
    expect(report.errors.map((e) => e.code)).not.toContain("AG8016");
  });

  it("the pipeline itself still expands when the caller does not decline", () => {
    // The refusal is a caller's choice, not a property of the checker: the
    // same file, checked without the setting, expands and reports no AG8016.
    // This is what stops the fix from becoming a blanket ban.
    const hostPath = path.join(dir, "host.agency");
    const report = typeCheckSource(fs.readFileSync(hostPath, "utf-8"), hostPath);
    expect(report.errors.map((e) => e.code)).not.toContain("AG8016");
  }, 60_000);
});
