import { describe, expect, it } from "vitest";
import { _parseExpr, _parseStatements } from "../template.js";
import { renderWorkflow } from "./render.js";
import type { Lowered, Owner } from "./types.js";

const oa: Owner = { step: "a", field: "args.q" };
const ob: Owner = { step: "a", field: "args" };

const lowered: Lowered = {
  imports: ['import { f } from "./f.agency"'],
  types: [{ name: "Inputs", text: "{ q: string }", owner: null }],
  body: [
    { code: _parseStatements("const a = 1"), owner: oa },
    { code: _parseStatements("if (a is failure) {\n  return a\n}"), owner: ob },
  ],
  result: _parseExpr("a"),
  guard: null,
};

const withInputs = (text: string): Lowered => ({
  ...lowered,
  types: [{ name: "Inputs", text, owner: null }],
});

describe("renderWorkflow", () => {
  it("renders the whole program", () => {
    expect(renderWorkflow(lowered).source).toBe(
      [
        'import { Json } from "std::validation"',
        'import { f } from "./f.agency"',
        "",
        "type Inputs = {",
        "  q: string",
        "}",
        "",
        "export node main(inputs: Inputs): Result {",
        "  const a = 1",
        "  if (a is failure) {",
        "    return a",
        "  }",
        "  return success(a)",
        "}",
        "",
        "export node inputsSchema(): Json {",
        "  return schema(Inputs).toJSONSchema()",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("renders the body and the ranges from the same prints", () => {
    const r = renderWorkflow(lowered);
    expect(r.source!.split("\n").slice(8, 12)).toEqual([
      "  const a = 1",
      "  if (a is failure) {",
      "    return a",
      "  }",
    ]);
    expect(r.ranges).toEqual([
      { from: 9, to: 9, owner: oa },
      { from: 10, to: 12, owner: ob },
    ]);
  });

  it("indents the body by four under a guard and shifts the ranges by one", () => {
    const r = renderWorkflow({ ...lowered, guard: { maxTime: 300000, maxCost: 1 } });
    const lines = r.source!.split("\n");
    expect(lines.slice(7, 15)).toEqual([
      "export node main(inputs: Inputs): Result {",
      "  return guard(time: 300000, cost: 1) {",
      "    const a = 1",
      "    if (a is failure) {",
      "      return a",
      "    }",
      "    return success(a)",
      "  }",
    ]);
    expect(r.ranges).toEqual([
      { from: 10, to: 10, owner: oa },
      { from: 11, to: 13, owner: ob },
    ]);
  });

  it("writes only the limits that are set", () => {
    expect(renderWorkflow({ ...lowered, guard: { maxCost: 0.5 } }).source).toContain(
      "  return guard(cost: 0.5) {",
    );
    expect(renderWorkflow({ ...lowered, guard: {} }).source).not.toContain("guard");
  });

  it("does not read $ patterns in a print as replacement syntax", () => {
    const r = renderWorkflow({ ...lowered, result: _parseExpr('"$& $1 $$"') });
    expect(r.source).toContain('  return success("$& $1 $$")');
  });

  it("canonicalizes a type", () => {
    const r = renderWorkflow(withInputs("{noteTitle:string,   count?: number}"));
    expect(r.source).toContain("type Inputs = {\n  noteTitle: string;\n  count?: number\n}\n");
  });

  it("refuses type text that carries a second declaration", () => {
    expect(
      renderWorkflow(withInputs("{ a: string }\nexport node evil() { return 1 }")).problems,
    ).toEqual([{ step: null, field: "inputs", message: "inputs must be one object type" }]);
  });

  it("refuses type text that carries a statement", () => {
    expect(
      renderWorkflow(withInputs('{ a: string }\nimport { x } from "./x.agency"')).problems,
    ).toEqual([{ step: null, field: "inputs", message: "inputs must be one object type" }]);
  });

  it("refuses inputs that are not an object type", () => {
    expect(renderWorkflow(withInputs("string")).problems).toEqual([
      { step: null, field: "inputs", message: "inputs must be one object type" },
    ]);
  });

  it("refuses type text that does not parse", () => {
    expect(renderWorkflow(withInputs("{ a: ")).problems).toEqual([
      { step: null, field: "inputs", message: "inputs must be one object type" },
    ]);
  });

  it("refuses an llm output type the same way, naming the step", () => {
    const types = [
      ...lowered.types,
      {
        name: "Step_m_output",
        text: "string[]\nexport node evil() {}",
        owner: { step: "m", field: "output" },
      },
    ];
    expect(renderWorkflow({ ...lowered, types }).problems).toEqual([
      { step: "m", field: "output", message: "output must be one type" },
    ]);
  });

  it("accepts any single type as an llm output", () => {
    const types = [
      ...lowered.types,
      { name: "Step_m_output", text: "string[]", owner: { step: "m", field: "output" } },
    ];
    expect(renderWorkflow({ ...lowered, types }).source).toContain(
      "type Step_m_output = string[]\n",
    );
  });

  it("is deterministic", () => {
    expect(renderWorkflow(lowered).source).toBe(renderWorkflow(lowered).source);
  });
});
