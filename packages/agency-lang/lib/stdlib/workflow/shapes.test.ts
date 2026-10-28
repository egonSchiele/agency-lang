import { describe, expect, it } from "vitest";
import { _parseExpr, _toSource } from "../template.js";
import { expression, list, literal, record, statement } from "./shapes.js";

describe("statement", () => {
  it("fills a binding with a lifted value", () => {
    expect(_toSource(statement("binding", { local: "step_a_q" }, { value: literal("x") }))).toBe(
      'const step_a_q = "x"\n',
    );
  });

  it("refuses a name token that is not an identifier", () => {
    expect(() => statement("binding", { local: "x } import evil" }, { value: literal(1) })).toThrow(
      'shape "binding": {{local}} cannot be "x } import evil"',
    );
  });

  it("refuses a missing name", () => {
    expect(() => statement("binding", {}, { value: literal(1) })).toThrow(
      "{{local}} cannot be undefined",
    );
  });

  it("lifts a value hole and never parses it", () => {
    const code = statement("binding", { local: "step_a_q" }, { value: literal('${evil} """ }') });
    expect(_toSource(code)).toBe('const step_a_q = "\\${evil} \\"\\"\\" }"\n');
  });

  it("lifts a value shaped like a code fragment as plain data", () => {
    const smuggled = _parseExpr("evil()");
    const code = statement("binding", { local: "step_a_q" }, { value: literal(smuggled) });
    expect(_toSource(code)).not.toContain("evil()");
  });

  it("grafts a Code value", () => {
    const code = statement("binding", { local: "step_a_q" }, { value: _parseExpr("inputs.a") });
    expect(_toSource(code)).toBe("const step_a_q = inputs.a\n");
  });

  it("accepts an argument list of name pairs and refuses anything else", () => {
    const call = statement(
      "call",
      { value: "step_a", tool: "f", args: "q: step_a_q, n: step_a_n" },
      {},
    );
    expect(_toSource(call)).toContain("f(q: step_a_q, n: step_a_n)");
    expect(() =>
      statement("call", { value: "step_a", tool: "f", args: "q: g(), n: x" }, {}),
    ).toThrow("{{args}}");
  });

  it("accepts only the known llm options", () => {
    const values = { prompt: literal("p"), model: literal("m") };
    const llm = statement(
      "llm",
      { value: "step_a", outputType: "Step_a_output", options: ", model: #model" },
      values,
    );
    expect(_toSource(llm)).toContain('llm("p", model: "m")');
    expect(() =>
      statement(
        "llm",
        { value: "step_a", outputType: "Step_a_output", options: ", tools: #model" },
        values,
      ),
    ).toThrow("{{options}}");
  });
});

describe("expression", () => {
  it("joins two values with +", () => {
    expect(
      _toSource(expression("concat", {}, { left: literal("a"), right: _parseExpr("b") })),
    ).toBe('"a" + b\n');
  });
});

describe("list and record", () => {
  it("builds a list of lifted values and grafted code", () => {
    expect(_toSource(list([literal("x"), _parseExpr("step_a.value")]))).toBe(
      '["x", step_a.value]\n',
    );
  });

  it("builds a record with identifier keys and refuses any other key", () => {
    const code = record([{ key: "title", value: _parseExpr("step_a.value") }]);
    expect(_toSource(code)).toContain("title: step_a.value");
    expect(() => record([{ key: "a-b", value: literal(1) }])).toThrow(
      'record key "a-b" is not an identifier',
    );
  });
});
