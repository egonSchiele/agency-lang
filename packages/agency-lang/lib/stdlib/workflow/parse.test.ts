import { describe, expect, it } from "vitest";
import { parseWorkflow } from "./parse.js";
import { isIdentifier, refsIn } from "./types.js";
import { mealPlan, withArg, withFields, withStep } from "./testFixtures.js";

describe("parseWorkflow", () => {
  it("accepts the meal plan", () => {
    expect(parseWorkflow(mealPlan).problems).toEqual([]);
    expect(parseWorkflow(mealPlan).workflow).toEqual(mealPlan);
  });

  it("refuses a value that is not an object", () => {
    expect(parseWorkflow([]).problems).toEqual([
      { step: null, field: null, message: "a workflow must be a JSON object" },
    ]);
  });

  it("refuses a step id that is not an identifier", () => {
    expect(parseWorkflow(withStep(mealPlan, 0, { id: "x } import evil" })).problems).toEqual([
      {
        step: "x } import evil",
        field: "id",
        message: 'step id "x } import evil" is not an identifier',
      },
    ]);
  });

  it("refuses a step id that starts with a digit", () => {
    expect(parseWorkflow(withStep(mealPlan, 0, { id: "1note" })).problems).toEqual([
      { step: "1note", field: "id", message: 'step id "1note" is not an identifier' },
    ]);
  });

  it("refuses a reserved step id", () => {
    const problems = parseWorkflow(withStep(mealPlan, 0, { id: "__note" })).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ step: "__note", field: "id" });
    expect(problems[0].message).toContain("reserved");
  });

  it("refuses a tool name that is not an identifier", () => {
    expect(parseWorkflow(withStep(mealPlan, 0, { tool: "a.b" })).problems).toEqual([
      { step: "note", field: "tool", message: 'tool name "a.b" is not an identifier' },
    ]);
  });

  it("refuses an argument name that is not an identifier", () => {
    expect(parseWorkflow(withArg(mealPlan, "list", "x: 1, y", "z")).problems).toEqual([
      {
        step: "list",
        field: "args.x: 1, y",
        message: 'argument name "x: 1, y" is not an identifier',
      },
    ]);
  });

  it("refuses a name that is not an identifier", () => {
    expect(parseWorkflow(withFields(mealPlan, { name: "my workflow" })).problems).toEqual([
      { step: null, field: "name", message: 'name "my workflow" is not an identifier' },
    ]);
  });

  it("refuses a format other than 1", () => {
    expect(parseWorkflow(withFields(mealPlan, { format: 2 })).problems).toEqual([
      { step: null, field: "format", message: "format must be 1, got 2" },
    ]);
  });

  it("refuses a duplicate step id on the second occurrence", () => {
    expect(parseWorkflow(withStep(mealPlan, 2, { id: "note" })).problems).toEqual([
      { step: "note", field: "id", message: 'step id "note" is used by an earlier step' },
    ]);
  });

  it("refuses an unknown kind", () => {
    expect(parseWorkflow(withStep(mealPlan, 0, { kind: "shell" })).problems).toEqual([
      { step: "note", field: "kind", message: 'kind must be "tool" or "llm", got "shell"' },
    ]);
  });

  it("refuses a tool step with no module", () => {
    expect(parseWorkflow(withStep(mealPlan, 0, { module: 3 })).problems).toEqual([
      { step: "note", field: "module", message: "module must be a string" },
    ]);
  });

  it("refuses a malformed reference path", () => {
    expect(
      parseWorkflow(withArg(mealPlan, "text", "id", { $ref: "steps.note[0.id" })).problems,
    ).toEqual([
      {
        step: "text",
        field: "args.id",
        message: 'reference "steps.note[0.id" is not a well-formed path',
      },
    ]);
  });

  it("refuses an object that has $ref beside other keys", () => {
    expect(
      parseWorkflow(withArg(mealPlan, "text", "id", { $ref: "steps.note", other: 1 })).problems,
    ).toEqual([
      { step: "text", field: "args.id", message: "a reference must have exactly one key, $ref" },
    ]);
  });

  it("checks a reference nested inside an argument and in result", () => {
    const wf = withFields(withArg(mealPlan, "add", "items", [{ $ref: "steps" }]), {
      result: { $ref: "x.y" },
    });
    expect(parseWorkflow(wf).problems).toEqual([
      { step: "add", field: "args.items", message: 'reference "steps" is not a well-formed path' },
      { step: null, field: "result", message: 'reference "x.y" is not a well-formed path' },
    ]);
  });

  it("refuses a value that cannot be written as a literal", () => {
    const withProto = JSON.parse('{ "__proto__": 1 }');
    // Infinity last: each helper copies through JSON, which would turn it into null.
    const wf = withArg(withArg(mealPlan, "add", "section", withProto), "list", "query", 1e400);
    expect(parseWorkflow(wf).problems).toEqual([
      {
        step: "list",
        field: "args.query",
        message: "Infinity cannot be written as a number literal",
      },
      { step: "add", field: "args.section", message: 'an object may not have the key "__proto__"' },
    ]);
  });

  it("refuses a non-identifier key in an object that holds a reference", () => {
    const wf = withArg(mealPlan, "add", "items", { "a-b": { $ref: "steps.meals" } });
    expect(parseWorkflow(wf).problems).toEqual([
      {
        step: "add",
        field: "args.items",
        message:
          'key "a-b" is not an identifier; an object that holds a reference needs identifier keys',
      },
    ]);
  });

  it("accepts any key in an object that holds no reference", () => {
    expect(parseWorkflow(withArg(mealPlan, "add", "section", { "a-b": 1 })).problems).toEqual([]);
  });

  it("refuses a workflow with no steps", () => {
    expect(parseWorkflow(withFields(mealPlan, { steps: [], result: "x" })).problems).toEqual([
      { step: null, field: "steps", message: "steps must hold at least one step" },
    ]);
  });

  it("refuses an llm step with an empty prompt", () => {
    expect(parseWorkflow(withStep(mealPlan, 3, { prompt: "" })).problems).toEqual([
      { step: "meals", field: "prompt", message: "prompt must be a non-empty string" },
    ]);
  });

  it("refuses an llm step whose context is not a list", () => {
    expect(parseWorkflow(withStep(mealPlan, 3, { context: "x" })).problems).toEqual([
      { step: "meals", field: "context", message: "context must be a list" },
    ]);
  });

  it("refuses an input name that is not an identifier", () => {
    expect(parseWorkflow(withFields(mealPlan, { inputs: "{ 1x: string }" })).problems).toEqual([
      { step: null, field: "inputs", message: 'input name "1x" is not an identifier' },
    ]);
  });

  it("ignores a colon inside a string literal type", () => {
    expect(
      parseWorkflow(withFields(mealPlan, { inputs: '{ mode: "a:b" | "c", n?: number }' })).problems,
    ).toEqual([]);
  });

  it("refuses limits it cannot write as a number", () => {
    expect(
      parseWorkflow(withFields(mealPlan, { limits: { maxCost: null, steps: 3 } })).problems,
    ).toEqual([
      { step: null, field: "limits.maxCost", message: "limits.maxCost must be a finite number" },
      {
        step: null,
        field: "limits.steps",
        message: 'limits has no field "steps"; it takes maxCost and maxTime',
      },
    ]);
  });

  it("reports every problem, not the first", () => {
    const wf = withStep(withStep(mealPlan, 0, { id: "a b" }), 1, { id: "c d" });
    expect(parseWorkflow(wf).problems.map((p) => p.step)).toEqual(["a b", "c d"]);
  });
});

describe("isIdentifier", () => {
  it("accepts a plain name and refuses everything else", () => {
    expect(["note", "_x", "a1"].map(isIdentifier)).toEqual([true, true, true]);
    expect(["", "1a", "a-b", "a b", "__x"].map(isIdentifier)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("refsIn", () => {
  it("finds every reference in document order and does not descend into one", () => {
    expect(refsIn({ a: [{ $ref: "inputs.x" }, { b: { $ref: "steps.y" } }], c: "s" })).toEqual([
      { $ref: "inputs.x" },
      { $ref: "steps.y" },
    ]);
  });
});
