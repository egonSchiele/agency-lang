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

  it("refuses a reserved input name", () => {
    expect(parseWorkflow(withFields(mealPlan, { inputs: "{ __x: string }" })).problems).toEqual([
      {
        step: null,
        field: "inputs",
        message:
          'input name "__x" is reserved: names that start with two underscores belong to the compiler',
      },
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
      { step: null, field: "limits.maxCost", message: "limits.maxCost must be a positive number" },
      {
        step: null,
        field: "limits.steps",
        message: 'limits has no field "steps"; it takes maxCost and maxTime',
      },
    ]);
  });

  it("refuses a limit that is not positive", () => {
    expect(parseWorkflow(withFields(mealPlan, { limits: { maxCost: -1 } })).problems).toEqual([
      { step: null, field: "limits.maxCost", message: "limits.maxCost must be a positive number" },
    ]);
    expect(parseWorkflow(withFields(mealPlan, { limits: { maxTime: 0 } })).problems).toEqual([
      { step: null, field: "limits.maxTime", message: "limits.maxTime must be a positive number" },
    ]);
  });

  it("caps maxTime below run's one-hour ceiling", () => {
    expect(parseWorkflow(withFields(mealPlan, { limits: { maxTime: 3570001 } })).problems).toEqual([
      {
        step: null,
        field: "limits.maxTime",
        message: "limits.maxTime must be at most 3570000 (one hour less 30 seconds)",
      },
    ]);
    expect(parseWorkflow(withFields(mealPlan, { limits: { maxTime: 3570000 } })).problems).toEqual(
      [],
    );
  });

  it("refuses a limit the program would write in exponent form", () => {
    expect(
      parseWorkflow(withFields(mealPlan, { limits: { maxCost: 0.0000001 } })).problems,
    ).toEqual([
      {
        step: null,
        field: "limits.maxCost",
        message:
          "limits.maxCost must be a number the program can write as a plain decimal such as 0.5; 1e-7 is not one",
      },
    ]);
    expect(parseWorkflow(withFields(mealPlan, { limits: { maxCost: 0.000001 } })).problems).toEqual(
      [],
    );
  });

  it("accepts limits on a step and keeps them", () => {
    const wf = withStep(mealPlan, 4, { limits: { maxTime: 120000, maxCost: 5 } });
    const parsed = parseWorkflow(wf);
    expect(parsed.problems).toEqual([]);
    expect(parsed.workflow!.steps[4]).toMatchObject({ limits: { maxTime: 120000, maxCost: 5 } });
  });

  it("names the step for a bad step limit", () => {
    expect(parseWorkflow(withStep(mealPlan, 4, { limits: { maxTime: -5 } })).problems).toEqual([
      { step: "add", field: "limits.maxTime", message: "limits.maxTime must be a positive number" },
    ]);
    expect(parseWorkflow(withStep(mealPlan, 4, { limits: { retries: 3 } })).problems).toEqual([
      {
        step: "add",
        field: "limits.retries",
        message: 'limits has no field "retries"; it takes maxCost and maxTime',
      },
    ]);
  });

  it("refuses a step maxTime the workflow's maxTime does not cover", () => {
    expect(parseWorkflow(withStep(mealPlan, 4, { limits: { maxTime: 300001 } })).problems).toEqual([
      {
        step: "add",
        field: "limits.maxTime",
        message:
          "limits.maxTime (300001) is more than the workflow's maxTime (300000), so the workflow's guard would trip first",
      },
    ]);
    const { limits, ...noLimits } = mealPlan;
    expect(parseWorkflow(withStep(noLimits, 4, { limits: { maxTime: 1000 } })).problems).toEqual([
      {
        step: "add",
        field: "limits.maxTime",
        message:
          "limits.maxTime needs the workflow to set a maxTime of at least 1000; the subprocess wall clock comes from the workflow's maxTime",
      },
    ]);
    expect(parseWorkflow(withStep(mealPlan, 4, { limits: { maxTime: 300000 } })).problems).toEqual(
      [],
    );
    expect(parseWorkflow(withStep(noLimits, 4, { limits: { maxCost: 1 } })).problems).toEqual([]);
  });

  it("accepts a workflow with no result and no limits", () => {
    const { result, limits, ...bare } = mealPlan;
    expect(parseWorkflow(bare).problems).toEqual([]);
  });

  it("refuses a tag in type text, naming the field", () => {
    const tagged = "{\n  @validate(addListItems)\n  noteTitle: string\n}";
    expect(parseWorkflow(withFields(mealPlan, { inputs: tagged })).problems).toEqual([
      {
        step: null,
        field: "inputs",
        message: "a type in inputs may not carry @validate or @jsonSchema tags",
      },
    ]);
    expect(parseWorkflow(withStep(mealPlan, 3, { output: tagged })).problems).toEqual([
      {
        step: "meals",
        field: "output",
        message: "a type in output may not carry @validate or @jsonSchema tags",
      },
    ]);
  });

  it("does not read a nested property name as an input", () => {
    const nested = withFields(mealPlan, { inputs: "{ a: { noteTitle: string } }" });
    expect(parseWorkflow(nested).problems).toEqual([]);
  });

  it("carries the parser's message for type text that does not parse", () => {
    const problems = parseWorkflow(withFields(mealPlan, { inputs: "{ a: " })).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toMatch(/^inputs must be one object type: .+/);
  });

  it("reads null as absent for the optional fields", () => {
    const wf = withStep(withFields(mealPlan, { limits: null, result: null }), 3, {
      model: null,
      provider: null,
    });
    expect(parseWorkflow(wf).problems).toEqual([]);
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
