import { describe, it, expect } from "vitest";
import { handleBlockParser, bodyParser } from "./parsers.js";
import { parseAgency } from "@/parser.js";
import { normalizeCode } from "@/index.js";

/** Parse a whole program and return its error message, the way the bespoke
 *  committed-failure messages surface to the user (see errorExamples.test.ts). */
function parseFailureMessage(src: string): string {
  const parsed = parseAgency(src, {}, false);
  if (parsed.success) throw new Error(`expected a failed parse for:\n${src}`);
  return parsed.message ?? "";
}

describe("handleBlockParser", () => {
  it("should not match `handle` as a prefix of an identifier like `handler`", () => {
    // Regression: `str("handle")` lacked a word boundary, so a statement
    // `handler(data)` matched the `handle` keyword and the committing
    // parseError threw "expected `{`" instead of backtracking to a call.
    const input = "handle {\n  foo()\n} with (data) {\n  handler(data)\n}";
    const result = handleBlockParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success && result.result.handler.kind === "inline") {
      const bodyTypes = result.result.handler.body.map((n) => n.type);
      expect(bodyTypes).toContain("functionCall");
    }
  });

  it("should parse a `handler(...)` call as a statement, not a handle block", () => {
    const result = bodyParser(normalizeCode("handler(data)\n"));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.map((n) => n.type)).toContain("functionCall");
    }
  });

  it("should parse inline handler", () => {
    const input = "handle {\n  foo()\n} with (data) {\n  return approve()\n}";
    const result = handleBlockParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.type).toBe("handleBlock");
      expect(result.result.handler.kind).toBe("inline");
      if (result.result.handler.kind === "inline") {
        expect(result.result.handler.param.name).toBe("data");
      }
    }
  });

  it("should parse inline handler with typed param", () => {
    const input = "handle {\n  foo()\n} with (data: string) {\n  return approve()\n}";
    const result = handleBlockParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.handler.kind).toBe("inline");
      if (result.result.handler.kind === "inline") {
        expect(result.result.handler.param.name).toBe("data");
        expect(result.result.handler.param.typeHint).toEqualWithoutLoc({
          type: "primitiveType",
          value: "string",
        });
      }
    }
  });

  it("should parse function ref handler", () => {
    const input = "handle {\n  foo()\n} with myPolicy";
    const result = handleBlockParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.type).toBe("handleBlock");
      expect(result.result.handler.kind).toBe("functionRef");
      if (result.result.handler.kind === "functionRef") {
        expect(result.result.handler.functionName).toBe("myPolicy");
      }
    }
  });

  it("should parse handle block body", () => {
    const input = "handle {\n  x = 1\n  foo()\n} with (data) {\n  return approve()\n}";
    const result = handleBlockParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success) {
      const bodyTypes = result.result.body.map((n) => n.type);
      expect(bodyTypes).toContain("assignment");
      expect(bodyTypes).toContain("functionCall");
    }
  });

  it("should parse approve with value", () => {
    const input = 'handle {\n  foo()\n} with (data) {\n  return approve("yes")\n}';
    const result = handleBlockParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.handler.kind).toBe("inline");
      if (result.result.handler.kind === "inline") {
        // handler body should contain a return statement
        const returns = result.result.handler.body.filter((n) => n.type === "returnStatement");
        expect(returns.length).toBe(1);
      }
    }
  });

  it("should parse reject with message", () => {
    const input = 'handle {\n  foo()\n} with (data) {\n  return reject("not allowed")\n}';
    const result = handleBlockParser(normalizeCode(input));
    expect(result.success).toBe(true);
  });

  it("should fail without with clause", () => {
    const input = "handle {\n  foo()\n}";
    const result = handleBlockParser(normalizeCode(input));
    expect(result.success).toBe(false);
  });

  it("should fail on empty input", () => {
    const result = handleBlockParser(normalizeCode(""));
    expect(result.success).toBe(false);
  });
});

describe("on-clause handler", () => {
  it("parses `with { on ... }` to a return-of-match on intr.effect", () => {
    const alias = handleBlockParser(
      normalizeCode(
        "handle {\n  foo()\n} with {\n" +
          "  on std::read(data) { approve() }\n" +
          '  on std::write(data) { if (data.dir == ".") { approve() } else { reject() } }\n' +
          "  on _ { reject() }\n}",
      ),
    );
    expect(alias.success).toBe(true);
    if (!alias.success) return;
    expect(alias.result.handler.kind).toBe("inline");
    const handler = alias.result.handler;
    if (handler.kind !== "inline") return;
    expect(handler.param.name).toBe("intr");
    const returnStmt = handler.body[0] as {
      type: string;
      value: { type: string; expression: { chain: { name: string }[] } };
    };
    expect(returnStmt.type).toBe("returnStatement");
    expect(returnStmt.value.type).toBe("matchBlock");
    expect(returnStmt.value.expression.chain[0].name).toBe("effect");
  });

  it("accepts a quoted effect name", () => {
    const quoted = handleBlockParser(
      normalizeCode(
        'handle {\n  foo()\n} with {\n  on "std::read"(data) { approve() }\n  on _ { reject() }\n}',
      ),
    );
    expect(quoted.success).toBe(true);
  });

  it("accepts an underscore-led effect name (`on _foo`), not just the `_` catch-all", () => {
    const parsed = handleBlockParser(
      normalizeCode(
        "handle {\n  foo()\n} with {\n  on _foo(data) { approve() }\n  on _ { reject() }\n}",
      ),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.result.handler.kind !== "inline") return;
    const match = (parsed.result.handler.body[0] as { value: { cases: { caseValue: unknown }[] } })
      .value;
    // First arm matches the string "_foo", not the wildcard.
    expect(match.cases[0].caseValue).toEqual({
      type: "string",
      segments: [{ type: "text", value: "_foo" }],
    });
  });

  it("accepts an underscore-led binding name (`on eff(_tmp)`)", () => {
    const parsed = handleBlockParser(
      normalizeCode(
        "handle {\n  foo()\n} with {\n  on std::read(_tmp) { approve() }\n  on _ { reject() }\n}",
      ),
    );
    expect(parsed.success).toBe(true);
  });

  it("rejects a binding name that starts with a digit", () => {
    const parsed = handleBlockParser(
      normalizeCode(
        "handle {\n  foo()\n} with {\n  on std::read(1data) { approve() }\n  on _ { reject() }\n}",
      ),
    );
    expect(parsed.success).toBe(false);
  });

  it("reports a malformed first clause as malformed, not as an empty block", () => {
    const message = parseFailureMessage(
      "node main() {\n  handle {\n    foo()\n  } with {\n    on\n  }\n}",
    );
    expect(message).not.toContain("at least one");
    expect(message).toContain("on <effect>");
  });

  it("rejects a duplicate effect (normalized) with its own message", () => {
    const message = parseFailureMessage(
      "node main() {\n  handle {\n    foo()\n  } with {\n" +
        "    on std::read(data) { approve() }\n" +
        '    on "std::read"(data) { reject() }\n' +
        "  }\n}",
    );
    expect(message).toContain("may appear once");
    expect(message).toContain("std::read");
  });

  it("rejects an empty `with { }` block with its own message", () => {
    const message = parseFailureMessage("node main() {\n  handle {\n    foo()\n  } with { }\n}");
    expect(message).toContain("at least one");
  });

  it("rejects an `on _` that is not the last clause", () => {
    const message = parseFailureMessage(
      "node main() {\n  handle {\n    foo()\n  } with {\n" +
        "    on _ { reject() }\n" +
        "    on std::read(data) { approve() }\n" +
        "  }\n}",
    );
    expect(message).toContain("must be the last clause");
  });

  it("parses expression-position handle at an assignment RHS", () => {
    const src =
      "let res: Result<string> = handle (foo(dir: dir)) with {\n" +
      "  on std::read(data) { approve() }\n  on _ { reject() }\n}\n";
    const parsed = bodyParser(normalizeCode(src));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const handleBlock = parsed.result[0] as {
      type: string;
      body: { type: string; variableName: string; declKind: string; value: { type: string } }[];
      handler: { kind: string };
    };
    expect(handleBlock.type).toBe("handleBlock");
    expect(handleBlock.body[0].type).toBe("assignment");
    expect(handleBlock.body[0].variableName).toBe("res");
    expect(handleBlock.body[0].declKind).toBe("let");
    expect(handleBlock.body[0].value.type).toBe("functionCall");
    expect(handleBlock.handler.kind).toBe("inline");
  });

  it("rejects an expression-handle whose declared name starts with a digit", () => {
    const parsed = bodyParser(
      normalizeCode("let 1res = handle (foo()) with {\n  on _ { reject() }\n}\n"),
    );
    // Either fails outright, or does not parse as an expression-handle wrapping
    // an invalid name.
    if (parsed.success) {
      const first = parsed.result[0] as { type: string };
      expect(first.type).not.toBe("handleBlock");
    }
  });
});
