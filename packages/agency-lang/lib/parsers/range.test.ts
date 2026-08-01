import { describe, it, expect } from "vitest";
import { parseAgency } from "@/parser.js";
import { formatSource } from "@/formatter.js";

function program(src: string) {
  const parsed = parseAgency(src, {}, false);
  if (!parsed.success) throw new Error(`expected a successful parse, got: ${parsed.message}`);
  return parsed.result;
}

describe("range operator", () => {
  const pairs: [string, string][] = [
    [`node main() { const r = 3..6 }`, `node main() { const r = range(3, 6) }`],
    [`node main() { for (i in 3..6) { print(i) } }`, `node main() { for (i in range(3, 6)) { print(i) } }`],
    [`node main() { f(3..6) }`, `node main() { f(range(3, 6)) }`],
    [`node main() { const r = a..b }`, `node main() { const r = range(a, b) }`],
    [`node main() { const r = -3..6 }`, `node main() { const r = range(-3, 6) }`],
    [`node main() { const r = 5..5 }`, `node main() { const r = range(5, 5) }`],
    [`node main() { const r = 6..3 }`, `node main() { const r = range(6, 3) }`],
  ];

  for (const [range, call] of pairs) {
    it(`parses ${range.trim()} identically to its range() form`, () => {
      expect(program(range)).toEqualWithoutLoc(program(call));
    });
  }

  it("binds looser than additive", () => {
    expect(program(`node main() { const r = a + 1..b - 1 }`))
      .toEqualWithoutLoc(program(`node main() { const r = range(a + 1, b - 1) }`));
  });

  it("binds tighter than relational", () => {
    expect(program(`node main() { const r = x..y == z }`))
      .toEqualWithoutLoc(program(`node main() { const r = range(x, y) == z }`));
  });

  it("normalizes to a range() call when formatted", () => {
    const formatted = formatSource(`node main() { const r = 3..6 }`);
    expect(formatted).toContain("range(3, 6)");
    expect(formatted).not.toContain("..");
  });

  // Number literals carry no `loc` of their own, so `3..6` cannot have one
  // either; variable operands do, and a range over them spans both.
  it("spans its operands when they carry locations", () => {
    const parsed = parseAgency(`node main() { const r = a..b }`, {}, false);
    if (!parsed.success) throw new Error("expected a successful parse");
    const call = (parsed.result.nodes[0] as any).body[0].value;
    expect(call.functionName).toBe("range");
    expect(call.loc.start).toBe(call.arguments[0].loc.start);
    expect(call.loc.end).toBe(call.arguments[1].loc.end);
  });
});

describe("dot runs stay distinct", () => {
  it("spread still parses as a spread", () => {
    expect(JSON.stringify(program(`node main() { const b = [...a, 3] }`))).toContain("splat");
  });

  it("variadic parameters still parse", () => {
    const parsed = parseAgency(`def f(...xs: number[]) { print(xs) }\nnode main() { f(1, 2) }`, {}, false);
    expect(parsed.success).toBe(true);
    expect(JSON.stringify(parsed)).toContain("variadic");
  });

  it("member access still parses", () => {
    expect(JSON.stringify(program(`node main() { const o = { a: 1 }\nprint(o.a) }`)))
      .toContain("valueAccess");
  });
});

describe("bracketed range", () => {
  it("rejects a lone range inside brackets", () => {
    const parsed = parseAgency(`node main() { const r = [3..6] }`, {}, false);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.message).toMatch(/builds an array containing a range/);
  });

  it("names both fixes in the message", () => {
    const parsed = parseAgency(`node main() { const r = [3..6] }`, {}, false);
    if (parsed.success) throw new Error("expected a failed parse");
    expect(parsed.message).toContain("3..6");
    expect(parsed.message).toContain("[(3..6)]");
  });

  it("accepts a parenthesized range as an array element", () => {
    expect(program(`node main() { const r = [(3..6)] }`))
      .toEqualWithoutLoc(program(`node main() { const r = [range(3, 6)] }`));
  });

  it("accepts a hand-written range() call as a lone element", () => {
    expect(parseAgency(`node main() { const r = [range(3, 6)] }`, {}, false).success).toBe(true);
  });

  // The case a text-matching implementation gets wrong: the dots are DATA.
  it("accepts a lone string containing two dots", () => {
    expect(parseAgency(`node main() { const r = ["a..b"] }`, {}, false).success).toBe(true);
    expect(parseAgency(`node main() { const r = [f("a..b")] }`, {}, false).success).toBe(true);
  });

  it("accepts two ranges in one array", () => {
    expect(program(`node main() { const r = [3..6, 8..9] }`))
      .toEqualWithoutLoc(program(`node main() { const r = [range(3, 6), range(8, 9)] }`));
  });

  it("accepts a range alongside another element", () => {
    expect(program(`node main() { const r = [1, 3..6] }`))
      .toEqualWithoutLoc(program(`node main() { const r = [1, range(3, 6)] }`));
  });

  it("leaves comprehensions alone", () => {
    expect(parseAgency(`node main() { const xs = [1, 2]\nconst r = [x * 2 for x in xs] }`, {}, false).success)
      .toBe(true);
  });
});
