import { describe, expect, it } from "vitest";
import { _toSource } from "../template.js";
import { lowerWorkflow } from "./lower.js";
import { resolveWorkflow } from "./resolve.js";
import type { Fragment, ResolvedWorkflow, Workflow } from "./types.js";
import { mealPlan, mealRefs, mealSignatures, withArg, withStep } from "./testFixtures.js";

const resolved = (wf: unknown = mealPlan, signatures = mealSignatures): ResolvedWorkflow =>
  resolveWorkflow(wf as Workflow, mealRefs, signatures).resolved!;
const print = (f: Fragment) => [_toSource(f.code), f.owner] as const;
const printAll = (r: ResolvedWorkflow) =>
  lowerWorkflow(r)
    .body.map((f) => _toSource(f.code))
    .join("");

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
    expect(_toSource(lowered.body[3].code)).toBe("const step_text_id = step_note.value[0].id\n");
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
      resolved(withStep(mealPlan, 4, { limits: { maxTime: 120000, maxCost: 5 } })),
    );
    const add = lowered.body.filter((f) => f.owner?.step === "add" && f.owner.field === "args");
    expect(add.map((f) => f.owner)).toEqual([
      { step: "add", field: "args" },
      { step: "add", field: "args" },
    ]);
    const [guardText, checkText] = add.map((f) => _toSource(f.code));
    expect(guardText).toContain('const step_add = guard(label: "add", time: 120000, cost: 5) {');
    expect(guardText).toContain("  return addListItems(");
    expect(guardText).toContain("    section: step_add_section,");
    expect(guardText).toContain("\n}\n");
    expect(checkText).toContain('"step add (addListItems): ${step_add.error}",');
  });

  it("guards an llm step that has limits, declaring the reply inside, then checks it", () => {
    const lowered = lowerWorkflow(resolved(withStep(mealPlan, 3, { limits: { maxTime: 60000 } })));
    const meals = lowered.body
      .filter((f) => f.owner?.step === "meals" && f.owner.field === "prompt")
      .map((f) => _toSource(f.code));
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
