import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function check(source: string): string[] {
  const parsed = parseAgency(source);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, {}, info).errors.map((e) => e.message);
}

describe("block body type-checking", () => {
  it("block return doesn't leak into the enclosing function's return inference", () => {
    // `return "hello"` belongs to the block, not `main`. Without the fix, it
    // gets folded into main's inferred return type and fights with `return 42`.
    const errs = check(`
def twice(b: () => string): string[] {
  return [b(), b()]
}

def main(): number {
  let r = twice() as {
    return "hello"
  }
  return 42
}
`);
    expect(errs).toEqual([]);
  });

  it("block return is checked against the slot's return type", () => {
    // Slot says block returns number; literal returns a string — diagnostic
    // should mention 'block return', not the enclosing function's return.
    const errs = check(`
def f(b: () => number): number {
  return b()
}

def main(): void {
  let n = f() as {
    return "not a number"
  }
}
`);
    expect(errs.some((m) => /not assignable/i.test(m) && /block return/.test(m))).toBe(true);
  });

  it("block params pick up types from the slot when the literal is unannotated", () => {
    // Slot is `(number) => void`, so `x` should be number inside the block.
    // Assigning to `let y: string = x` must error.
    const errs = check(`
def each(items: number[], cb: (number) => void): void {
  cb(items[0])
}

def main(): void {
  each([1, 2, 3]) as x {
    let y: string = x
  }
}
`);
    expect(errs.some((m) => /not assignable/i.test(m))).toBe(true);
  });

  it("untyped slot leaves block params as any (no spurious errors)", () => {
    // Callee's block-receiving param has no type annotation, so the literal's
    // params and returns aren't constrained by a contract.
    const errs = check(`
def each(items: number[], cb): void {
  print("hi")
}

def main(): void {
  each([1, 2, 3]) as x {
    let y: string = x
    return 42
  }
}
`);
    expect(errs).toEqual([]);
  });

  it("nested block returns are routed to the right slot", () => {
    // Outer block's return is checked against `outer`'s slot (number).
    // Inner block's return is checked against `inner`'s slot (string).
    const outerOK = check(`
def outer(b: () => number): number { return b() }
def inner(b: () => string): string { return b() }

def main(): void {
  let r: number = outer() as {
    let s: string = inner() as { return "ok" }
    return 1
  }
}
`);
    expect(outerOK).toEqual([]);

    const innerWrong = check(`
def outer(b: () => number): number { return b() }
def inner(b: () => string): string { return b() }

def main(): void {
  let r: number = outer() as {
    let s: string = inner() as { return 99 }
    return 1
  }
}
`);
    expect(innerWrong.some((m) => /not assignable/i.test(m) && /block return/.test(m))).toBe(true);
  });
});
