import { describe, expect, it } from "vitest";
import { compileSource } from "../compiler/compile.js";

/**
 * Scaffolding guard, not a permanent feature. Every splice is removed by
 * the expansion pass before codegen, so one arriving here means expansion
 * did not run. Without the guard that surfaces as a raw "Unhandled Agency
 * node type" stack trace from processNode — verified: it did, before this
 * landed.
 *
 * Task 7 of the compile-time-splices plan deletes both the guard and this
 * file, replacing them with real expansion.
 */
function errorsOf(source: string): string {
  const result = compileSource(source, {});
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error("unreachable");
  }
  return result.errors.join("\n");
}

describe("a splice refuses to compile until expansion exists", () => {
  it("refuses a declaration splice with a comprehensible message", () => {
    expect(errorsOf(`$( gen() )\n\nnode main() {\n  return 1\n}\n`)).toContain(
      "compile-time splice",
    );
  });

  it("refuses an expression splice", () => {
    expect(
      errorsOf(`node main() {\n  const x = $( gen() )\n  return x\n}\n`),
    ).toContain("compile-time splice");
  });

  it("does not say `Unhandled Agency node type`", () => {
    // The whole point of the guard: an internal crash is not a safe
    // intermediate state, a clean refusal is.
    expect(errorsOf(`$( gen() )\n`)).not.toContain("Unhandled Agency node type");
  });

  it("mints no AG code", () => {
    // The registry is append-only and its explanations are exhaustive by
    // type, so a code for temporary scaffolding would outlive it.
    expect(errorsOf(`$( gen() )\n`)).not.toMatch(/AG\d{4}/);
  });

  it("leaves a splice-free program alone", () => {
    const result = compileSource(`node main() {\n  return 1\n}\n`, {});
    expect(result.success).toBe(true);
  });
});
