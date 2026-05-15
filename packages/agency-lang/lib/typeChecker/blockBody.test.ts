import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function check(source: string): string[] {
  const parsed = parseAgency(source);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  // Silence the undefined-function diagnostic — no SymbolTable means
  // stdlib calls (print, …) would warn as unresolved.
  return typeCheck(
    parsed.result,
    { typechecker: { undefinedFunctions: "silent" } },
    info,
  ).errors.map((e) => e.message);
}

describe("block body type-checking", () => {
  it("block return doesn't leak into the enclosing function's return inference", () => {
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
