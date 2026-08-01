import { describe, it, expect } from "vitest";
import { parseAgency } from "@/parser.js";
import { formatSource } from "@/formatter.js";

function program(src: string) {
  const parsed = parseAgency(src, {}, false);
  if (!parsed.success) throw new Error(`expected a successful parse, got: ${parsed.message}`);
  return parsed.result;
}

function parses(src: string) {
  return parseAgency(src, {}, false).success;
}

describe("arrow functions parse to the canonical block AST", () => {
  it.each([
    [
      "one parenthesized parameter",
      `node main() { const y = map(xs, (n) => n * 2) }`,
      `node main() { const y = map(xs, \\n -> n * 2) }`,
    ],
    [
      "one bare parameter",
      `node main() { const y = map(xs, n => n * 2) }`,
      `node main() { const y = map(xs, \\n -> n * 2) }`,
    ],
    [
      "two parameters",
      `node main() { const y = mapWithIndex(xs, (n, i) => n * i) }`,
      `node main() { const y = mapWithIndex(xs, \\(n, i) -> n * i) }`,
    ],
    [
      "no parameters",
      `node main() { const y = twice(() => 5) }`,
      `node main() { const y = twice(\\ -> 5) }`,
    ],
    [
      "as a named argument",
      `node main() { const y = map(xs, func = (n) => n * 2) }`,
      `node main() { const y = map(xs, func: \\n -> n * 2) }`,
    ],
    // A braced body is the `as` form, not the inline one.
    [
      "a braced body",
      `node main() { const y = map(xs, (n) => { return n * 2 }) }`,
      `node main() { const y = map(xs) as n { return n * 2 } }`,
    ],
    [
      "a braced body with several statements",
      `node main() { const y = map(xs, (n) => { print(n)\nreturn n * 2 }) }`,
      `node main() { const y = map(xs) as n { print(n)\nreturn n * 2 } }`,
    ],
  ])("%s", (_name, arrow, canonical) => {
    expect(program(arrow)).toEqualWithoutLoc(program(canonical));
  });
});

describe("agency fmt normalizes arrow functions", () => {
  it("prints an expression body as an inline block", () => {
    const formatted = formatSource(`node main() { const y = map(xs, (n) => n * 2) }`);
    expect(formatted).toContain("\\n -> n * 2");
    expect(formatted).not.toContain("=>");
  });

  it("prints a braced body as an `as` block", () => {
    const formatted = formatSource(`node main() { const y = map(xs, (n) => { return n * 2 }) }`);
    expect(formatted).toContain("as n {");
    expect(formatted).not.toContain("=>");
  });

  it("formatting twice is a fixed point", () => {
    for (const src of [
      `node main() { const y = map(xs, (n) => n * 2) }`,
      `node main() { const y = map(xs, (n) => { return n * 2 }) }`,
    ]) {
      const once = formatSource(src);
      expect(once).not.toBeNull();
      expect(formatSource(once as string)).toBe(once);
    }
  });
});

describe("things that look like arrows but are not", () => {
  it.each([
    ["a parenthesized argument", `node main() { print((a + b)) }`],
    ["plain arguments", `node main() { f(a, b, c) }`],
    ["nested calls", `node main() { f(g(x), h(y)) }`],
    ["named arguments", `node main() { greet(name: "A", greeting: "B") }`],
    ["a comparison", `node main() { f(a >= b) }`],
    ["an object literal", `node main() { f({ a: 1 }) }`],
    ["a function type in a signature", `def f(cb: (string) -> string) { print(1) }\nnode main() { f(g) }`],
    ["the backslash block form", `node main() { const y = map(xs, \\n -> n * 2) }`],
    ["the as block form", `node main() { const y = map(xs) as n { return n * 2 } }`],
    ["an arrow nested in another call", `node main() { const y = [1, 2]\nprint(map(y, (n) => n + 1)) }`],
  ])("leaves %s alone", (_name, src) => {
    expect(parses(src)).toBe(true);
  });

  // Match arms use `=>` too. The arrow parser only runs in argument position,
  // so the two cannot meet.
  it("leaves match arms alone", () => {
    expect(parses(`node main() { match (x) { 1 => print(1) _ => print(2) } }`)).toBe(true);
  });
});
