import { describe, expect, it } from "vitest";
import { _toSource } from "../template.js";
import { lowerWorkflow } from "./lower.js";
import { resolveWorkflow } from "./resolve.js";
import { isLine, type Fragment, type ResolvedWorkflow, type Workflow } from "./types.js";
import {
  eachPlan,
  edited,
  matchPlan,
  mealPlan,
  mealRefs,
  mealSignatures,
  withArg,
  withStep,
} from "./testFixtures.js";

const resolved = (wf: unknown = mealPlan, signatures = mealSignatures): ResolvedWorkflow =>
  resolveWorkflow(wf as Workflow, mealRefs, signatures).resolved!;
/** A fragment as text: a block line with its newline, or a printed statement. */
const textOf = (f: Fragment) => (isLine(f) ? f.line + "\n" : _toSource(f.code));
const print = (f: Fragment) => [textOf(f), f.owner] as const;
const printAll = (r: ResolvedWorkflow) => lowerWorkflow(r).body.map(textOf).join("");
/** Every block line, with its depth and owner. */
const lines = (body: Fragment[]) =>
  body.filter(isLine).map((f) => [f.line, f.depth, f.owner] as const);
/** The statement whose print starts with `text`. */
const fragmentFor = (body: Fragment[], text: string) =>
  body.find((f) => !isLine(f) && textOf(f).startsWith(text))!;

describe("lowerWorkflow", () => {
  it("lowers the meal plan to fragments", () => {
    const lowered = lowerWorkflow(resolved());
    expect(lowered.imports).toEqual([
      'import { addListItems, findLists } from "./lists.agency"',
      'import { readNote, searchNotes } from "./notes.agency"',
    ]);
    expect(lowered.types).toEqual([
      { name: "Inputs", text: "{ noteTitle: string }", owner: { step: null, field: "inputs" } },
      { name: "Step_meals_output", text: "string[]", owner: { step: "meals", field: "output" } },
    ]);
    expect(lowered.body.slice(0, 2).map(print)).toEqual([
      ["const step_note_query = inputs.noteTitle\n", { step: "note", field: "args.query" }],
      ["const step_note = searchNotes(query: step_note_query)\n", { step: "note", field: "args" }],
    ]);
    expect(print(lowered.body[2])).toEqual([
      [
        "if (step_note is failure) {",
        "  return failure(",
        '    "step note (searchNotes): ${step_note.error}",',
        "    {",
        '      step: "note",',
        "      cause: step_note",
        "    },",
        "  )",
        "}",
        "",
      ].join("\n"),
      { step: "note", field: "args" },
    ]);
    expect(textOf(lowered.body[3])).toBe("const step_text_id = step_note.value[0].id\n");
    expect(_toSource(lowered.result)).toBe("step_add.value\n");
    expect(lowered.guard).toEqual({ maxCost: 1, maxTime: 300000 });
  });

  it("lifts a literal argument and never parses it", () => {
    const body = printAll(resolved(withArg(mealPlan, "list", "query", '${evil} """ }')));
    expect(body).toContain('const step_list_query = "\\${evil} \\"\\"\\" }"\n');
  });

  it("keeps the check but omits .value for a plain return", () => {
    const signatures = {
      ...mealSignatures,
      "./lists.agency.findLists": {
        signature: "findLists(query: string): string[]",
        returnType: "string[]",
        returnsResult: false,
        docstring: null,
        params: [],
      },
    };
    const body = printAll(resolved(mealPlan, signatures));
    expect(body).toContain("if (step_list is failure) {");
    // A plain type has no `.error`; the unchecked cast changes only what the checker sees.
    expect(body).toContain('"step list (findLists): ${(step_list as any).error}",');
    expect(body).toContain("const step_add_listId = step_list[0].id\n");
    expect(body).not.toContain("step_list.value");
  });

  it("lowers an llm step with its context and model", () => {
    const lowered = lowerWorkflow(resolved(withStep(mealPlan, 3, { model: "gpt-5" })));
    const meals = lowered.body.filter((f) => f.owner?.step === "meals").map(print);
    expect(meals).toEqual([
      [
        "const step_meals_context1 = step_text.value.body\n",
        { step: "meals", field: "context[0]" },
      ],
      [
        "const step_meals_context1_text = if step_meals_context1 is string then step_meals_context1 else JSON.stringify(step_meals_context1)\n",
        { step: "meals", field: "context[0]" },
      ],
      [
        "let step_meals: Step_meals_output = null as Step_meals_output\n",
        { step: "meals", field: "prompt" },
      ],
      [
        [
          "thread {",
          "  const step_meals_reply: Step_meals_output = llm(",
          `    "${mealPlan.steps[3].kind === "llm" ? mealPlan.steps[3].prompt : ""}" + "\\n\\nContext 1 (steps.text.body):\\n" + step_meals_context1_text,`,
          '    model: "gpt-5",',
          "  )",
          "  step_meals = step_meals_reply",
          "}",
          "",
        ].join("\n"),
        { step: "meals", field: "prompt" },
      ],
    ]);
  });

  it("guards a tool step that has limits, then checks it", () => {
    const lowered = lowerWorkflow(
      resolved(withStep(mealPlan, 4, { limits: { maxTime: 120000, maxCost: 0.5 } })),
    );
    const add = lowered.body.filter((f) => f.owner?.step === "add" && f.owner.field === "args");
    expect(add.map((f) => f.owner)).toEqual([
      { step: "add", field: "args" },
      { step: "add", field: "args" },
    ]);
    const [guardText, checkText] = add.map(textOf);
    expect(guardText).toContain('const step_add = guard(label: "add", time: 120000, cost: 0.5) {');
    expect(guardText).toContain("  return addListItems(");
    expect(guardText).toContain("    section: step_add_section,");
    expect(guardText).toContain("\n}\n");
    expect(checkText).toContain('"step add (addListItems): ${step_add.error}",');
  });

  it("guards an llm step that has limits, declaring the reply inside, then checks it", () => {
    const lowered = lowerWorkflow(resolved(withStep(mealPlan, 3, { limits: { maxTime: 60000 } })));
    const meals = lowered.body
      .filter((f) => f.owner?.step === "meals" && f.owner.field === "prompt")
      .map(textOf);
    expect(meals[0]).toBe(
      [
        'const step_meals = guard(label: "meals", time: 60000) {',
        "  thread {",
        "    const step_meals_reply: Step_meals_output = llm(",
        `      "${mealPlan.steps[3].kind === "llm" ? mealPlan.steps[3].prompt : ""}" + "\\n\\nContext 1 (steps.text.body):\\n" + step_meals_context1_text,`,
        "    )",
        "    return step_meals_reply",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expect(meals[1]).toContain('"step meals (llm): ${step_meals.error}",');
    // The guard gives the step a Result, so a later reference reads through .value.
    expect(printAll(resolved(withStep(mealPlan, 3, { limits: { maxTime: 60000 } })))).toContain(
      "const step_add_items = step_meals.value\n",
    );
  });

  it("reads a guarded plain-returning step through .value", () => {
    const signatures = {
      ...mealSignatures,
      "./lists.agency.findLists": {
        signature: "findLists(query: string): string[]",
        returnType: "string[]",
        returnsResult: false,
        docstring: null,
        params: [],
      },
    };
    const body = printAll(resolved(withStep(mealPlan, 2, { limits: { maxCost: 1 } }), signatures));
    expect(body).toContain("const step_add_listId = step_list.value[0].id\n");
    expect(body).toContain('"step list (findLists): ${step_list.error}",');
  });

  it("references an llm step's value without .value", () => {
    expect(printAll(resolved())).toContain("const step_add_items = step_meals\n");
  });

  it("builds a list argument that holds a reference", () => {
    const body = printAll(
      resolved(withArg(mealPlan, "add", "items", ["Leftovers", { $ref: "steps.list[0].title" }])),
    );
    expect(body).toContain('const step_add_items = ["Leftovers", step_list.value[0].title]\n');
  });

  it("uses a literal result as given", () => {
    const lowered = lowerWorkflow(resolved({ ...mealPlan, result: { done: true } }));
    expect(_toSource(lowered.result)).toContain("done: true");
  });

  it("never renames a binder", () => {
    expect(printAll(resolved())).not.toContain("__hyg");
  });

  it("is deterministic", () => {
    expect(printAll(resolved())).toBe(printAll(resolved()));
  });
});

describe("lowerWorkflow guard labels", () => {
  it("lists the workflow's name and each step with limits, the guards the program rejects", () => {
    const withStepLimit = withStep(mealPlan, 3, { limits: { maxTime: 60000 } });
    const lowered = lowerWorkflow(resolved(withStepLimit));
    expect(lowered.guardLabel).toBe("updateMealPlanFromNote");
    expect(lowered.guardLabels).toEqual(["updateMealPlanFromNote", "meals"]);
  });

  it("leaves out the workflow's name when it has no limits", () => {
    const lowered = lowerWorkflow(resolved({ ...mealPlan, limits: null }));
    expect(lowered.guardLabels).toEqual([]);
  });
});

/** An LLM step inside eachPlan's loop that reads the current note. */
const summary = {
  id: "meals",
  kind: "llm",
  prompt: "Summarize the note.",
  context: [{ $ref: "each.note.body" }],
  output: "string",
};

describe("lowerWorkflow match and each", () => {
  it("lowers a match to a binding, one test per case, and an if chain", () => {
    const body = lowerWorkflow(resolved(matchPlan)).body;
    const texts = body.map(textOf);
    expect(texts).toContain("const step_route_on = inputs.level\n");
    expect(texts).toContain('const step_route_case1 = step_route_on == "urgent"\n');
    expect(texts).toContain('const step_route_case2 = step_route_on == "normal"\n');
    expect(lines(body)).toEqual([
      ["if (step_route_case1) {", 0, { step: "route", field: "cases[0].is" }],
      ["} else if (step_route_case2) {", 0, { step: "route", field: "cases[1].is" }],
      ["} else {", 0, { step: "route", field: "cases" }],
      ["}", 0, null],
    ]);
    const noCase = body.find((f) => textOf(f).includes("no case matches"))!;
    expect([noCase.depth, noCase.owner]).toEqual([1, { step: "route", field: "cases" }]);
  });

  it("owns the binding and each case test by the field that wrote it", () => {
    const body = lowerWorkflow(resolved(matchPlan)).body;
    expect(fragmentFor(body, "const step_route_on =").owner).toEqual({
      step: "route",
      field: "on",
    });
    expect(fragmentFor(body, "const step_route_case2 =").owner).toEqual({
      step: "route",
      field: "cases[1].is",
    });
  });

  it("puts a case's steps one level deeper than the match", () => {
    const body = lowerWorkflow(resolved(matchPlan)).body;
    expect(fragmentFor(body, "const step_add =").depth).toBe(1);
    expect(fragmentFor(body, "const step_done =").depth).toBe(0);
  });

  it("keeps a quote and an interpolation in a case value as text", () => {
    const wf = edited(matchPlan, (copy) => (copy.steps[1].cases[0].is = '${evil} " }'));
    expect(printAll(resolved(wf))).toContain(
      'const step_route_case1 = step_route_on == "\\${evil} \\" }"\n',
    );
  });

  it("gives otherwise the last else and writes no failure line", () => {
    const wf = edited(matchPlan, (copy) => (copy.steps[1].otherwise = []));
    const body = lowerWorkflow(resolved(wf)).body;
    expect(lines(body)[2]).toEqual(["} else {", 0, { step: "route", field: "otherwise" }]);
    expect(body.map(textOf).join("")).not.toContain("no case matches");
  });

  it("lowers an each to a for line holding a thread line", () => {
    const body = lowerWorkflow(resolved(eachPlan)).body;
    expect(lines(body)).toEqual([
      ["for (step_note_item in step_note_over) {", 0, { step: "note", field: "over" }],
      ["thread {", 1, { step: "note", field: "over" }],
      ["}", 1, null],
      ["}", 0, null],
    ]);
    expect(fragmentFor(body, "const step_note_over =").owner).toEqual({
      step: "note",
      field: "over",
    });
    expect(fragmentFor(body, "const step_text_id =").depth).toBe(2);
  });

  it("writes an item reference with no .value", () => {
    expect(printAll(resolved(eachPlan))).toContain("const step_text_id = step_note_item.id\n");
  });

  it("reads a step in an enclosing list through its own local", () => {
    expect(printAll(resolved(eachPlan))).toContain("const step_note_over = step_search.value\n");
    expect(printAll(resolved(eachPlan))).toContain(
      "const step_add_items = [step_text.value.body]\n",
    );
  });

  it("labels a context value read from an item", () => {
    const wf = edited(eachPlan, (copy) => copy.steps[1].steps.push(summary));
    expect(printAll(resolved(wf))).toContain("(each.note.body)");
  });

  it("collects guard labels and output types from nested steps", () => {
    const wf = edited(eachPlan, (copy) => {
      copy.steps[1].steps[1].limits = { maxCost: 0.5 };
      copy.steps[1].steps.push(summary);
    });
    const lowered = lowerWorkflow(resolved(wf));
    expect(lowered.guardLabels).toContain("add");
    expect(lowered.types.map((decl) => decl.name)).toContain("Step_meals_output");
  });
});
