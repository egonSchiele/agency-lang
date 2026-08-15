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

  it.each([
    [
      "typed parameters",
      `node main() { const y = map(xs, (n: number) => n * 2) }`,
      `node main() { const y = map(xs, \\(n: number) -> n * 2) }`,
    ],
    [
      "multiple parameters with a braced body",
      `node main() { const y = mapWithIndex(xs, (n, i) => { return n * i }) }`,
      `node main() { const y = mapWithIndex(xs) as (n, i) { return n * i } }`,
    ],
    // Prettier wraps an arrow whose body passes the line limit, so this is a
    // shape models produce. The canonical `\\n ->` form still does not accept
    // it; this deliberately goes further, since meeting that habit is the point.
    [
      "a body on the next line",
      `node main() { const r = map(items, (item) =>\n  item * 2\n) }`,
      `node main() { const r = map(items, \\item -> item * 2) }`,
    ],
    // `async` is accepted and discarded, like `await` and `sync`.
    [
      "an async arrow",
      `node main() { const y = map(xs, async (n) => n * 2) }`,
      `node main() { const y = map(xs, \\n -> n * 2) }`,
    ],
  ])("%s", (_name, arrow, canonical) => {
    expect(program(arrow)).toEqualWithoutLoc(program(canonical));
  });

  // JavaScript famously reads these braces as a block. Here `braced` tries
  // first, `bodyParser` declines, and it falls through to `exprParser`, which
  // reads an object literal. Pinned because it depends on that ordering.
  it("reads a braced object literal body as an object, not a block", () => {
    expect(program(`node main() { const y = f((n) => { a: 1 }) }`)).toEqualWithoutLoc(
      program(`node main() { const y = f(\\n -> { a: 1 }) }`),
    );
  });

  it("requires `()` for a zero-parameter arrow", () => {
    // `blockParamsParser` returns an empty list without consuming, so a bare
    // `=>` would otherwise read as a zero-parameter block.
    expect(parses(`node main() { f(=> 1) }`)).toBe(false);
    expect(parses(`node main() { f(() => 1) }`)).toBe(true);
    // The canonical zero-parameter form is unaffected.
    expect(parses(`node main() { f(\\ -> 1) }`)).toBe(true);
  });

  // A block is not a value, so it cannot be a block's body either. The
  // canonical form behaves identically; pinned so a reorder cannot change it
  // silently.
  it("does not support currying", () => {
    expect(parses(`node main() { const y = map(xs, (a) => (b) => a + b) }`)).toBe(false);
    expect(parses(`node main() { const y = map(xs, \\a -> \\b -> a + b) }`)).toBe(false);
  });
});

describe("a block assigned to a variable gets a message, not the catch-all", () => {
  it.each([
    ["the arrow spelling", `node main() { const double = (n) => n * 2 }`],
    ["the canonical spelling", `node main() { const double = \\n -> n * 2 }`],
    ["let rather than const", `node main() { let double = (n) => n * 2 }`],
    ["an async arrow", `node main() { const double = async (n) => n * 2 }`],
  ])("catches %s", (_name, src) => {
    const parsed = parseAgency(src, {}, false);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.message).toMatch(/blocks are arguments, not values/);
    expect(parsed.message).toContain("def double");
  });

  it("leaves an ordinary assignment alone", () => {
    expect(parses(`node main() { const double = 2 }`)).toBe(true);
    expect(parses(`node main() { const f = someFn }`)).toBe(true);
    expect(parses(`node main() { const eq = a == b }`)).toBe(true);
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
    [
      "a function type in a signature",
      `def f(cb: (string) -> string) { print(1) }\nnode main() { f(g) }`,
    ],
    ["the backslash block form", `node main() { const y = map(xs, \\n -> n * 2) }`],
    ["the as block form", `node main() { const y = map(xs) as n { return n * 2 } }`],
    [
      "an arrow nested in another call",
      `node main() { const y = [1, 2]\nprint(map(y, (n) => n + 1)) }`,
    ],
  ])("leaves %s alone", (_name, src) => {
    expect(parses(src)).toBe(true);
  });

  // Match arms use `=>` too. The arrow parser only runs in argument position,
  // so the two cannot meet.
  it("leaves match arms alone", () => {
    expect(parses(`node main() { match (x) { 1 => print(1) _ => print(2) } }`)).toBe(true);
  });
});
