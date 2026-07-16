import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

/** Errors as {code, message} so every reject case can assert the SPECIFIC
 *  diagnostic — a generic "some error fired" would stay green with the
 *  finalize rule broken (e.g. rule 1 masked by the ordinary return check). */
function check(source: string): { code: string; message: string }[] {
  const parsed = parseAgency(source);
  if (!parsed.success) {
    throw new Error(`parse failed: ${parsed.message}`);
  }
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  const result = typeCheck(parsed.result, {}, info);
  return result.errors
    .filter((e) => (e.severity ?? "error") === "error")
    .map((e) => ({ code: e.code ?? "", message: e.message }));
}

function codes(source: string): string[] {
  return check(source).map((e) => e.code);
}

describe("finalize checker — rule 1: return type", () => {
  it("accepts a finalize whose return matches the enclosing return type", () => {
    const errors = check(`
      def f(): string {
        finalize {
          return "ok"
        }
        return "x"
      }
    `);
    expect(errors).toHaveLength(0);
  });

  it("rejects a finalize return that mismatches the enclosing return type", () => {
    // The existing return-type machinery reaches the finalize body (same
    // scope), so the code is the ordinary assignability diagnostic.
    const result = check(`
      def f(): string {
        finalize {
          return 42
        }
        return "x"
      }
    `);
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((e) => e.code.startsWith("AG2"))).toBe(true);
  });
});

describe("finalize checker — rule 2: one per scope, top level only", () => {
  it("rejects a second finalize in the same scope (AG6032)", () => {
    expect(
      codes(`
      def f(): string {
        finalize {
          return "a"
        }
        finalize {
          return "b"
        }
        return "x"
      }
    `),
    ).toContain("AG6032");
  });

  it("rejects a finalize nested in an if (AG6033)", () => {
    expect(
      codes(`
      def f(): string {
        if (true) {
          finalize {
            return "a"
          }
        }
        return "x"
      }
    `),
    ).toContain("AG6033");
  });

  it("accepts a finalize that is not the last statement", () => {
    const errors = check(`
      def f(): string {
        finalize {
          return "a"
        }
        return "x"
      }
    `);
    expect(errors).toHaveLength(0);
  });
});

describe("finalize checker — rule 3: no interrupts (AG3016)", () => {
  it("rejects a direct interrupt", () => {
    expect(
      codes(`
      def f(): string {
        finalize {
          interrupt("no")
          return "a"
        }
        return "x"
      }
    `),
    ).toContain("AG3016");
  });

  it("rejects a TRANSITIVE interrupt (calling a def that interrupts)", () => {
    expect(
      codes(`
      def asker(): string {
        interrupt("ask")
        return "a"
      }

      def f(): string {
        finalize {
          return asker()
        }
        return "x"
      }
    `),
    ).toContain("AG3016");
  });
});

describe("finalize checker — rule 4: no saveDraft (AG6034)", () => {
  it("rejects saveDraft inside a finalize", () => {
    expect(
      codes(`
      def f(): string {
        finalize {
          saveDraft("no")
          return "a"
        }
        return "x"
      }
    `),
    ).toContain("AG6034");
  });
});

describe("finalize checker — rule 5: defs and blocks only (AG6035)", () => {
  it("rejects a finalize in a node body", () => {
    expect(
      codes(`
      node main() {
        finalize {
          return "a"
        }
        return "x"
      }
    `),
    ).toContain("AG6035");
  });

  it("accepts a finalize inside a guard block", () => {
    const errors = check(`
      import { guard } from "std::thread"

      node main() {
        const r = guard(cost: 1.0) as {
          finalize {
            return "partial"
          }
          return "full"
        }
        return "done"
      }
    `);
    expect(errors).toHaveLength(0);
  });
});

describe("finalize checker — rule 6: return shape in finalize scopes (AG6036)", () => {
  it("rejects a call embedded in a return expression", () => {
    expect(
      codes(`
      def g2(): string {
        return "ok"
      }

      def f(): string {
        finalize {
          return "a"
        }
        return "x:\${g2()}"
      }
    `),
    ).toContain("AG6036");
  });

  it("accepts a direct call in return position", () => {
    const errors = check(`
      def g2(): string {
        return "ok"
      }

      def f(): string {
        finalize {
          return "a"
        }
        return g2()
      }
    `);
    expect(errors).toHaveLength(0);
  });

  it("does not restrict returns in scopes WITHOUT a finalize", () => {
    const errors = check(`
      def g2(): string {
        return "ok"
      }

      def f(): string {
        return "x:\${g2()}"
      }
    `);
    expect(errors).toHaveLength(0);
  });
});

describe("finalize checker — definite returns", () => {
  it("a finalize return does not satisfy definite-returns", () => {
    const result = check(`
      def f(): string {
        finalize {
          return "a"
        }
      }
    `);
    // notAllPathsReturn defaults to warn; look at ALL diagnostics.
    const parsed = parseAgency(`
      def f(): string {
        finalize {
          return "a"
        }
      }
    `);
    if (!parsed.success) throw new Error("parse failed");
    const info = buildCompilationUnit(parsed.result, undefined, undefined, "");
    const all = typeCheck(parsed.result, {}, info);
    expect(all.errors.some((e) => e.name === "notAllPathsReturn")).toBe(true);
    void result;
  });
});

describe("finalize checker — rule 3 coverage boundary (documented)", () => {
  it("does NOT statically catch an imported interrupting callee — the runtime backstop covers it", () => {
    // interruptEffectsByFunction is built from the compilation unit's own
    // scopes, so a prelude/imported function that raises (like read) is
    // invisible to the static rule. This is DOCUMENTED in the AG3016
    // explanation, and AbortedResult.withFinalize treats an interrupting
    // finalize result as a finalize failure at runtime. If this test ever
    // starts failing because AG3016 appears, the static rule grew
    // cross-file coverage — update the explanation and flip this pin.
    const result = codes(`
      def f(): string {
        finalize {
          const content = read("notes.txt")
          return "x"
        }
        return "y"
      }
    `);
    expect(result).not.toContain("AG3016");
  });
});

describe("finalize checker — locals are nullable inside the finalize body", () => {
  it("an unguarded local read fails the return-type check (T | null)", () => {
    const result = check(`
      def g2(): string {
        return "ok"
      }

      def f(): string {
        const x = g2()
        return x

        finalize {
          return x
        }
      }
    `);
    expect(result.some((e) => e.code.startsWith("AG2"))).toBe(true);
  });

  it("a != null check narrows the local back", () => {
    const errors = check(`
      def g2(): string {
        return "ok"
      }

      def f(): string {
        const x = g2()
        return x

        finalize {
          if (x != null) {
            return x
          }
          return "fallback"
        }
      }
    `);
    expect(errors).toHaveLength(0);
  });
});
