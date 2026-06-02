import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

// Mirrors the helper used by `constReassignment.test.ts`. Returns
// just the error messages so assertions stay terse.
function check(source: string): string[] {
  const parsed = parseAgency(source);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, {}, info).errors.map((e) => e.message);
}

describe("validateStaticInit — banned per-run primitives", () => {
  it("rejects `llm()` inside a static const initializer", () => {
    const errs = check(`
static const prompt = llm("hello")
node main() { return prompt }
`);
    expect(errs.some((m) => /Static const .*prompt.* cannot call .*llm/.test(m))).toBe(true);
  });

  it("rejects `llm()` inside a static bare statement", () => {
    const errs = check(`
def setup() { llm("hello") }
static llm("startup")
node main() { return 1 }
`);
    expect(
      errs.some((m) =>
        /Static bare statement cannot call .*llm/.test(m),
      ),
    ).toBe(true);
  });

  it("rejects `interrupt()` inside a static const initializer", () => {
    const errs = check(`
static const x = interrupt("foo")
node main() { return x }
`);
    expect(
      errs.some((m) => /Static const .*x.* cannot \\?\`?interrupt/.test(m)),
    ).toBe(true);
  });

  it("does NOT flag `llm()` inside a node body", () => {
    const errs = check(`
node main() {
  const r = llm("hello")
  return r
}
`);
    expect(errs.filter((m) => m.includes("static")).length).toBe(0);
  });

  it("does NOT flag `llm()` inside a `def` body called from a node", () => {
    // Per the design doc, transitive detection through user helpers
    // is intentionally out of scope — the runtime trap is the safety
    // net. This test pins that direct-only contract.
    const errs = check(`
def helper(): string { return llm("hello") }
static const x = helper()
node main() { return x }
`);
    expect(errs.some((m) => m.includes("llm"))).toBe(false);
  });
});

describe("validateStaticInit — static mutation detection", () => {
  it("rejects top-level reassignment of a static", () => {
    const errs = check(`
static const x = 1
x = 2
node main() { return x }
`);
    expect(
      errs.some((m) => /Cannot reassign static .*x.* at module top level/.test(m)),
    ).toBe(true);
  });

  it("rejects top-level `.push(...)` on a static array", () => {
    const errs = check(`
static const items = [1, 2, 3]
items.push(4)
node main() { return items }
`);
    expect(
      errs.some((m) =>
        /Cannot mutate static .*items.* via .*push.*/.test(m),
      ),
    ).toBe(true);
  });

  it("does NOT flag a `let` reassignment of a non-static", () => {
    const errs = check(`
let x = 1
x = 2
node main() { return x }
`);
    expect(errs.filter((m) => m.includes("static")).length).toBe(0);
  });

  it("does NOT flag the static's own declaration", () => {
    const errs = check(`
static const x = 1
node main() { return x }
`);
    expect(errs.filter((m) => m.includes("Cannot reassign")).length).toBe(0);
  });

  it("does NOT flag mutation inside a node body", () => {
    // Inside a per-run code path the deep-freeze runtime check is the
    // safety net. Compile-time detection here is only for the obvious
    // top-level pattern.
    const errs = check(`
static const items = [1, 2, 3]
node main() {
  items.push(4)
  return items
}
`);
    expect(errs.filter((m) => /Cannot mutate static/.test(m)).length).toBe(0);
  });
});
