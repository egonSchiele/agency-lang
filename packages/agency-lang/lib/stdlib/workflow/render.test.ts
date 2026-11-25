import { describe, expect, it } from "vitest";
import { _parseExpr, _parseStatements } from "../template.js";
import { lowerWorkflow } from "./lower.js";
import { renderWorkflow } from "./render.js";
import { resolveWorkflow } from "./resolve.js";
import { eachPlan, matchPlan, mealRefs, mealSignatures } from "./testFixtures.js";
import type { Lowered, Owner, Workflow } from "./types.js";

const oa: Owner = { step: "a", field: "args.q" };
const ob: Owner = { step: "a", field: "args" };
const inputsOwner: Owner = { step: null, field: "inputs" };
const resultOwner: Owner = { step: null, field: "result" };

const lowered: Lowered = {
  imports: ['import { f } from "./f.agency"'],
  types: [{ name: "Inputs", text: "{ q: string }", owner: inputsOwner }],
  body: [
    { code: _parseStatements("const a = 1"), owner: oa, depth: 0 },
    { code: _parseStatements("if (a is failure) {\n  return a\n}"), owner: ob, depth: 0 },
  ],
  result: _parseExpr("a"),
  guard: null,
  guardLabel: "wf",
  guardLabels: [],
};

const withInputs = (text: string): Lowered => ({
  ...lowered,
  types: [{ name: "Inputs", text, owner: inputsOwner }],
});

const withOutput = (text: string): Lowered => ({
  ...lowered,
  types: [...lowered.types, { name: "Step_m_output", text, owner: { step: "m", field: "output" } }],
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
        "export node main(inputs: Inputs!): Result {",
        "  handle {",
        "    const a = 1",
        "    if (a is failure) {",
        "      return a",
        "    }",
        "    return success(a)",
        "  } with (guardTrip) {",
        '    if (guardTrip.effect == "std::guard" && [].includes(guardTrip.data.label)) {',
        "      return reject()",
        "    }",
        "    return pass()",
        "  }",
        "}",
        "",
        "export node workflowSchemas(): Json {",
        "  return {",
        '    inputs: schema(Inputs).toJSONSchema("input"),',
        "    outputs: {}",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("lists each llm step's output schema by step id", () => {
    const types = [
      ...lowered.types,
      { name: "Step_m_output", text: "string[]", owner: { step: "m", field: "output" } },
      { name: "Step_n_output", text: "{ title: string }", owner: { step: "n", field: "output" } },
    ];
    expect(renderWorkflow({ ...lowered, types }).source).toContain(
      [
        "export node workflowSchemas(): Json {",
        "  return {",
        '    inputs: schema(Inputs).toJSONSchema("input"),',
        "    outputs: {",
        '      "m": schema(Step_m_output).toJSONSchema(),',
        '      "n": schema(Step_n_output).toJSONSchema()',
        "    }",
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("renders the body and the ranges from the same prints", () => {
    const r = renderWorkflow(lowered);
    expect(r.source!.split("\n").slice(9, 13)).toEqual([
      "    const a = 1",
      "    if (a is failure) {",
      "      return a",
      "    }",
    ]);
    expect(r.ranges).toEqual([
      { from: 4, to: 6, owner: inputsOwner },
      { from: 10, to: 10, owner: oa },
      { from: 11, to: 13, owner: ob },
      { from: 14, to: 14, owner: resultOwner },
    ]);
  });

  it("indents the body by six under a guard and shifts the ranges by one more", () => {
    const r = renderWorkflow({
      ...lowered,
      guard: { maxTime: 300000, maxCost: 1 },
      guardLabels: ["wf", "a"],
    });
    const lines = r.source!.split("\n");
    expect(lines.slice(7, 18)).toEqual([
      "export node main(inputs: Inputs!): Result {",
      "  handle {",
      '    return guard(label: "wf", time: 300000, cost: 1) {',
      "      const a = 1",
      "      if (a is failure) {",
      "        return a",
      "      }",
      "      return success(a)",
      "    }",
      "  } with (guardTrip) {",
      '    if (guardTrip.effect == "std::guard" && ["wf","a"].includes(guardTrip.data.label)) {',
    ]);
    expect(r.ranges).toEqual([
      { from: 4, to: 6, owner: inputsOwner },
      { from: 11, to: 11, owner: oa },
      { from: 12, to: 14, owner: ob },
      { from: 15, to: 15, owner: resultOwner },
    ]);
  });

  it("writes only the limits that are set", () => {
    expect(renderWorkflow({ ...lowered, guard: { maxCost: 0.5 } }).source).toContain(
      '    return guard(label: "wf", cost: 0.5) {',
    );
    expect(renderWorkflow({ ...lowered, guard: {} }).source).not.toContain("return guard(");
  });

  it("does not read $ patterns in a print as replacement syntax", () => {
    const r = renderWorkflow({ ...lowered, result: _parseExpr('"$& $1 $$"') });
    expect(r.source).toContain('    return success("$& $1 $$")');
  });

  it("canonicalizes a type", () => {
    const r = renderWorkflow(withInputs("{noteTitle:string,   count?: number}"));
    expect(r.source).toContain("type Inputs = {\n  noteTitle: string;\n  count?: number\n}\n");
  });

  it("names the owner of each declared type", () => {
    const types = [
      ...lowered.types,
      { name: "Step_m_output", text: "string[]", owner: { step: "m", field: "output" } },
    ];
    expect(renderWorkflow({ ...lowered, types }).typeOwners).toEqual({
      Inputs: inputsOwner,
      Step_m_output: { step: "m", field: "output" },
    });
  });

  it("writes an llm output type as one line", () => {
    expect(renderWorkflow(withOutput("string[]")).source).toContain(
      "type Step_m_output = string[]\n",
    );
  });

  it("throws on type text parse did not accept", () => {
    expect(() => renderWorkflow(withInputs("string"))).toThrow(
      "type text reached render unchecked",
    );
  });

  it("is deterministic", () => {
    expect(renderWorkflow(lowered).source).toBe(renderWorkflow(lowered).source);
  });
});

/** Every stage but parse, on a fixture workflow. */
const render = (wf: Workflow) =>
  renderWorkflow(lowerWorkflow(resolveWorkflow(wf, mealRefs, mealSignatures).resolved!));

describe("renderWorkflow match and each", () => {
  it("prints an each block with its steps two levels deeper", () => {
    const { source } = render(eachPlan);
    expect(source).toContain(
      [
        "    for (step_note_item in step_note_over) {",
        "      thread {",
        "        const step_text_id = step_note_item.id",
      ].join("\n"),
    );
    expect(source).toContain(
      ["        }", "      }", "    }", "    const step_done_query"].join("\n"),
    );
  });

  it("prints a match as an if/else-if chain that closes once", () => {
    const { source } = render(matchPlan);
    expect(source).toMatch(
      /if \(step_route_case1\) \{[\s\S]*\} else if \(step_route_case2\) \{\n\s*\} else \{[\s\S]*no case matches/,
    );
    expect(source).toContain('      const step_add_items = ["urgent"]');
  });

  it("gives every owned line the right owner", () => {
    const { source, ranges } = render(eachPlan);
    const lines = source.split("\n");
    const ownerOf = (text: string) => {
      const line = lines.findIndex((entry) => entry.includes(text)) + 1;
      return ranges.find((range) => range.from <= line && line <= range.to)?.owner;
    };
    expect(ownerOf("const step_note_over =")).toEqual({ step: "note", field: "over" });
    expect(ownerOf("for (step_note_item")).toEqual({ step: "note", field: "over" });
    expect(ownerOf("thread {")).toEqual({ step: "note", field: "over" });
    expect(ownerOf("const step_text_id =")).toEqual({ step: "text", field: "args.id" });
    expect(ownerOf("return success(")).toEqual({ step: null, field: "result" });
  });
});
