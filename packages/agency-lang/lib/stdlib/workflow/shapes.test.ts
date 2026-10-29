import { describe, expect, it } from "vitest";
import { _parseExpr, _parseStatements, _toSource } from "../template.js";
import { expression, guardArgs, list, literal, record, statement } from "./shapes.js";

describe("guardArgs", () => {
  it("prints one piece per limit that is set, time first", () => {
    expect(guardArgs({ maxTime: 120000, maxCost: 5 })).toEqual(["time: 120000", "cost: 5"]);
    expect(guardArgs({ maxCost: 0.5 })).toEqual(["cost: 0.5"]);
    expect(guardArgs({})).toEqual([]);
  });
});

describe("guarded", () => {
  it("wraps a returned call in a labeled guard with the limits", () => {
    const body = statement(
      "returnCall",
      { tool: "addListItems", args: "items: step_add_items" },
      {},
    );
    const code = statement(
      "guarded",
      { value: "step_add", limits: ", time: 120000" },
      { label: literal("add"), body },
    );
    expect(_toSource(code)).toBe(
      [
        'const step_add = guard(label: "add", time: 120000) {',
        "  return addListItems(items: step_add_items)",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("spreads a body of several statements into the block", () => {
    const body = _parseStatements("const a = 1\nreturn a");
    const code = statement(
      "guarded",
      { value: "step_m", limits: "" },
      { label: literal("m"), body },
    );
    expect(_toSource(code)).toBe(
      ['const step_m = guard(label: "m") {', "  const a = 1", "  return a", "}", ""].join("\n"),
    );
  });

  it("wraps an llm thread whose last line returns the reply", () => {
    const names = { reply: "step_m_reply", outputType: "Step_m_output", options: "" };
    const body = statement(
      "llmThread",
      { ...names, after: "return step_m_reply" },
      { prompt: literal("p") },
    );
    const code = statement(
      "guarded",
      { value: "step_m", limits: "" },
      { label: literal("m"), body },
    );
    expect(_toSource(code)).toBe(
      [
        'const step_m = guard(label: "m") {',
        "  thread {",
        '    const step_m_reply: Step_m_output = llm("p")',
        "    return step_m_reply",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expect(() =>
      statement("llmThread", { ...names, after: "return evil()" }, { prompt: literal("p") }),
    ).toThrow("{{after}}");
  });

  it("accepts only what guardArgs prints as limits", () => {
    const body = statement("returnCall", { tool: "f", args: "" }, {});
    const values = { label: literal("a"), body };
    for (const limits of [", retries: 3", ", time: abc", "time: 1", ", time: 1,cost: 2"]) {
      expect(() => statement("guarded", { value: "step_a", limits }, values)).toThrow("{{limits}}");
    }
    expect(() =>
      statement("guarded", { value: "step_a", limits: ", time: 1, cost: 0.5" }, values),
    ).not.toThrow();
  });
});

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
    const names = {
      reply: "step_a_reply",
      outputType: "Step_a_output",
      after: "step_a = step_a_reply",
    };
    const llm = statement("llmThread", { ...names, options: ", model: #model" }, values);
    expect(_toSource(llm)).toContain('llm("p", model: "m")');
    expect(() => statement("llmThread", { ...names, options: ", tools: #model" }, values)).toThrow(
      "{{options}}",
    );
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
