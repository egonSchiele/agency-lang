import { describe, expect, it } from "vitest";
import { bodyParser } from "./parsers.js";
import { parseAgency } from "../parser.js";

describe("functionBodyParser", () => {
  const testCases = [
    {
      input: "foo = 1",
      expected: {
        success: true,
        result: [
          {
            type: "assignment",
            variableName: "foo",
            value: { type: "number", value: "1" },
          },
        ],
      },
    },
    {
      input: 'bar = "hello"',
      expected: {
        success: true,
        result: [
          {
            type: "assignment",
            variableName: "bar",
            value: {
              type: "string",
              segments: [{ type: "text", value: "hello" }],
            },
          },
        ],
      },
    },
    {
      input: "bar = `hello`\nfoo",
      expected: {
        success: true,
        result: [
          {
            type: "assignment",
            variableName: "bar",
            value: {
              type: "string",
              segments: [{ type: "text", value: "hello" }],
            },
          },
          {
            type: "newLine",
          },
          {
            type: "variableName",
            value: "foo",
          },
        ],
      },
    },
    {
      input: "x = 5\ny = 10",
      expected: {
        success: true,
        result: [
          {
            type: "assignment",
            variableName: "x",
            value: { type: "number", value: "5" },
          },
          {
            type: "newLine",
          },
          {
            type: "assignment",
            variableName: "y",
            value: { type: "number", value: "10" },
          },
        ],
      },
    },
    {
      input: "42",
      expected: {
        success: true,
        result: [
          {
            type: "number",
            value: "42",
          },
        ],
      },
    },
    {
      input: "",
      expected: {
        success: true,
        result: [],
      },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = bodyParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqualWithoutLoc(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = bodyParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("declarations are not legal in a body", () => {
  // These assert a FAILURE, not a partial success. The decline is a
  // committed failure, and `many` fails the whole repetition when it meets
  // one — which is exactly what a code literal needs, since kind inference
  // only reaches the program parser if the statements attempt fails
  // outright.
  const declarations = [
    "node inner() { print(1) }",
    "def helper() { return 1 }",
    "print(1)\nnode inner() { print(2) }",
  ];

  for (const source of declarations) {
    it(`fails on: ${source.split("\n")[0]}`, () => {
      const result = bodyParser(source);
      expect(result.success, source).toBe(false);
      if (result.success) return;
      expect(result.message, source).toContain(
        "only legal at the top level of a file",
      );
    });
  }
});

describe("known limitation: a keyword and a call on separate lines", () => {
  it("declines `node` on one line and a call on the next, which parsed before", () => {
    // ACCEPTED REGRESSION, pinned so a future probe change that un-declines
    // it is a deliberate decision rather than an accident.
    //
    // Here `node` is an ordinary variable and `helper()` an ordinary call,
    // and this file compiles on main. The probe's `many1(space)` matches a
    // newline — the same whitespace the real declaration grammar accepts —
    // so keyword-newline-name-paren is declined exactly like the one-line
    // form. That text is indistinguishable from the bug being fixed, and
    // anyone writing it almost certainly meant a declaration.
    const source =
      "def helper(): number {\n  return 1\n}\n\nnode main() {\n  const node = 1\n  node\n  helper()\n}\n";
    const result = parseAgency(source, {}, false);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.message).toContain("only legal at the top level of a file");
  });
});

describe("the body-declaration message reaches a whole-file parse", () => {
  // At this level, not `bodyParser`: a block parser wraps its body in
  // tarsec's `parseError`, which THROWS its own generic message over
  // whatever failed inside. Only `parseAgency` catches that and consults
  // the committed-failure slot, which is why `bodyDeclarationParser`
  // registers itself there. Without that registration these report
  // "expected node body" / "expected `{` to open if block body" and the
  // user is told nothing useful.
  const files: [string, string][] = [
    ["a node body", "node main() {\n  node inner() {\n    print(1)\n  }\n}\n"],
    ["a def body", "node main() {\n  def helper() {\n    return 1\n  }\n}\n"],
    [
      "inside an if",
      "node main() {\n  if (true) {\n    node inner() {\n      print(1)\n    }\n  }\n}\n",
    ],
  ];

  for (const [label, source] of files) {
    it(`names the top-level rule for a declaration in ${label}`, () => {
      const result = parseAgency(source, {}, false);
      expect(result.success, label).toBe(false);
      if (result.success) return;
      expect(result.message, label).toContain(
        "only legal at the top level of a file",
      );
    });
  }
});

describe("keyword-as-variable statements still parse", () => {
  // `node` is a legal variable name (`const node = 1` compiles today).
  // Every one of these fails the declaration probe somewhere, which is
  // what keeps them out of the decline.
  const cases: { input: string; firstType: string }[] = [
    { input: "node.run()", firstType: "valueAccess" },
    { input: "node + 1", firstType: "binOpExpression" },
    { input: "node(1)", firstType: "functionCall" },
    { input: "node", firstType: "variableName" },
    { input: "debugger", firstType: "variableName" },
    { input: "nodeCount()", firstType: "functionCall" },
    // Keyword followed by a word is the reason the probe requires a name
    // AND a `(`. All three parse today, and a probe that stopped at
    // "keyword, space, identifier" would decline them — which, being a
    // committed failure, turns something that parses into a hard error.
    // `node is string` is three bare-name statements, not an `is`
    // expression; it is junk, but it is junk that parses, and this change
    // is not the place to start rejecting it.
    { input: "node is string", firstType: "variableName" },
    { input: "node as Foo", firstType: "variableName" },
    { input: "node in items", firstType: "binOpExpression" },
  ];

  for (const { input, firstType } of cases) {
    it(`parses \`${input}\` as before`, () => {
      const result = bodyParser(input);
      expect(result.success, input).toBe(true);
      if (!result.success) return;
      expect(result.result.length, input).toBeGreaterThan(0);
      expect(result.result[0].type, input).toBe(firstType);
      expect(result.rest.trim(), input).toBe("");
    });
  }
});
