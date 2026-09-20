import { describe, expect, it } from "vitest";
import { parseAgency } from "../parser.js";
import { formatSource } from "../formatter.js";

/** The value of `const r = <expr>` inside a node, or the failure. */
function parseValue(expr: string) {
  const result = parseAgency(`node main() {\n  const r = ${expr}\n}\n`, {}, false);
  if (!result.success) {
    return result;
  }
  const mainNode = result.result.nodes.find((node: any) => node.type === "graphNode") as any;
  const statements = mainNode.body.filter((statement: any) => statement.type !== "newLine");
  return { success: true as const, statements, value: statements[0].value };
}

const cast = (expression: unknown, targetType: unknown, checked = false) => ({
  type: "castExpression",
  expression,
  targetType,
  checked,
});
const variable = (value: string) => ({ type: "variableName", value });
const alias = (aliasName: string) => ({ type: "typeAliasVariable", aliasName });

describe("cast versus block after a call", () => {
  it("as { name: string } is a cast to an object type", () => {
    const parsed = parseValue("foo() as { name: string }") as any;
    expect(parsed.success).toBe(true);
    expect(parsed.value.type).toBe("castExpression");
    expect(parsed.value.targetType.type).toBe("objectType");
    expect(parsed.statements).toHaveLength(1);
  });

  it("a multi-line object type is a cast", () => {
    const parsed = parseValue("raw as {\n    name: string\n  }") as any;
    expect(parsed.value.type).toBe("castExpression");
  });

  it("an object type with a comment before its first key is a cast", () => {
    const parsed = parseValue("raw as {\n    // the name\n    name: string\n  }") as any;
    expect(parsed.value.type).toBe("castExpression");
  });

  it("an object type whose first member carries a tag is a cast", () => {
    const parsed = parseValue("raw as {\n    @validate(isEmail)\n    email: string\n  }") as any;
    expect(parsed.value.type).toBe("castExpression");
  });

  it("an optional key still reads as an object type", () => {
    const parsed = parseValue("raw as { name?: string }") as any;
    expect(parsed.value.type).toBe("castExpression");
  });

  it("as Person after a call is a cast, with one statement", () => {
    const parsed = parseValue("foo() as Person") as any;
    expect(parsed.value.type).toBe("castExpression");
    expect(parsed.value.expression.type).toBe("functionCall");
    expect(parsed.value.targetType).toEqualWithoutLoc(alias("Person"));
    expect(parsed.value.checked).toBe(false);
    expect(parsed.statements).toHaveLength(1);
  });

  it("as Person after a method call is a cast", () => {
    const parsed = parseValue("x.y() as Person") as any;
    expect(parsed.value.type).toBe("castExpression");
  });

  it("as {} stays a block", () => {
    const parsed = parseValue("foo() as {}") as any;
    expect(parsed.value.type).toBe("functionCall");
    expect(parsed.value.block.type).toBe("blockArgument");
  });

  it("as { name } stays a block", () => {
    const parsed = parseValue("foo() as { name }") as any;
    expect(parsed.value.block.body[0].type).toBe("variableName");
  });

  it("as item { ... } stays a block", () => {
    const parsed = parseValue("map(xs) as item {\n    return item\n  }") as any;
    expect(parsed.value.block.params).toHaveLength(1);
  });

  it("as (a, b) { ... } stays a block", () => {
    const parsed = parseValue("mapWithIndex(xs) as (a, b) {\n    return a\n  }") as any;
    expect(parsed.value.block.params).toHaveLength(2);
  });

  it("a block after a method call in a chain stays a block", () => {
    const parsed = parseValue("xs.map() as item {\n    return item\n  }") as any;
    expect(parsed.success).toBe(true);
    expect(parsed.statements).toHaveLength(1);
    expect(JSON.stringify(parsed.value)).toContain('"blockArgument"');
    expect(JSON.stringify(parsed.value)).not.toContain('"castExpression"');
  });

  it("a typo in a real block body is reported as a body error, not a bad type", () => {
    const parsed = parseValue("map(xs) as x {\n    print(x\n  }") as any;
    expect(parsed.success).toBe(false);
    expect(parsed.message ?? "").not.toContain("expected a type");
  });

  // The other two constructs where `as` follows something that reaches the
  // expression parser. Both must be untouched by the cast grammar.
  it("the legacy guard as-block stays a guard block", () => {
    const parsed = parseValue("guard(cost: 1) as {\n    return 1\n  }") as any;
    expect(parsed.success).toBe(true);
    expect(parsed.value.type).toBe("guardBlock");
  });

  it("a destructuring rename keeps its own as", () => {
    const parsed = parseAgency("node main() {\n  const { a as b } = obj\n}\n", {}, false) as any;
    expect(parsed.success).toBe(true);
  });
});

describe("cast forms", () => {
  it("casts a plain variable", () => {
    expect((parseValue("x as Person") as any).value).toEqualWithoutLoc(
      cast(variable("x"), alias("Person")),
    );
  });

  it("casts inside a call argument", () => {
    const parsed = parseValue("greet(x as Person)") as any;
    expect(parsed.value.arguments[0]).toEqualWithoutLoc(cast(variable("x"), alias("Person")));
  });

  it("chains", () => {
    const parsed = parseValue("x as unknown as Person") as any;
    expect(parsed.value.type).toBe("castExpression");
    expect(parsed.value.expression.type).toBe("castExpression");
    expect(parsed.value.expression.targetType).toEqualWithoutLoc({
      type: "primitiveType",
      value: "unknown",
    });
  });

  it.each(["Person[]", "Person | null", "Result<Person>", "(n: number) => string"])(
    "accepts the type %s",
    (type) => {
      const parsed = parseValue(`x as ${type}`) as any;
      expect(parsed.success).toBe(true);
      expect(parsed.value.type).toBe("castExpression");
      expect(parsed.statements).toHaveLength(1);
    },
  );

  it("casts a parenthesized expression and does not mark the outer cast", () => {
    const parsed = parseValue("(a + b) as number") as any;
    expect(parsed.value.type).toBe("castExpression");
    expect(parsed.value.expression.type).toBe("binOpExpression");
    expect(parsed.value.parenthesized).toBeUndefined();
  });
});

describe("a cast on the next line", () => {
  // Nothing else can start a line with the reserved word `as`, and
  // _functionCallParser has already consumed the newline after `foo()`, so
  // the only consistent rule is to allow it after every kind of atom.
  it("attaches after a call", () => {
    const parsed = parseValue("foo()\n    as Person") as any;
    expect(parsed.value.type).toBe("castExpression");
    expect(parsed.statements).toHaveLength(1);
  });

  it("attaches after a variable", () => {
    const parsed = parseValue("x\n    as Person") as any;
    expect(parsed.value.type).toBe("castExpression");
    expect(parsed.statements).toHaveLength(1);
  });

  it("attaches across a blank line", () => {
    const parsed = parseValue("x\n\n    as Person") as any;
    expect(parsed.value.type).toBe("castExpression");
  });

  // A comment line ends the expression. What is left is the stray `as` and
  // `Person` statements the parser has always produced, which the type
  // checker refuses as undefined variables.
  it("does not attach across a comment line", () => {
    const parsed = parseValue("x\n    // note\n    as Person") as any;
    expect(parsed.value).toEqualWithoutLoc(variable("x"));
    expect(parsed.statements.map((statement: any) => statement.type)).toEqual([
      "assignment",
      "comment",
      "variableName",
      "variableName",
    ]);
  });
});

describe("the bang", () => {
  it("as Person! is checked", () => {
    expect((parseValue("x as Person!") as any).value.checked).toBe(true);
  });

  it("as Person != y is an unchecked cast on the left of !=", () => {
    const parsed = parseValue("x as Person != y") as any;
    expect(parsed.value.operator).toBe("!=");
    expect(parsed.value.left.checked).toBe(false);
  });

  it("as Person !~ y is an unchecked cast on the left of !~", () => {
    const parsed = parseValue("x as Person !~ y") as any;
    expect(parsed.value.operator).toBe("!~");
    expect(parsed.value.left.checked).toBe(false);
  });

  it("as Person! != y is a checked cast on the left of !=", () => {
    const parsed = parseValue("x as Person! != y") as any;
    expect(parsed.value.operator).toBe("!=");
    expect(parsed.value.left.checked).toBe(true);
  });
});

describe("the parenthesized mark", () => {
  it("a + (b as T) marks the cast", () => {
    const parsed = parseValue("a + (b as number)") as any;
    expect(parsed.value.right.type).toBe("castExpression");
    expect(parsed.value.right.parenthesized).toBe(true);
  });

  it("a + b as T does not mark the cast", () => {
    const parsed = parseValue("a + b as number") as any;
    expect(parsed.value.right.type).toBe("castExpression");
    expect(parsed.value.right.parenthesized).toBeUndefined();
  });

  it("!x as boolean groups as (!x) as boolean", () => {
    const parsed = parseValue("!x as boolean") as any;
    expect(parsed.value.type).toBe("castExpression");
    expect(parsed.value.expression.operator).toBe("!");
  });

  it("!(x as boolean) marks the cast", () => {
    const parsed = parseValue("!(x as boolean)") as any;
    expect(parsed.value.operator).toBe("!");
    expect(parsed.value.right.parenthesized).toBe(true);
  });
});

describe("is and as together", () => {
  it("x is Person as boolean parses", () => {
    const parsed = parseValue("x is Person as boolean") as any;
    expect(parsed.success).toBe(true);
    expect(parsed.statements).toHaveLength(1);
  });

  // `is` does not attach to a cast: the cast wraps atomWithIs, so by the time
  // the cast is built the `is` has nothing left to bind to. What is left is
  // stray statements, which the type checker refuses as undefined variables.
  it("x as Person is Person leaves the is behind", () => {
    const parsed = parseValue("x as Person is Person") as any;
    expect(parsed.value.type).toBe("castExpression");
    expect(parsed.statements.map((statement: any) => statement.type)).toEqual([
      "assignment",
      "variableName",
      "variableName",
    ]);
  });
});

describe("errors", () => {
  // blockOpening requires the `{` on the same line as the params, so a block
  // whose parameter list spans lines reaches the cast parser. The message has
  // to name that reading too.
  it("names both readings when a block parameter list spans lines", () => {
    const parsed = parseValue("[1, 2].map() as (\n    x\n  ) {\n    return x + 1\n  }") as any;
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain("`{` on this line");
  });

  it("a missing type is reported with a position, not as 'expected node body'", () => {
    const parsed = parseAgency("node main() {\n  const r = 1 + f(x as)\n}\n", {}, false) as any;
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain("expected a type after `as`");
    expect(parsed.message).not.toContain("expected node body");
    expect(parsed.errorData?.line).toBe(1);
  });
});

describe("formatting a cast written on the next line", () => {
  it("joins it onto one line", () => {
    const formatted = formatSource("node main() {\n  const r = x\n    as Person\n}\n");
    expect(typeof formatted).toBe("string");
    expect(formatted).toContain("const r = x as Person");
  });
});

describe("formatting a cast of a unary expression", () => {
  // Both spellings parse to the same node. The printer parenthesizes a
  // binOpExpression inside a cast, and a unary operator is one.
  it("normalizes !x as boolean to (!x) as boolean", () => {
    const formatted = formatSource("node main() {\n  const r = !x as boolean\n}\n");
    expect(typeof formatted).toBe("string");
    expect(formatted).toContain("const r = (!x) as boolean");
  });
});

describe("formatter round trip", () => {
  it.each([
    "const r = (a + b) as number",
    "const r = x as unknown as Person",
    "const r = greet(x as Person!, y)",
    "const r = a + (b as number)",
    "const r = a == b as number",
    "const r = x as number + 1",
    "const r = !(x as boolean)",
    "const r = (!x) as boolean",
  ])("%s", (line) => {
    const src = `node main() {\n  ${line}\n}\n`;
    const formatted = formatSource(src);
    expect(typeof formatted).toBe("string");
    expect(formatted).toContain(line);
  });
});
