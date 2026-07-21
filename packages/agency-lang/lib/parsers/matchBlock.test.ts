import { describe, it, expect } from "vitest";
import {
  matchBlockParser,
  matchBlockExprParser,
  matchBlockParserCase,
  defaultCaseParser,
  assignmentParser,
  returnStatementParser,
  bodyParser,
} from "./parsers.js";

describe("defaultCaseParser", () => {
  const testCases = [
    {
      input: "_",
      expected: {
        success: true,
        result: "_",
      },
    },
    {
      input: "x",
      expected: { success: false },
    },
    {
      input: "",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = defaultCaseParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqualWithoutLoc(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
          const result = defaultCaseParser(input);
          expect(result.success).toBe(false);
        });
    }
  });
});

describe("matchBlockParserCase", () => {
  const testCases = [
    {
      input: "1 => 2",
      expected: {
        success: true,
        result: {
          type: "matchBlockCase",
          caseValue: { type: "number", value: "1" },
          body: [{ type: "number", value: "2" }],
        },
      },
    },
    {
      input: "x => y",
      expected: {
        success: true,
        result: {
          type: "matchBlockCase",
          caseValue: { type: "variableName", value: "x" },
          body: [{ type: "variableName", value: "y" }],
        },
      },
    },
    {
      input: '"hello" => "world"',
      expected: {
        success: true,
        result: {
          type: "matchBlockCase",
          caseValue: { type: "string", segments: [{ type: "text", value: "hello" }] },
          body: [{ type: "string", segments: [{ type: "text", value: "world" }] }],
        },
      },
    },
    {
      input: "_ => 42",
      expected: {
        success: true,
        result: {
          type: "matchBlockCase",
          caseValue: "_",
          body: [{ type: "number", value: "42" }],
        },
      },
    },
    {
      input: "  x  =>  y  ",
      expected: {
        success: true,
        result: {
          type: "matchBlockCase",
          caseValue: { type: "variableName", value: "x" },
          body: [{ type: "variableName", value: "y" }],
        },
      },
    },
    {
      input: "x => result = 5",
      expected: {
        success: true,
        result: {
          type: "matchBlockCase",
          caseValue: { type: "variableName", value: "x" },
          body: [{
            type: "assignment",
            variableName: "result",
            value: { type: "number", value: "5" },
          }],
        },
      },
    },
    {
      input: "x => print(y)",
      expected: {
        success: true,
        result: {
          type: "matchBlockCase",
          caseValue: { type: "variableName", value: "x" },
          body: [{
            type: "functionCall",
            functionName: "print",
            arguments: [{ type: "variableName", value: "y" }],
          }],
        },
      },
    },
    {
      input: "x => goto next()",
      expected: {
        success: true,
        result: {
          type: "matchBlockCase",
          caseValue: { type: "variableName", value: "x" },
          body: [{
            type: "gotoStatement",
            nodeCall: {
              type: "functionCall",
              functionName: "next",
              arguments: [],
            },
          }],
        },
      },
    },
    {
      input: "x -> y",
      expected: { success: false },
    },
    {
      input: "=> y",
      expected: { success: false },
    },
    {
      input: "x =>",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = matchBlockParserCase(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqualWithoutLoc(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
          const result = matchBlockParserCase(input);
          expect(result.success).toBe(false);
        });
    }
  });
});

describe("matchBlockParser", () => {
  const testCases = [
    {
      name: "basic match with variable expression and single case",
      input: `match(foo) {
  x => 1
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "foo" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "variableName", value: "x" },
              body: [{ type: "number", value: "1" }],
            },
          ],
        },
      },
    },
    {
      name: "match with multiple cases",
      input: `match(foo) {
  x => 1
  y => 2
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "foo" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "variableName", value: "x" },
              body: [{ type: "number", value: "1" }],
            },
            {
              type: "matchBlockCase",
              caseValue: { type: "variableName", value: "y" },
              body: [{ type: "number", value: "2" }],
            },
          ],
        },
      },
    },
    {
      name: "match with default case",
      input: `match(foo) {
  x => 1
  _ => 2
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "foo" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "variableName", value: "x" },
              body: [{ type: "number", value: "1" }],
            },
            {
              type: "matchBlockCase",
              caseValue: "_",
              body: [{ type: "number", value: "2" }],
            },
          ],
        },
      },
    },
    {
      name: "match with semicolon separators",
      input: `match(foo) {
  x => 1; y => 2; _ => 3
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "foo" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "variableName", value: "x" },
              body: [{ type: "number", value: "1" }],
            },
            {
              type: "matchBlockCase",
              caseValue: { type: "variableName", value: "y" },
              body: [{ type: "number", value: "2" }],
            },
            {
              type: "matchBlockCase",
              caseValue: "_",
              body: [{ type: "number", value: "3" }],
            },
          ],
        },
      },
    },
    {
      name: "match with string literals",
      input: `match(status) {
  "active" => "running"
  "inactive" => "stopped"
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "status" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "string", segments: [{ type: "text", value: "active" }] },
              body: [{ type: "string", segments: [{ type: "text", value: "running" }] }],
            },
            {
              type: "matchBlockCase",
              caseValue: { type: "string", segments: [{ type: "text", value: "inactive" }] },
              body: [{ type: "string", segments: [{ type: "text", value: "stopped" }] }],
            },
          ],
        },
      },
    },
    {
      name: "match with number literals",
      input: `match(code) {
  200 => "OK"
  404 => "Not Found"
  500 => "Error"
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "code" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "number", value: "200" },
              body: [{ type: "string", segments: [{ type: "text", value: "OK" }] }],
            },
            {
              type: "matchBlockCase",
              caseValue: { type: "number", value: "404" },
              body: [{ type: "string", segments: [{ type: "text", value: "Not Found" }] }],
            },
            {
              type: "matchBlockCase",
              caseValue: { type: "number", value: "500" },
              body: [{ type: "string", segments: [{ type: "text", value: "Error" }] }],
            },
          ],
        },
      },
    },
    {
      name: "match with assignment bodies",
      input: `match(x) {
  1 => result = 10
  2 => result = 20
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "x" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "number", value: "1" },
              body: [{
                type: "assignment",
                variableName: "result",
                value: { type: "number", value: "10" },
              }],
            },
            {
              type: "matchBlockCase",
              caseValue: { type: "number", value: "2" },
              body: [{
                type: "assignment",
                variableName: "result",
                value: { type: "number", value: "20" },
              }],
            },
          ],
        },
      },
    },
    {
      name: "match with function call bodies",
      input: `match(action) {
  "start" => print("Starting")
  "stop" => print("Stopping")
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "action" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "string", segments: [{ type: "text", value: "start" }] },
              body: [{
                type: "functionCall",
                functionName: "print",
                arguments: [{ type: "string", segments: [{ type: "text", value: "Starting" }] }],
              }],
            },
            {
              type: "matchBlockCase",
              caseValue: { type: "string", segments: [{ type: "text", value: "stop" }] },
              body: [{
                type: "functionCall",
                functionName: "print",
                arguments: [{ type: "string", segments: [{ type: "text", value: "Stopping" }] }],
              }],
            },
          ],
        },
      },
    },
    {
      name: "match with minimal whitespace",
      input: `match(x){y=>1}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "x" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "variableName", value: "y" },
              body: [{ type: "number", value: "1" }],
            },
          ],
        },
      },
    },
    {
      name: "match with number expression",
      input: `match(42) {
  42 => "found"
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "number", value: "42" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "number", value: "42" },
              body: [{ type: "string", segments: [{ type: "text", value: "found" }] }],
            },
          ],
        },
      },
    },
    {
      name: "match with string expression",
      input: `match("test") {
  "test" => 1
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "string", segments: [{ type: "text", value: "test" }] },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "string", segments: [{ type: "text", value: "test" }] },
              body: [{ type: "number", value: "1" }],
            },
          ],
        },
      },
    },
    {
      name: "match with empty cases (no cases)",
      input: `match(x) {
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "x" },
          cases: [],
        },
      },
    },
    {
      name: "match with valueAccess expression",
      input: `match(obj.status) {
  "active" => 1
  _ => 0
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: {
            type: "valueAccess",
            base: { type: "variableName", value: "obj" },
            chain: [{ kind: "property", name: "status" }],
          },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "string", segments: [{ type: "text", value: "active" }] },
              body: [{ type: "number", value: "1" }],
            },
            {
              type: "matchBlockCase",
              caseValue: "_",
              body: [{ type: "number", value: "0" }],
            },
          ],
        },
      },
    },
    {
      name: "match with indexed valueAccess expression",
      input: `match(arr[0]) {
  1 => "first"
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: {
            type: "valueAccess",
            base: { type: "variableName", value: "arr" },
            chain: [{ kind: "index", index: { type: "number", value: "0" } }],
          },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "number", value: "1" },
              body: [{ type: "string", segments: [{ type: "text", value: "first" }] }],
            },
          ],
        },
      },
    },
    {
      name: "match with duplicate case values",
      input: `match(x) {
  1 => "first"
  1 => "second"
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "x" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "number", value: "1" },
              body: [{ type: "string", segments: [{ type: "text", value: "first" }] }],
            },
            {
              type: "matchBlockCase",
              caseValue: { type: "number", value: "1" },
              body: [{ type: "string", segments: [{ type: "text", value: "second" }] }],
            },
          ],
        },
      },
    },
    {
      name: "match with multiple default arms",
      input: `match(x) {
  _ => 1
  _ => 2
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "x" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: "_",
              body: [{ type: "number", value: "1" }],
            },
            {
              type: "matchBlockCase",
              caseValue: "_",
              body: [{ type: "number", value: "2" }],
            },
          ],
        },
      },
    },
    {
      name: "missing opening parenthesis",
      input: `match foo) { x => 1 }`,
      expected: { success: false },
    },
    {
      name: "missing closing parenthesis",
      input: `match(foo { x => 1 }`,
      expected: { success: false },
    },
    {
      name: "missing opening brace",
      input: `match(foo) x => 1 }`,
      expected: { success: false },
    },
    {
      name: "missing closing brace",
      input: `match(foo) { x => 1`,
      expected: { success: false },
      throws: true,
    },
    {
      name: "missing expression",
      input: `match() { x => 1 }`,
      expected: { success: false },
    },
    {
      name: "invalid match keyword",
      input: `macth(foo) { x => 1 }`,
      expected: { success: false },
    },
  ];

  testCases.forEach(({ name, input, expected, throws }: any) => {
    if (expected.success) {
      it(`should parse ${name}`, () => {
        const result = matchBlockParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqualWithoutLoc(expected.result);
        }
      });
    } else if (throws) {
      it(`should fail to parse ${name}`, () => {
        expect(() => matchBlockParser(input)).toThrow();
      });
    } else {
      it(`should fail to parse ${name}`, () => {
        const result = matchBlockParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("block arm bodies", () => {
  it("parses a multi-statement block arm with correct contents", () => {
    const result = matchBlockParser(`match(x) {
  "a" => {
    print("hi")
    let y = 1
  }
  _ => 0
}`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase") as any[];
      expect(cases[0].body.length).toBe(2);
      // exact type strings verified in Step 2; also assert CONTENT so a
      // dropped/mangled statement cannot pass on length alone:
      expect(cases[0].body[0].type).toBe("functionCall");
      expect(JSON.stringify(cases[0].body[0])).toContain("hi");
      expect(cases[0].body[1].type).toBe("assignment");
      expect(cases[0].body[1].variableName).toBe("y");
      expect(cases[1].body.length).toBe(1);
    }
  });

  it("parses single-expression arm as one-element body", () => {
    const result = matchBlockParser(`match(x) { "a" => 1; _ => 2 }`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase") as any[];
      expect(cases[0].body).toEqual([expect.objectContaining({ type: "number", value: "1" })]);
    }
  });

  it("parses a block arm ending in a return statement", () => {
    const result = matchBlockParser(`match(x) {
  "a" => {
    print("hi")
    return 1
  }
  _ => 0
}`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase") as any[];
      expect(cases[0].body[cases[0].body.length - 1].type).toBe("returnStatement");
    }
  });

  it("parses mixed single-expression and block arms", () => {
    const result = matchBlockParser(`match(x) {
  "a" => {
    print("a")
  }
  "b" => 2
  _ => {
    print("d")
  }
}`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase") as any[];
      expect(cases.map((c: any) => c.body.length)).toEqual([1, 1, 1]);
    }
  });

  it("parses semicolon-separated statements inside a block arm", () => {
    const result = matchBlockParser(`match(x) { "a" => { print("p"); let y = 1 } _ => 0 }`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase") as any[];
      expect(cases[0].body.length).toBe(2);
    }
  });

  it("parses an empty block arm as body: []", () => {
    const result = matchBlockParser(`match(x) { "a" => { } _ => 0 }`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase") as any[];
      expect(cases[0].body).toEqual([]);
    }
  });

  it("treats brace after arrow as a block: object-literal-looking content fails as statements", () => {
    // `label: "hi"` isn't valid as a statement (or sequence of statements),
    // so the block fails to parse. As with other malformed-arm cases (see
    // "missing closing brace" above), the surrounding `parseError` in
    // `matchBlockParser` promotes that into a hard (throwing) failure rather
    // than a recoverable `success: false` — it is not reinterpreted as an
    // object-literal expression.
    expect(() =>
      matchBlockParser(`match(x) {
  "a" => { label: "hi" }
  _ => 0
}`),
    ).toThrow();
  });

  it("positive twin: block form with an object literal return parses", () => {
    const result = matchBlockParser(`match(x) {
  "a" => { return { label: "hi" } }
  _ => 0
}`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase") as any[];
      expect(cases[0].body[0].type).toBe("returnStatement");
    }
  });

  it("parses a block arm with a guard, capturing both", () => {
    const result = matchBlockParser(`match(x) {
  y if (y > 2) => {
    print(y)
  }
  _ => 0
}`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase") as any[];
      expect(cases[0].guard).toBeDefined();
      expect(cases[0].body.length).toBe(1);
    }
  });

  it("parses a parenthesized object literal single-expression arm", () => {
    const result = matchBlockParser(`match(x) { _ => ({ label: "hi" }) }`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase") as any[];
      expect(JSON.stringify(cases[0].body[0])).toContain("label");
    }
  });
});

describe("match as expression (assignment RHS and return only)", () => {
  it("parses match as assignment RHS", () => {
    const result = assignmentParser(`const val = match(r) {
  "a" => 1
  _ => 2
}`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.declKind).toBe("const");
      expect((result.result.value as any).type).toBe("matchBlock");
    }
  });

  it("parses return match(...)", () => {
    const result = returnStatementParser(`return match(r) {
  "a" => 1
  _ => 2
}`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.result.value as any).type).toBe("matchBlock");
    }
  });

  it("still parses a call to a function named match", () => {
    const result = assignmentParser(`const y = match(r)`);
    expect(result.success).toBe(true);
    if (result.success) expect((result.result.value as any).type).not.toBe("matchBlock");
  });

  it("backtracks past the closing paren: match(r) + 1 is a binop over a call", () => {
    const result = assignmentParser(`const y = match(r) + 1`);
    expect(result.success).toBe(true);
    if (result.success) expect((result.result.value as any).type).toBe("binOpExpression");
  });

  // These combinator parsers match a prefix of the input and never require
  // full consumption (see e.g. access.test.ts:170, blockArgument.test.ts:135),
  // so `assignmentParser` on a string with a disallowed match position still
  // reports `success: true` — it just stops short of consuming the match
  // block, since `matchBlockExprParser` isn't wired into call arguments or
  // binop operands. The v1 restriction shows up as leftover, unconsumed
  // input (the `{ ... }` case body) rather than an outright parse failure.
  it("match block as a function argument does not parse (v1 restriction)", () => {
    const result = assignmentParser(`const y = f(match(r) { "a" => 1; _ => 2 })`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.result.value as any).type).not.toBe("matchBlock");
      expect(result.rest).toContain('{ "a" => 1; _ => 2 }');
    }
  });

  it("match block as a binop operand does not parse (v1 restriction)", () => {
    const result = assignmentParser(`const y = 1 + match(r) { "a" => 1; _ => 2 }`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.result.value as any).type).not.toBe("matchBlock");
      expect(result.rest).toContain('{ "a" => 1; _ => 2 }');
    }
  });

  it("no trailing over-consumption: next statement still parses", () => {
    const result = bodyParser(`const a = match(x) {
  "a" => 1
  _ => 2
}
const b = 2
`);
    expect(result.success).toBe(true);
    if (result.success) {
      const assigns = result.result.filter((n: any) => n.type === "assignment");
      expect(assigns.length).toBe(2);
    }
  });
});

describe("match parser loc spans (statement vs expression form)", () => {
  // When a parser is invoked standalone, tarsec's span offsets are relative
  // to the END of the input: `loc.start === -input.length` at position 0 and
  // `loc.end === -rest.length`, so `loc.end - loc.start` is the number of
  // characters the parser consumed for the node.
  const input = `match(x) { "a" => 1\n_ => 2 }\n\n`;

  it("statement form: loc.end covers trailing semicolon/whitespace consumption (pre-refactor behavior)", () => {
    const result = matchBlockParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      // Consumes the whole input, including the two trailing newlines.
      expect(result.rest).toBe("");
      const loc = result.result.loc!;
      expect(loc.end).toBe(0);
      expect(loc.end - loc.start).toBe(input.length);
    }
  });

  it("expression form: loc.end stops at the closing brace", () => {
    const result = matchBlockExprParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      // Leaves the trailing newlines unconsumed; span ends at `}`.
      expect(result.rest).toBe("\n\n");
      expect(result.result.loc.end).toBe(-result.rest.length); // === -2
      expect(result.result.loc.end - result.result.loc.start).toBe(input.length - 2);
    }
  });
});

describe("type patterns in match arms", () => {
  it("binder with type suffix: `s: string => s`", () => {
    const result = matchBlockParserCase("s: string => s");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.caseValue).toMatchObject({
      type: "typePattern",
      pattern: { type: "variableName", value: "s" },
      typeHint: { type: "primitiveType", value: "string" },
    });
  });

  it("object pattern with type suffix and guard", () => {
    const result = matchBlockParserCase("{name, age}: Person if (age > 100) => name");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.result.caseValue as any).type).toBe("typePattern");
    expect((result.result.caseValue as any).pattern.type).toBe("objectPattern");
    expect(result.result.guard).toBeDefined();
  });

  it("`is Type` as an arm", () => {
    const result = matchBlockParserCase("is boolean => 1");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.caseValue).toMatchObject({
      type: "typePattern",
      pattern: null,
      typeHint: { type: "primitiveType", value: "boolean" },
    });
  });

  it("wildcard with type suffix: `_: null => 0`", () => {
    const result = matchBlockParserCase("_: null => 0");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.caseValue).toMatchObject({
      type: "typePattern",
      pattern: null,
      typeHint: { type: "primitiveType", value: "null" },
    });
  });

  it("array pattern with type suffix: `[x, y]: number[]`", () => {
    const result = matchBlockParserCase("[x, y]: number[] => x");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.result.caseValue as any).type).toBe("typePattern");
    expect((result.result.caseValue as any).pattern.type).toBe("arrayPattern");
    expect((result.result.caseValue as any).typeHint.type).toBe("arrayType");
  });

  it("inline object type as the suffix", () => {
    const result = matchBlockParserCase("person: {name: string, age: number} => person");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.result.caseValue as any).type).toBe("typePattern");
    expect((result.result.caseValue as any).pattern).toMatchObject({
      type: "variableName",
      value: "person",
    });
    expect((result.result.caseValue as any).typeHint.type).toBe("objectType");
  });

  it("bare binder arm still binds", () => {
    const result = matchBlockParserCase("other => other");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.result.caseValue as any).type).toBe("variableName");
  });

  it("object pattern with internal colon is not a type suffix", () => {
    const result = matchBlockParserCase('{ type: "click", x } => x');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.result.caseValue as any).type).toBe("objectPattern");
  });

  it("REGRESSION: expression-guard arm still parses", () => {
    const result = matchBlockParserCase('role == "admin" => 1');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.result.caseValue as any).type).toBe("binOpExpression");
  });

  it("REGRESSION: literal arm still parses", () => {
    const result = matchBlockParserCase('"small" => 1');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.result.caseValue as any).type).toBe("string");
  });

  it("REGRESSION: bare wildcard arm still parses", () => {
    const result = matchBlockParserCase("_ => 0");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.caseValue).toBe("_");
  });
});
