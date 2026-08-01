import { describe, it, expect } from "vitest";
import { parseAgency } from "@/parser.js";
import { formatSource } from "@/formatter.js";

function program(src: string) {
  const parsed = parseAgency(src, {}, false);
  if (!parsed.success) throw new Error(`expected a successful parse, got: ${parsed.message}`);
  return parsed.result;
}

/** Each variation and the canonical spelling it must parse identically to. */
const pairs: [string, string, string][] = [
  [
    "interface for type",
    `interface Foo { a: string, b: number }\nnode main() { print(1) }`,
    `type Foo = { a: string, b: number }\nnode main() { print(1) }`,
  ],
  [
    "exported interface",
    `export interface Foo { a: string }\nnode main() { print(1) }`,
    `export type Foo = { a: string }\nnode main() { print(1) }`,
  ],
  [
    "elif for else if",
    `node main() { if (a) { print(1) } elif (b) { print(2) } else { print(3) } }`,
    `node main() { if (a) { print(1) } else if (b) { print(2) } else { print(3) } }`,
  ],
  [
    "named argument with =",
    `node main() { greet(name = "Adit", greeting = "Hi") }`,
    `node main() { greet(name: "Adit", greeting: "Hi") }`,
  ],
  [
    "undefined as a value",
    `node main() { const x = undefined\nprint(x) }`,
    `node main() { const x = null\nprint(x) }`,
  ],
  [
    "undefined in a type",
    `node main() { const x: string | undefined = "a" }`,
    `node main() { const x: string | null = "a" }`,
  ],
  [
    "capitalized primitives",
    `node main() { const s: String = "x"\nconst n: Number = 1\nconst b: Boolean = true }`,
    `node main() { const s: string = "x"\nconst n: number = 1\nconst b: boolean = true }`,
  ],
  [
    "triple single-quoted string",
    `node main() { const s = '''hi there''' }`,
    `node main() { const s = """hi there""" }`,
  ],
  [
    "triple single-quoted with interpolation",
    `node main() { const n = 1\nconst s = '''a \${n} b''' }`,
    `node main() { const n = 1\nconst s = """a \${n} b""" }`,
  ],
];

describe("keyword aliases parse to the canonical AST", () => {
  for (const [name, variation, canonical] of pairs) {
    it(name, () => {
      expect(program(variation)).toEqualWithoutLoc(program(canonical));
    });
  }
});

describe("agency fmt normalizes each alias", () => {
  const expectations: [string, string, string][] = [
    ["interface", `interface Foo { a: string }`, "type Foo = {"],
    ["elif", `node main() { if (a) { print(1) } elif (b) { print(2) } }`, "else if"],
    ["named arg =", `node main() { greet(name = "Adit") }`, `greet(name: "Adit")`],
    ["undefined", `node main() { const x = undefined }`, "null"],
    ["String", `node main() { const s: String = "x" }`, ": string"],
    ["triple single quotes", `node main() { const s = '''hi''' }`, `"""`],
  ];

  for (const [name, src, expected] of expectations) {
    it(`${name} formats to the canonical spelling`, () => {
      expect(formatSource(src)).toContain(expected);
    });
  }

  it("does not leave the alias spelling behind", () => {
    expect(formatSource(`interface Foo { a: String }`)).not.toContain("interface");
    expect(formatSource(`node main() { const x = undefined }`)).not.toContain("undefined");
  });

  it("formatting twice is a fixed point", () => {
    for (const [, src] of expectations) {
      const once = formatSource(src);
      expect(once).not.toBeNull();
      expect(formatSource(once as string)).toBe(once);
    }
  });
});

describe("aliases do not swallow neighbouring syntax", () => {
  it("a type name starting with a primitive word still parses", () => {
    // `str("Number")` would otherwise match the front of `NumberInRange`.
    expect(parseAgency(`type NumberInRange = number\nnode main() { print(1) }`, {}, false).success)
      .toBe(true);
    expect(parseAgency(`type Stringy = string\nnode main() { print(1) }`, {}, false).success)
      .toBe(true);
  });

  it("an identifier starting with `undefined` is untouched", () => {
    const parsed = parseAgency(`node main() { const undefinedThing = 1\nprint(undefinedThing) }`, {}, false);
    expect(parsed.success).toBe(true);
    expect(JSON.stringify(parsed)).toContain("undefinedThing");
  });

  it("`type A number` is still a parse error", () => {
    // The `=` is required for `type`; only `interface` omits it. Making the
    // separator optional for both would silently accept this — it did in a
    // first draft, and broke 123 tests across the compiler.
    expect(parseAgency(`type A number`, {}, false).success).toBe(false);
  });

  it("== is not read as a named-argument separator", () => {
    expect(program(`node main() { if (a == b) { print(1) } }`))
      .toEqualWithoutLoc(program(`node main() { if (a == b) { print(1) } }`));
    expect(parseAgency(`node main() { f(a == b) }`, {}, false).success).toBe(true);
  });

  it("single-quoted strings still parse", () => {
    expect(parseAgency(`node main() { const s = 'hi' }`, {}, false).success).toBe(true);
  });
});
