import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import { typecheckSource } from "./testUtils.js";

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
    expect(errs.some((m) => /Static bare statement cannot call .*llm/.test(m))).toBe(true);
  });

  it("rejects `interrupt()` inside a static const initializer", () => {
    const errs = check(`
static const x = interrupt("foo")
node main() { return x }
`);
    expect(errs.some((m) => /Static const .*x.* cannot \\?\`?interrupt/.test(m))).toBe(true);
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
    expect(errs.some((m) => /Cannot reassign static .*x.* at module top level/.test(m))).toBe(true);
  });

  it("rejects top-level `.push(...)` on a static array", () => {
    const errs = check(`
static const items = [1, 2, 3]
items.push(4)
node main() { return items }
`);
    expect(errs.some((m) => /Cannot mutate static .*items.* via .*push.*/.test(m))).toBe(true);
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

// Issue #912: the interrupt is a call or two away from the initializer.
describe("validateStaticInit — a call that can interrupt", () => {
  const HEAD = `
effect test::risky { what: string }
def risky(): string {
  return interrupt test::risky("ok?", { what: "x" })
  return "real"
}
def viaHelper(): string { return risky() }
def safe(): string { return "fine" }`;

  // The rule reads the symbol table's effect pass, so these go through
  // typecheckSource, which builds one. The file's `check` helper does not.
  const check = (source: string): string[] => typecheckSource(source).map((e) => e.message);

  const interrupting = (errs: string[]): string[] =>
    errs.filter((m) => m.includes("which may interrupt"));

  it("rejects a direct call to an interrupting function", () => {
    const errs = interrupting(
      check(`${HEAD}
static const b = risky()
node main() { return b }`),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("Static const `b` calls `risky`");
    expect(errs[0]).toContain("[test::risky]");
    expect(errs[0]).toContain("with approve");
  });

  it("rejects an interrupt two calls away, and one nested in an argument", () => {
    const errs = interrupting(
      check(`${HEAD}
def wrap(s: string): string { return s }
static const c = viaHelper()
static const d = wrap(risky())
node main() { return c }`),
    );
    expect(errs).toHaveLength(2);
  });

  it("rejects it in a static bare statement", () => {
    const errs = interrupting(
      check(`${HEAD}
static risky()
node main() { return 1 }`),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("Static bare statement");
  });

  it("accepts a call answered at the site, and a call that cannot interrupt", () => {
    const errs = interrupting(
      check(`${HEAD}
static const e = risky() with approve
static const f = risky() with reject
static const g = safe()
node main() { return e }`),
    );
    expect(errs).toEqual([]);
  });

  it("accepts a helper that answers its own interrupt", () => {
    const errs = interrupting(
      check(`${HEAD}
def answered(): string { return risky() with approve }
def viaAnswered(): string { return answered() }
def inHandleBlock(): string {
  handle { return risky() } with (intr) { return approve() }
}
static const m = answered()
static const n = viaAnswered()
static const o = inHandleBlock()
node main() { return m }`),
    );
    expect(errs).toEqual([]);
  });

  it("a helper that only propagates has answered nothing", () => {
    const errs = interrupting(
      check(`${HEAD}
def passesOn(): string { return risky() with propagate }
static const p = passesOn()
node main() { return p }`),
    );
    expect(errs).toHaveLength(1);
  });

  it("with propagate answers nothing, so it is still rejected", () => {
    const errs = interrupting(
      check(`${HEAD}
static const h = risky() with propagate
node main() { return h }`),
    );
    expect(errs).toHaveLength(1);
  });

  it("a non-static top-level const is not this rule's business", () => {
    const errs = interrupting(
      check(`${HEAD}
node main() { const k = risky() with approve
 return k }`),
    );
    expect(errs).toEqual([]);
  });
});
