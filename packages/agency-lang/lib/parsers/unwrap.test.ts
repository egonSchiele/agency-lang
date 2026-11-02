import { describe, expect, it } from "vitest";
import { parseAgency } from "../parser.js";

/** The statements of `node main() { const r = <expr> }`, or the failure. */
function parseValue(expr: string) {
  const result = parseAgency(`node main() {\n  const r = ${expr}\n}\n`, {}, false);
  if (!result.success) {
    return result;
  }
  const mainNode = result.result.nodes.find((node: any) => node.type === "graphNode") as any;
  const statements = mainNode.body.filter((statement: any) => statement.type !== "newLine");
  return { success: true as const, statements, value: statements[0].value };
}

const unwrap = { kind: "unwrap" };
const call = (functionName: string) => ({ type: "functionCall", functionName, arguments: [] });
const variable = (value: string) => ({ type: "variableName", value });
const property = (name: string) => ({ kind: "property", name });
const methodCall = (functionName: string) => ({
  kind: "methodCall",
  functionCall: call(functionName),
});

describe("parsing the ? operator", () => {
  it("foo()? is a value access with one unwrap element", () => {
    const parsed = parseValue("foo()?") as any;
    expect(parsed.success).toBe(true);
    expect(parsed.value).toEqualWithoutLoc({
      type: "valueAccess",
      base: call("foo"),
      chain: [unwrap],
    });
  });

  it("x? unwraps a variable", () => {
    const parsed = parseValue("x?") as any;
    expect(parsed.value).toEqualWithoutLoc({
      type: "valueAccess",
      base: variable("x"),
      chain: [unwrap],
    });
  });

  it("foo()?.name continues the chain after the unwrap", () => {
    const parsed = parseValue("foo()?.name") as any;
    expect(parsed.value.chain).toEqualWithoutLoc([unwrap, property("name")]);
  });

  it("a()?.b()?.c()? interleaves unwraps and method calls", () => {
    const parsed = parseValue("a()?.b()?.c()?") as any;
    expect(parsed.value.base).toEqualWithoutLoc(call("a"));
    expect(parsed.value.chain).toEqualWithoutLoc([
      unwrap,
      methodCall("b"),
      unwrap,
      methodCall("c"),
      unwrap,
    ]);
  });

  it("foo()?[0] indexes after the unwrap", () => {
    const parsed = parseValue("foo()?[0]") as any;
    expect(parsed.value.chain).toEqualWithoutLoc([
      unwrap,
      { kind: "index", index: { type: "number", value: "0" } },
    ]);
  });

  it("(x)?.name unwraps a parenthesized expression", () => {
    const parsed = parseValue("(x)?.name") as any;
    expect(parsed.value).toEqualWithoutLoc({
      type: "valueAccess",
      base: variable("x"),
      chain: [unwrap, property("name")],
    });
  });

  it("x ? with a space after a variable is not an unwrap", () => {
    const parsed = parseValue("x ?") as any;
    expect(JSON.stringify(parsed)).not.toContain('"unwrap"');
  });

  it("foo() ? a : b gives the ternary message even though the call ate the space", () => {
    const parsed = parseValue("foo() ? a : b") as any;
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toContain("Agency has no ternary");
  });

  it("a ?? b is still nullish coalescing", () => {
    const parsed = parseValue("a ?? b") as any;
    expect(parsed.success).toBe(true);
    expect(parsed.value.type).toBe("binOpExpression");
    expect(parsed.value.operator).toBe("??");
  });

  it("cond ? a : b gives the ternary message", () => {
    const parsed = parseValue("cond ? a : b") as any;
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toContain("Agency has no ternary");
  });

  it("cond? a : b gives the ternary message", () => {
    const parsed = parseValue("cond? a : b") as any;
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toContain("Agency has no ternary");
  });
});
