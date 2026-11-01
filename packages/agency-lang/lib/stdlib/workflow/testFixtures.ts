import type { Signature, ToolRef, Workflow } from "./types.js";

/** The spec's meal plan example, with modules relative to the test's dir. */
export const mealPlan: Workflow = {
  format: 1,
  name: "updateMealPlanFromNote",
  description: "Copy this week's meal plan from the groceries note to the weekly meal plan list.",
  inputs: "{ noteTitle: string }",
  steps: [
    {
      id: "note",
      kind: "tool",
      module: "./notes.agency",
      tool: "searchNotes",
      args: { query: { $ref: "inputs.noteTitle" } },
    },
    {
      id: "text",
      kind: "tool",
      module: "./notes.agency",
      tool: "readNote",
      args: { id: { $ref: "steps.note[0].id" } },
    },
    {
      id: "list",
      kind: "tool",
      module: "./lists.agency",
      tool: "findLists",
      args: { query: "weekly meal plan" },
    },
    {
      id: "meals",
      kind: "llm",
      prompt:
        "The note below ends with this week's meal plan, one meal per line. Return the meals as a list of strings, in order, without day names.",
      context: [{ $ref: "steps.text.body" }],
      output: "string[]",
    },
    {
      id: "add",
      kind: "tool",
      module: "./lists.agency",
      tool: "addListItems",
      args: {
        listId: { $ref: "steps.list[0].id" },
        items: { $ref: "steps.meals" },
        section: "Meals",
      },
    },
  ],
  result: { $ref: "steps.add" },
  limits: { maxCost: 1, maxTime: 300000 },
};

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** A deep copy of `wf` with step `index`'s fields replaced by `patch`. */
export function withStep(
  wf: unknown,
  index: number,
  patch: Record<string, unknown>,
): Record<string, any> {
  const next = copy(wf) as Record<string, any>;
  next.steps[index] = { ...next.steps[index], ...patch };
  return next;
}

/** A deep copy of `wf` with argument `name` of step `stepId` set to `value`. */
export function withArg(
  wf: unknown,
  stepId: string,
  name: string,
  value: unknown,
): Record<string, any> {
  const next = copy(wf) as Record<string, any>;
  const step = next.steps.find((s: { id: string }) => s.id === stepId);
  step.args[name] = value;
  return next;
}

/** A deep copy of `wf` with top-level fields replaced by `patch`. */
export function withFields(wf: unknown, patch: Record<string, unknown>): Record<string, any> {
  return { ...copy(wf as Record<string, unknown>), ...patch };
}

export const mealRefs: ToolRef[] = [
  { module: "./notes.agency", name: "searchNotes" },
  { module: "./notes.agency", name: "readNote" },
  { module: "./lists.agency", name: "findLists" },
  { module: "./lists.agency", name: "addListItems" },
];

function signature(text: string, returnType: string | null): Signature {
  return { signature: text, returnType, returnsResult: true, docstring: null, params: [] };
}

export const mealSignatures: Record<string, Signature> = {
  "./notes.agency.searchNotes": signature(
    "searchNotes(query: string): Result<Note[]>",
    "Result<Note[]>",
  ),
  "./notes.agency.readNote": signature("readNote(id: string): Result<Note>", "Result<Note>"),
  "./lists.agency.findLists": signature(
    "findLists(query: string): Result<ListSummary[]>",
    "Result<ListSummary[]>",
  ),
  "./lists.agency.addListItems": signature(
    "addListItems(listId: string, items: string[], section: string): Result<string>",
    "Result<string>",
  ),
};
