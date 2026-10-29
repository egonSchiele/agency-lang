import { describe, expect, it } from "vitest";
import { _pickSignatures, _signatureSources, compileWorkflowSource } from "./index.js";
import { mealPlan, mealRefs, mealSignatures, withFields } from "./testFixtures.js";

const MEAL_PLAN_SOURCE = [
  'import { Json } from "std::validation"',
  'import { addListItems, findLists } from "./lists.agency"',
  'import { readNote, searchNotes } from "./notes.agency"',
  "",
  "type Inputs = {",
  "  noteTitle: string",
  "}",
  "type Step_meals_output = string[]",
  "",
  "export node main(inputs: Inputs!): Result {",
  "  return guard(time: 300000, cost: 1) {",
  "    const step_note_query = inputs.noteTitle",
  "    const step_note = searchNotes(query: step_note_query)",
  "    if (step_note is failure) {",
  "      return failure(",
  '        "step note (searchNotes): ${step_note.error}",',
  "        {",
  '          step: "note",',
  "          cause: step_note",
  "        },",
  "      )",
  "    }",
  "    const step_text_id = step_note.value[0].id",
  "    const step_text = readNote(id: step_text_id)",
  "    if (step_text is failure) {",
  "      return failure(",
  '        "step text (readNote): ${step_text.error}",',
  "        {",
  '          step: "text",',
  "          cause: step_text",
  "        },",
  "      )",
  "    }",
  '    const step_list_query = "weekly meal plan"',
  "    const step_list = findLists(query: step_list_query)",
  "    if (step_list is failure) {",
  "      return failure(",
  '        "step list (findLists): ${step_list.error}",',
  "        {",
  '          step: "list",',
  "          cause: step_list",
  "        },",
  "      )",
  "    }",
  "    const step_meals_context1 = step_text.value.body",
  "    const step_meals_context1_text = if step_meals_context1 is string then step_meals_context1 else JSON.stringify(step_meals_context1)",
  "    const step_meals: Step_meals_output = thread {",
  "      return llm(",
  '        "The note below ends with this week\'s meal plan, one meal per line. Return the meals as a list of strings, in order, without day names." + "\\n\\nContext 1 (steps.text.body):\\n" + step_meals_context1_text,',
  "      )",
  "    }",
  "    const step_add_items = step_meals",
  "    const step_add_listId = step_list.value[0].id",
  '    const step_add_section = "Meals"',
  "    const step_add = addListItems(",
  "      items: step_add_items,",
  "      listId: step_add_listId,",
  "      section: step_add_section,",
  "    )",
  "    if (step_add is failure) {",
  "      return failure(",
  '        "step add (addListItems): ${step_add.error}",',
  "        {",
  '          step: "add",',
  "          cause: step_add",
  "        },",
  "      )",
  "    }",
  "    return success(step_add.value)",
  "  }",
  "}",
  "",
  "export node inputsSchema(): Json {",
  "  return schema(Inputs).toJSONSchema()",
  "}",
  "",
].join("\n");

describe("compileWorkflowSource", () => {
  it("generates the whole meal plan program", () => {
    const result = compileWorkflowSource(mealPlan, mealRefs, mealSignatures);
    expect(result.problems).toEqual([]);
    expect(result.compiled!.source).toBe(MEAL_PLAN_SOURCE);
  });

  it("returns the first failing stage's problems", () => {
    expect(
      compileWorkflowSource(withFields(mealPlan, { format: 2 }), mealRefs, mealSignatures).problems,
    ).toEqual([{ step: null, field: "format", message: "format must be 1, got 2" }]);
  });
});

describe("compileWorkflowSource wall clock", () => {
  it("is the workflow's maxTime plus the headroom", () => {
    const result = compileWorkflowSource(mealPlan, mealRefs, mealSignatures);
    expect(result.compiled!.wallClock).toBe(330000);
  });

  it("is null with no maxTime, so run uses its own default", () => {
    const result = compileWorkflowSource(
      withFields(mealPlan, { limits: null }),
      mealRefs,
      mealSignatures,
    );
    expect(result.compiled!.wallClock).toBe(null);
  });
});

describe("_signatureSources", () => {
  it("groups refs by module and writes a re-export line for a shared module", () => {
    const refs = [
      ...mealRefs,
      { module: "std::shell", name: "bash" },
      { module: "std::shell", name: "ls" },
    ];
    expect(_signatureSources(refs)).toEqual([
      { module: "./lists.agency", names: ["addListItems", "findLists"], reExport: null },
      { module: "./notes.agency", names: ["readNote", "searchNotes"], reExport: null },
      {
        module: "std::shell",
        names: ["bash", "ls"],
        reExport: 'export { bash, ls } from "std::shell"',
      },
    ]);
  });
});

describe("_pickSignatures", () => {
  const exportInfo = (name: string, kind: string, returnType: string | null) => ({
    name,
    kind,
    signature: `${name}()`,
    returnType,
    returnsResult: returnType !== null && returnType.startsWith("Result"),
    docstring: null,
  });

  it("keys each named function by module and name", () => {
    const group = { module: "./a.agency", names: ["f"], reExport: null };
    const result = _pickSignatures(group, [
      exportInfo("f", "def", "string"),
      exportInfo("T", "type", null),
    ]);
    expect(result.success && result.value).toEqual({
      "./a.agency.f": {
        signature: "f()",
        returnType: "string",
        returnsResult: false,
        docstring: null,
      },
    });
  });

  it("refuses a name the module re-exports from another file", () => {
    const group = { module: "./a.agency", names: ["f"], reExport: null };
    const result = _pickSignatures(group, [exportInfo("f", "reexport", null)]);
    expect(!result.success && result.error).toBe(
      '"./a.agency" re-exports "f" from another file; pass a def the module itself defines',
    );
  });

  it("fails when the module exports no function by that name", () => {
    const group = { module: "./a.agency", names: ["T"], reExport: null };
    const result = _pickSignatures(group, [exportInfo("T", "type", null)]);
    expect(!result.success && result.error).toBe('"./a.agency" exports no function named "T"');
  });
});
