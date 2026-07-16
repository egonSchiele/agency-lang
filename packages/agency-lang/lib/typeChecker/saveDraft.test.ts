import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { AgencyConfig } from "../config.js";

function check(source: string, config: Partial<AgencyConfig> = {}) {
  const parsed = parseAgency(source);
  if (!parsed.success) {
    throw new Error(`parse failed: ${parsed.message}`);
  }
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  const result = typeCheck(parsed.result, config, info);
  return result.errors
    .filter((e) => (e.severity ?? "error") === "error")
    .map((e) => e.message);
}

describe("saveDraft argument type-check", () => {
  it("accepts a draft assignable to the enclosing return type", () => {
    const errors = check(`
      import { guard, saveDraft } from "std::thread"
      def f(): string {
        saveDraft("ok")
        return "x"
      }
    `);
    expect(errors).toHaveLength(0);
  });

  it("rejects a draft not assignable to the enclosing return type", () => {
    const errors = check(`
      import { guard, saveDraft } from "std::thread"
      def f(): string {
        saveDraft(42)
        return "x"
      }
    `);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("checks a draft inside a guard block against the block's inferred return type", () => {
    // A guard block's return type is inferred from its `return` (here `string`),
    // so a matching draft is fine and a mismatched one is flagged — the check is
    // NOT limited to top-level def/node bodies.
    const ok = check(`
      import { guard, saveDraft } from "std::thread"
      def f(): string {
        const r = guard(cost: 1.0) as {
          saveDraft("ok")
          return "x"
        }
        return "y"
      }
    `);
    expect(ok).toHaveLength(0);

    const bad = check(`
      import { guard, saveDraft } from "std::thread"
      def f(): string {
        const r = guard(cost: 1.0) as {
          saveDraft(42)
          return "x"
        }
        return "y"
      }
    `);
    expect(bad.length).toBeGreaterThan(0);
  });
});
