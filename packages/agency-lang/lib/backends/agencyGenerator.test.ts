import { describe, it, expect } from "vitest";
import { AgencyGenerator } from "./agencyGenerator.js";
import { parseAgency } from "../parser.js";
import { FunctionDefinition } from "../types.js";

describe("AgencyGenerator - Function Parameter Type Hints", () => {
  describe("processFunctionDefinition", () => {
    const testCases = [
      {
        description: "single parameter with type hint",
        input: "def add(x: number) { x }",
        expectedOutput: "def add(x: number) {\nx\n}",
      },
      {
        description: "multiple parameters with type hints",
        input: "def add(x: number, y: number) { x }",
        expectedOutput: "def add(x: number, y: number) {\nx\n}",
      },
      {
        description: "mixed typed and untyped parameters",
        input: "def mixed(x: number, y) { x }",
        expectedOutput: "def mixed(x: number, y) {\nx\n}",
      },
      {
        description: "array type hint",
        input: "def process(items: number[]) { items }",
        expectedOutput: "def process(items: number[]) {\nitems\n}",
      },
      {
        description: "union type hint",
        input: "def flexible(value: string | number) { value }",
        expectedOutput: "def flexible(value: string | number) {\nvalue\n}",
      },
      {
        description: "type hint with docstring",
        input:
          'def add(x: number, y: number) {\n  """Adds two numbers"""\n  x\n}',
        expectedOutput:
          'def add(x: number, y: number) {\n  """\n  Adds two numbers\n  """\nx\n}',
      },
      {
        description: "multiple array types",
        input: "def multi(arr: string[], count: number) { arr }",
        expectedOutput: "def multi(arr: string[], count: number) {\narr\n}",
      },
      {
        description: "nested array type",
        input: "def nested(matrix: number[][]) { matrix }",
        expectedOutput: "def nested(matrix: number[][]) {\nmatrix\n}",
      },
      {
        description: "custom type name",
        input: "def handle(data: CustomType) { data }",
        expectedOutput: "def handle(data: CustomType) {\ndata\n}",
      },
      {
        description: "untyped parameters (backward compatibility)",
        input: "def old(x, y) { x }",
        expectedOutput: "def old(x, y) {\nx\n}",
      },
      {
        description: "utility type hint is preserved as written",
        input: "def patch(c: Partial<User>) { c }",
        expectedOutput: "def patch(c: Partial<User>) {\nc\n}",
      },
      {
        description: "Pick with a literal-union key argument",
        input: 'def contact(c: Pick<User, "name" | "email">) { c }',
        expectedOutput: 'def contact(c: Pick<User, "name" | "email">) {\nc\n}',
      },

      {
        description: "keyof type hint round-trips",
        input: "def f(k: keyof User) { k }",
        expectedOutput: "def f(k: keyof User) {\nk\n}",
      },
      {
        description: "indexed access type hint round-trips",
        input: 'def f(x: User["name"]) { x }',
        expectedOutput: 'def f(x: User["name"]) {\nx\n}',
      },
      {
        description: "array-of-keyof keeps its parens (distinct from keyof-of-array)",
        input: "def f(k: (keyof User)[]) { k }",
        expectedOutput: "def f(k: (keyof User)[]) {\nk\n}",
      },
      {
        description: "keyof-of-array stays unparenthesized",
        input: "def f(k: keyof User[]) { k }",
        expectedOutput: "def f(k: keyof User[]) {\nk\n}",
      },
      {
        description: "keyof of a union keeps its parens",
        input: "def f(k: keyof (A | B)) { k }",
        expectedOutput: "def f(k: keyof (A | B)) {\nk\n}",
      },
      {
        description: "indexed access on a union keeps its parens",
        input: 'def f(x: (A | B)["k"]) { x }',
        expectedOutput: 'def f(x: (A | B)["k"]) {\nx\n}',
      },

      {
        description: "intersection round-trips",
        input: "def f(x: A & B) { x }",
        expectedOutput: "def f(x: A & B) {\nx\n}",
      },
      {
        description: "intersection inside a union round-trips without parens",
        input: "def f(x: A & B | C) { x }",
        expectedOutput: "def f(x: A & B | C) {\nx\n}",
      },
      {
        description: "union operand keeps its parens under intersection",
        input: "def f(x: (A | B) & C) { x }",
        expectedOutput: "def f(x: (A | B) & C) {\nx\n}",
      },
      {
        description: "intersection operand keeps parens under keyof",
        input: "def f(x: keyof (A & B)) { x }",
        expectedOutput: "def f(x: keyof (A & B)) {\nx\n}",
      },
      {
        description: "intersection element keeps parens under array suffix",
        input: "def f(x: (A & B)[]) { x }",
        expectedOutput: "def f(x: (A & B)[]) {\nx\n}",
      },
      {
        description: "intersection object keeps parens under indexed access",
        input: 'def f(x: (A & B)["id"]) { x }',
        expectedOutput: 'def f(x: (A & B)["id"]) {\nx\n}',
      },

      {
        description: "schema chaining round-trips (issue #480)",
        input: 'def f(x: string) { const r = schema(number).parseJSON(x) }',
        expectedOutput: 'def f(x: string) {\n  const r = schema(number).parseJSON(x)\n}',
      },
    ];

    testCases.forEach(({ description, input, expectedOutput }) => {
      it(`should correctly generate ${description}`, () => {
        const parseResult = parseAgency(input, {}, false);
        expect(parseResult.success).toBe(true);

        if (!parseResult.success) return;

        const generator = new AgencyGenerator();
        const result = generator.generate(parseResult.result);

        // Normalize whitespace for comparison
        const normalizedOutput = result.output.trim();
        const normalizedExpected = expectedOutput.trim();

        expect(normalizedOutput).toBe(normalizedExpected);
      });
    });
  });

  describe("Type preservation", () => {
    it("preserves an intersection in a type alias declaration", () => {
      const parseResult = parseAgency("type Person = Named & Aged", {}, false);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("Named & Aged");
    });

    it("preserves keyof and indexed access in alias declarations", () => {
      const parseResult = parseAgency(
        'type F = keyof User\ntype N = User["name"]',
        {},
        false,
      );
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("keyof User");
      expect(result.output).toContain('User["name"]');
    });

    it("preserves a utility type in a type alias declaration", () => {
      const parseResult = parseAgency("type UserPatch = Partial<User>", {}, false);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      // toContain is deliberate — pins survival of the written form without
      // coupling to whitespace canonicalization.
      expect(result.output).toContain("Partial<User>");
    });

    it("should preserve primitive types", () => {
      const input = "def test(n: number, s: string, b: boolean) { n }";
      const parseResult = parseAgency(input, {}, false);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("n: number");
      expect(result.output).toContain("s: string");
      expect(result.output).toContain("b: boolean");
    });

    it("should preserve array types", () => {
      const input = "def test(nums: number[], strs: string[]) { nums }";
      const parseResult = parseAgency(input, {}, false);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("nums: number[]");
      expect(result.output).toContain("strs: string[]");
    });

    it("should preserve union types", () => {
      const input = "def test(val: string | number | boolean) { val }";
      const parseResult = parseAgency(input, {}, false);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("val: string | number | boolean");
    });

    it("should preserve nested array types", () => {
      const input = "def test(matrix: number[][]) { matrix }";
      const parseResult = parseAgency(input, {}, false);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("matrix: number[][]");
    });
  });

  describe("Mixed typed and untyped parameters", () => {
    it("should handle first parameter typed, second untyped", () => {
      const input = "def test(x: number, y) { x }";
      const parseResult = parseAgency(input, {}, false);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("x: number");
      expect(result.output).toContain(", y)");
      expect(result.output).not.toContain("y:");
    });

    it("should handle first parameter untyped, second typed", () => {
      const input = "def test(x, y: string) { x }";
      const parseResult = parseAgency(input, {}, false);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("y: string");
      expect(result.output).toMatch(/test\(x,/);
      expect(result.output).not.toContain("x:");
    });

    it("should handle alternating typed and untyped parameters", () => {
      const input = "def test(a, b: number, c, d: string) { a }";
      const parseResult = parseAgency(input, {}, false);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("b: number");
      expect(result.output).toContain("d: string");
      expect(result.output).not.toContain("a:");
      expect(result.output).not.toContain("c:");
    });
  });
});

describe("AgencyGenerator - new expressions", () => {
  function formatAgency(input: string): string {
    const parseResult = parseAgency(input, {}, false);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return "";
    const generator = new AgencyGenerator();
    return generator.generate(parseResult.result).output.trim();
  }

  it("should format `new Foo(args)` expressions", () => {
    const input = `node main() {
  let c = new Counter(0)
}`;
    const output = formatAgency(input);
    expect(output).toContain("new Counter(0)");
  });

  it("rejects `class` definitions with an actionable error", () => {
    const input = `class User {
  name: string
}`;
    const parseResult = parseAgency(input, {}, false);
    expect(parseResult.success).toBe(false);
    // Lock in the migration hint so a future regression that drops back to
    // a generic "expected ... 'class' ..." error fails this test.
    if (!parseResult.success) {
      expect(parseResult.message).toMatch(/no longer supported/i);
      expect(parseResult.message).toMatch(/new Foo/);
    }
  });

  // Whitespace tolerance — the reservedClassParser probe must fire on
  // common formatting variants so migrators always see the actionable
  // error, not a downstream "unexpected token" surprise.
  for (const sep of ["  ", "\t", " \t "]) {
    it(`rejects \`class${JSON.stringify(sep)}Foo\` (whitespace variant)`, () => {
      const parseResult = parseAgency(
        `class${sep}User {\n  name: string\n}`,
        {},
        false,
      );
      expect(parseResult.success).toBe(false);
      if (!parseResult.success) {
        expect(parseResult.message).toMatch(/no longer supported/i);
      }
    });
  }
});

describe("AgencyGenerator - Doc Comments", () => {
  function formatAgency(input: string): string {
    const parseResult = parseAgency(input, {}, false);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return "";
    const generator = new AgencyGenerator();
    return generator.generate(parseResult.result).output.trim();
  }

  it("should preserve /** syntax for doc comments", () => {
    const input = `/** This is a doc comment */\ndef foo() {\n  print("hi")\n}`;
    const output = formatAgency(input);
    expect(output).toContain("/** This is a doc comment */");
  });

  it("should preserve /* syntax for regular multi-line comments", () => {
    const input = `/* This is a regular comment */\ndef foo() {\n  print("hi")\n}`;
    const output = formatAgency(input);
    expect(output).toContain("/* This is a regular comment */");
    expect(output).not.toContain("/**");
  });

  it("should preserve multi-line doc comments", () => {
    const input = `/**\nThis is a multi-line\ndoc comment\n*/\ndef foo() {\n  print("hi")\n}`;
    const output = formatAgency(input);
    expect(output).toContain("/**");
    expect(output).toContain("This is a multi-line");
  });

  it("should round-trip node docstrings", () => {
    const input = `node main() {\n  """Main entry point."""\n  print("hello")\n}`;
    const output = formatAgency(input);
    expect(output).toContain('"""');
    expect(output).toContain("Main entry point.");
  });
});

describe("AgencyGenerator - object property tags", () => {
  function formatAgency(input: string): string {
    const parseResult = parseAgency(input, {}, false);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return "";
    const generator = new AgencyGenerator();
    return generator.generate(parseResult.result).output.trim();
  }

  it("preserves @validate and @jsonSchema annotations on type properties", () => {
    const input = `type Person = {
  name: string;

  @validate(isPositive)
  @jsonSchema({ minimum: 1 })
  age: number
}`;
    const output = formatAgency(input);
    expect(output).toContain("@validate(isPositive)");
    // Object-literal tag arguments render however the shared literal
    // formatter decides (currently multi-line); assert preservation of the
    // annotation and its contents, not the exact layout.
    expect(output).toContain("@jsonSchema(");
    expect(output).toContain("minimum: 1");
  });

  it("round-trips property tags without dropping them", () => {
    const input = `type Person = {
  @validate(isPositive)
  age: number
}`;
    // Formatting twice must be stable and must retain the annotation.
    const once = formatAgency(input);
    const twice = formatAgency(once);
    expect(once).toContain("@validate(isPositive)");
    expect(twice).toBe(once);
  });
});

describe("AgencyGenerator - optimize modifier", () => {
  function formatAgency(input: string): string {
    const parseResult = parseAgency(input, {}, false);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return "";
    const generator = new AgencyGenerator();
    return generator.generate(parseResult.result).output.trim();
  }

  it("formats optimize const", () => {
    expect(formatAgency('optimize const prompt = "hi"')).toBe('optimize const prompt = "hi"');
  });

  it("formats optimize let", () => {
    expect(formatAgency('optimize let prompt = "hi"')).toBe('optimize let prompt = "hi"');
  });

  it("formats optimize static const in canonical order", () => {
    expect(formatAgency('optimize static const prompt = "hi"')).toBe('optimize static const prompt = "hi"');
  });
});

describe("AgencyGenerator - bang (!) validated type annotations", () => {
  function formatAgency(input: string): string {
    const parseResult = parseAgency(input, {}, false);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return "";
    const generator = new AgencyGenerator();
    return generator.generate(parseResult.result).output.trim();
  }

  it("should preserve ! on assignment type annotations", () => {
    const input = `node main() {\n  const x: number! = 42\n}`;
    const output = formatAgency(input);
    expect(output).toContain("const x: number! = 42");
  });

  it("should preserve ! on function parameter types", () => {
    const input = `def process(data: number!) {\n  print(data)\n}`;
    const output = formatAgency(input);
    expect(output).toContain("data: number!");
  });

  it("should preserve ! on function return types", () => {
    const input = `def process(x: number): string! {\n  return x\n}`;
    const output = formatAgency(input);
    expect(output).toContain("): string!");
  });

  it("should preserve ! on node return types", () => {
    const input = `node main(): number! {\n  return 42\n}`;
    const output = formatAgency(input);
    expect(output).toContain("(): number!");
  });

  it("should not add ! when not present", () => {
    const input = `node main() {\n  const x: number = 42\n}`;
    const output = formatAgency(input);
    expect(output).toContain("const x: number = 42");
    expect(output).not.toContain("number!");
  });
});

describe("AgencyGenerator - Result type formatting", () => {
  function formatAgency(input: string): string {
    const parseResult = parseAgency(input, {}, false);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return "";
    const generator = new AgencyGenerator();
    return generator.generate(parseResult.result).output.trim();
  }

  it("should format Result<Foo> with single type param", () => {
    const input = `def check(): Result<number> {\n  return success(42)\n}`;
    const output = formatAgency(input);
    expect(output).toContain("Result<number>");
    expect(output).not.toContain("Result<number,");
  });

  it("should format bare Result without type params", () => {
    const input = `def check(): Result {\n  return success(42)\n}`;
    const output = formatAgency(input);
    expect(output).toContain(": Result");
    expect(output).not.toContain("Result<");
  });

  it("should format Result<Foo, Bar> with non-default failure type", () => {
    const input = `def check(): Result<number, number> {\n  return success(42)\n}`;
    const output = formatAgency(input);
    expect(output).toContain("Result<number, number>");
  });

  it("should normalize Result<Foo, string> to Result<Foo>", () => {
    const input = `def check(): Result<number, string> {\n  return success(42)\n}`;
    const output = formatAgency(input);
    expect(output).toContain("Result<number>");
    expect(output).not.toContain("Result<number, string>");
  });
});

describe("AgencyGenerator - object type formatting", () => {
  function formatAgency(input: string): string {
    const parseResult = parseAgency(input, {}, false);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return "";
    const generator = new AgencyGenerator();
    return generator.generate(parseResult.result).output.trim();
  }

  it("should format object type as 'object' not 'Record<string, any>'", () => {
    const input = `def process(data: object) {\n  print(data)\n}`;
    const output = formatAgency(input);
    expect(output).toContain("data: object");
    expect(output).not.toContain("Record<string, any>");
  });

  it("should format object type in type aliases", () => {
    const input = `type NextStep = { type: "showPolicy"; policy: object }`;
    const output = formatAgency(input);
    expect(output).toContain("policy: object");
    expect(output).not.toContain("Record<string, any>");
  });

  it("should format object type in union type aliases", () => {
    const input = `type NextStep =\n  | { type: "showPolicy"; policy: object }\n  | { type: "writePolicy"; policy: object }`;
    const output = formatAgency(input);
    expect(output).toContain("policy: object");
    expect(output).not.toContain("Record<string, any>");
  });

  it("should format object type in variable declarations", () => {
    const input = `node main() {\n  const x: object = {}\n}`;
    const output = formatAgency(input);
    expect(output).toContain("const x: object");
    expect(output).not.toContain("Record<string, any>");
  });

  it("should format object type in return types", () => {
    const input = `def getData(): object {\n  return {}\n}`;
    const output = formatAgency(input);
    expect(output).toContain("): object");
    expect(output).not.toContain("Record<string, any>");
  });

  it("should format object type in node return types", () => {
    const input = `node main(): object {\n  return {}\n}`;
    const output = formatAgency(input);
    expect(output).toContain("(): object");
    expect(output).not.toContain("Record<string, any>");
  });

  it("should format object[] array type", () => {
    const input = `def process(items: object[]) {\n  print(items)\n}`;
    const output = formatAgency(input);
    expect(output).toContain("items: object[]");
    expect(output).not.toContain("Record<string, any>");
  });

  it("should format object type in schema expressions", () => {
    const input = `node main() {\n  const s = schema(object)\n}`;
    const output = formatAgency(input);
    expect(output).toContain("schema(object)");
    expect(output).not.toContain("Record<string, any>");
  });
});

describe("AgencyGenerator - schema(Type) expressions", () => {
  function formatAgency(input: string): string {
    const parseResult = parseAgency(input, {}, false);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return "";
    const generator = new AgencyGenerator();
    return generator.generate(parseResult.result).output.trim();
  }

  it("should format schema(number)", () => {
    const input = `node main() {\n  const s = schema(number)\n}`;
    const output = formatAgency(input);
    expect(output).toContain("schema(number)");
  });

  it("should format schema(Result<number>)", () => {
    const input = `node main() {\n  const s = schema(Result<number>)\n}`;
    const output = formatAgency(input);
    expect(output).toContain("schema(Result<number>)");
  });
});

describe("AgencyGenerator - string interpolation with nested calls", () => {
  function formatAgency(input: string): string {
    const parseResult = parseAgency(input, {}, false);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return "";
    const generator = new AgencyGenerator();
    return generator.generate(parseResult.result).output.trim();
  }

  it("preserves inline block arguments inside a string interpolation", () => {
    // The interpolation expression is a function call whose second argument
    // is an inline block (`\k -> ...`). Previously the generator routed
    // through expressionToString, which knows nothing about block args,
    // so the block silently disappeared from the output.
    const input = `node main() {\n  let s = "x: " + map(arr, \\k -> k).join(",")\n}`;
    const output = formatAgency(input);
    expect(output).toContain("\\k -> k");
    expect(output).toContain('.join(",")');
  });

  it("preserves quoted string arguments inside a string interpolation", () => {
    // expressionToString rendered string literals without their quotes,
    // so `.join("")` collapsed to `.join()`.
    const input = `node main() {\n  let s = "x: " + arr.join("")\n}`;
    const output = formatAgency(input);
    expect(output).toContain('.join("")');
  });
});

describe("AgencyGenerator - Result Patterns", () => {
  // Format with lowering DISABLED so raw `resultPattern` nodes reach the
  // formatter (the formatter operates on the un-lowered AST).
  function formatAgency(input: string): string {
    const parseResult = parseAgency(input, {}, false, false);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return "";
    const generator = new AgencyGenerator();
    return generator.generate(parseResult.result).output.trim();
  }

  // Round-trip parses → formats → parses and compares the resulting AST
  // (modulo `loc`). This is the strongest possible check: it catches both
  // missing output and *extra* output, which `toContain` would miss.
  function expectRoundTripStable(input: string): void {
    const formatted = formatAgency(input);
    const reparsed = parseAgency(formatted, {}, false, false);
    expect(reparsed.success).toBe(true);
    if (!reparsed.success) return;
    const firstParse = parseAgency(input, {}, false, false);
    expect(firstParse.success).toBe(true);
    if (!firstParse.success) return;
    // Strip `loc` fields recursively so we compare structure only.
    const stripLoc = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(stripLoc);
      if (node && typeof node === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node)) {
          if (k === "loc") continue;
          out[k] = stripLoc(v);
        }
        return out;
      }
      return node;
    };
    expect(stripLoc(reparsed.result.nodes)).toEqual(
      stripLoc(firstParse.result.nodes),
    );
  }

  it("formats `r is success` (bare boolean form) — round trip", () => {
    const input = `node main() {\n  let r = success(1)\n  let x = r is success\n}`;
    const output = formatAgency(input);
    expect(output).toContain("r is success");
    expect(output).not.toContain("isSuccess");
    expectRoundTripStable(input);
  });

  it("formats `r is failure` (bare boolean form) — round trip", () => {
    const input = `node main() {\n  let r = failure("e")\n  let x = r is failure\n}`;
    const output = formatAgency(input);
    expect(output).toContain("r is failure");
    expect(output).not.toContain("isFailure");
    expectRoundTripStable(input);
  });

  it("formats `r is success(v)` with binding — round trip", () => {
    const input = `node main() {\n  let r = success(1)\n  if (r is success(v)) {\n    print(v)\n  }\n}`;
    const output = formatAgency(input);
    expect(output).toContain("r is success(v)");
    expectRoundTripStable(input);
  });

  it("formats `r is failure(e)` with binding — round trip", () => {
    const input = `node main() {\n  let r = failure("e")\n  if (r is failure(e)) {\n    print(e)\n  }\n}`;
    const output = formatAgency(input);
    expect(output).toContain("r is failure(e)");
    expectRoundTripStable(input);
  });

  it("formats result patterns as match arm LHS — round trip", () => {
    const input = `node main() {\n  let r = success(1)\n  match (r) {\n    success(v) => print(v)\n    failure(e) => print(e)\n  }\n}`;
    const output = formatAgency(input);
    expect(output).toContain("success(v)");
    expect(output).toContain("failure(e)");
    expectRoundTripStable(input);
  });

  it("formats result patterns nested inside an array match pattern — round trip", () => {
    const input = `node main() {\n  let arr = [success(1), failure("e")]\n  match (arr) {\n    [success(v), _] => print(v)\n    _ => print("none")\n  }\n}`;
    const output = formatAgency(input);
    expect(output).toContain("[success(v), _]");
    expectRoundTripStable(input);
  });
});

describe("AgencyGenerator - preserveOrder mode", () => {
  function formatPreserveOrder(input: string): string {
    const parseResult = parseAgency(input, {}, false);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return "";
    const generator = new AgencyGenerator({ preserveOrder: true });
    return generator.generate(parseResult.result).output.trim();
  }

  it("does not sort imports alphabetically", () => {
    const input = `import { zebra } from "z"\nimport { apple } from "a"\n`;
    const output = formatPreserveOrder(input);
    expect(output.indexOf("zebra")).toBeLessThan(output.indexOf("apple"));
  });

  it("does not hoist mid-file imports to the top", () => {
    const input = `def first(): number { return 1 }\n\nimport { later } from "wherever"\n\ndef second(): number { return 2 }\n`;
    const output = formatPreserveOrder(input);
    const firstIdx = output.indexOf("def first");
    const importIdx = output.indexOf('import { later }');
    const secondIdx = output.indexOf("def second");
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(importIdx).toBeGreaterThan(firstIdx);
    expect(secondIdx).toBeGreaterThan(importIdx);
  });
});

describe("AgencyGenerator - string escape round-tripping", () => {
  // For each test we parse a `let s = "<source>"` declaration, emit
  // it through the generator, parse the emitted output again, and
  // confirm the second parse produces the same string value as the
  // first. This guards against codegen producing source that the
  // parser would mis-interpret (e.g. forgetting to escape `\` so
  // `"\\"` parses as `\` the first time and as a syntax error the
  // second time).
  const cases = [
    { name: "embedded double-quote",   source: '"a\\"b"',       value: 'a"b' },
    { name: "embedded backslash",      source: '"a\\\\b"',      value: 'a\\b' },
    { name: "newline / tab",           source: '"x\\ny\\tz"',   value: 'x\ny\tz' },
    { name: "escaped interpolation",   source: '"\\${foo}"',    value: '${foo}' },
    { name: "plain dollar sign",       source: '"$5"',          value: '$5' },
    { name: "backtick allowed inline", source: '"a`b"',         value: 'a`b' },
  ];

  cases.forEach(({ name, source, value }) => {
    it(`round-trips: ${name}`, () => {
      const input = `let s = ${source}`;

      const r1 = parseAgency(input, {}, false);
      expect(r1.success, "first parse").toBe(true);
      if (!r1.success) return;

      const gen = new AgencyGenerator();
      const emitted = gen.generate(r1.result).output;

      const r2 = parseAgency(emitted, {}, false);
      expect(r2.success, `second parse of ${JSON.stringify(emitted)}`).toBe(
        true,
      );
      if (!r2.success) return;

      // Extract the string literal from both parses and compare its
      // text-segment value. The parsed value should match what the
      // test asked for, both before and after the round trip.
      const stringOf = (program: { nodes: unknown[] }): string | null => {
        const assignment = program.nodes.find(
          (n: any) => n?.type === "assignment",
        ) as { value?: { type?: string; segments?: { type: string; value?: string }[] } } | undefined;
        if (assignment?.value?.type !== "string") return null;
        const segs = assignment.value.segments ?? [];
        if (segs.length === 0) return "";
        if (segs.length !== 1 || segs[0].type !== "text") return null;
        return segs[0].value ?? "";
      };

      expect(stringOf(r1.result), "first-parse value").toBe(value);
      expect(stringOf(r2.result), "round-tripped value").toBe(value);
    });
  });
});

describe("AgencyGenerator - multi-line string escape round-tripping", () => {
  // A parsed literal `${...}` (written `\${...}` in a triple-quoted string) must
  // survive emit + re-parse as a literal text segment, not silently become a
  // live interpolation. Other raw content (a literal `\n`) must stay raw.
  const cases = [
    { name: "escaped interpolation only", source: '"""a \\${x} b"""' },
    { name: "raw backslash-n stays raw", source: '"""raw \\n text"""' },
    { name: "real interp next to escaped", source: '"""hi ${name} lit \\${skip}"""' },
  ];

  const segsOf = (program: { nodes: unknown[] }) => {
    const a = program.nodes.find((n: any) => n?.type === "assignment") as
      | { value?: { type?: string; segments?: any[] } }
      | undefined;
    if (a?.value?.type !== "multiLineString") return null;
    return (a.value.segments ?? []).map((s: any) =>
      s.type === "text"
        ? { type: "text", value: s.value }
        : { type: "interpolation", name: s.expression?.value },
    );
  };

  cases.forEach(({ name, source }) => {
    it(`round-trips: ${name}`, () => {
      const r1 = parseAgency(`let s = ${source}`, {}, false);
      expect(r1.success, "first parse").toBe(true);
      if (!r1.success) return;

      const emitted = new AgencyGenerator().generate(r1.result).output;

      const r2 = parseAgency(emitted, {}, false);
      expect(r2.success, `re-parse of ${JSON.stringify(emitted)}`).toBe(true);
      if (!r2.success) return;

      const segs1 = segsOf(r1.result);
      expect(segs1, "first parse produced a multi-line string").not.toBeNull();
      expect(segsOf(r2.result)).toEqual(segs1);
    });
  });
});

describe("AgencyGenerator - string delimiter round-tripping", () => {
  // Emit, parse, and check that (a) the emitted source is exactly the
  // input source (no delimiter rewrite, no needless escapes) and (b)
  // the re-parsed text value matches the original.
  const cases = [
    {
      name: "backtick string containing double quote",
      source: '`she said "hi"`',
      value: 'she said "hi"',
    },
    {
      name: "double-quoted string containing backtick",
      source: '"she said `hi`"',
      value: "she said `hi`",
    },
    {
      name: "single-quoted string containing the other two delimiters",
      source: '\'she said "hi" and `hi`\'',
      value: 'she said "hi" and `hi`',
    },
    {
      name: "backtick string with an escaped backtick",
      source: "`with a \\` escaped backtick`",
      value: "with a ` escaped backtick",
    },
    {
      name: "single-quoted string with an escaped single quote",
      source: "'it\\'s fine'",
      value: "it's fine",
    },
  ];

  cases.forEach(({ name, source, value }) => {
    it(`round-trips: ${name}`, () => {
      const input = `let s = ${source}`;

      const r1 = parseAgency(input, {}, false);
      expect(r1.success, "first parse").toBe(true);
      if (!r1.success) return;

      const gen = new AgencyGenerator();
      const emitted = gen.generate(r1.result).output;

      // The emitted assignment line should contain the original source
      // verbatim — the formatter must not rewrite the delimiter.
      expect(emitted).toContain(source);

      const r2 = parseAgency(emitted, {}, false);
      expect(r2.success, `second parse of ${JSON.stringify(emitted)}`).toBe(true);
      if (!r2.success) return;

      const stringOf = (program: { nodes: unknown[] }): string | null => {
        const assignment = program.nodes.find(
          (n: any) => n?.type === "assignment",
        ) as { value?: { type?: string; segments?: { type: string; value?: string }[] } } | undefined;
        if (assignment?.value?.type !== "string") return null;
        const segs = assignment.value.segments ?? [];
        if (segs.length === 0) return "";
        if (segs.length !== 1 || segs[0].type !== "text") return null;
        return segs[0].value ?? "";
      };

      expect(stringOf(r1.result), "first-parse value").toBe(value);
      expect(stringOf(r2.result), "round-tripped value").toBe(value);
    });
  });

  it("synthesized literals (no delimiter field) format as \"...\"", () => {
    const gen = new AgencyGenerator();
    const synth = {
      type: "string" as const,
      segments: [{ type: "text" as const, value: "hello" }],
    };
    // Reach into the same path the public emitter would. processNode is
    // the generic dispatch in AgencyGenerator.
    const out = (gen as any).processNode(synth);
    expect(out).toBe('"hello"');
  });
});

describe("AgencyGenerator - optional key shorthand (nullish unification)", () => {
  it("round-trips an optional key as key?: T", () => {
    const parseResult = parseAgency("type Foo = { foo?: string }", {}, false);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const generator = new AgencyGenerator();
    const result = generator.generate(parseResult.result);

    expect(result.output).toContain("foo?: string");
    expect(result.output).not.toContain("string | null");
  });
});

describe("AgencyGenerator - literal comment trivia (issue #317)", () => {
  const roundTrip = (input: string): string => {
    const parseResult = parseAgency(input, {}, false);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) throw new Error("parse failed");
    const generator = new AgencyGenerator();
    return generator.generate(parseResult.result).output;
  };

  it("preserves a line comment between object-literal entries", () => {
    const input = `const policy = {
  "a": 1,
  // keep me
  "b": 2
}`;
    expect(roundTrip(input)).toContain("// keep me");
  });

  it("preserves a line comment between array-literal items", () => {
    const input = `const xs = [
  1,
  // keep me
  2
]`;
    expect(roundTrip(input)).toContain("// keep me");
  });

  it("preserves a block comment between object-literal entries", () => {
    const input = `const policy = {
  "a": 1,
  /* keep me */
  "b": 2
}`;
    expect(roundTrip(input)).toContain("/* keep me */");
  });

  it("is idempotent: formatting the formatted output is a fixed point", () => {
    const input = `const policy = {
  "a": 1,
  // keep me
  "b": 2
}`;
    const once = roundTrip(input);
    const twice = roundTrip(once);
    expect(twice).toBe(once);
  });
});

describe("AgencyGenerator - test-only imports", () => {
  it("preserves the test keyword when formatting an import test statement", () => {
    const parseResult = parseAgency('import test { foo } from "std::x"', {}, false);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const generator = new AgencyGenerator();
    const result = generator.generate(parseResult.result);

    expect(result.output).toContain('import test { foo } from "std::x"');
  });

  it("does not emit the test keyword for a normal import", () => {
    const parseResult = parseAgency('import { foo } from "std::x"', {}, false);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const generator = new AgencyGenerator();
    const result = generator.generate(parseResult.result);

    expect(result.output).toContain('import { foo } from "std::x"');
    expect(result.output).not.toContain("import test");
  });
});
