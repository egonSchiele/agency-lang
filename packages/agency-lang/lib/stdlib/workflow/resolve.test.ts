import { describe, expect, it } from "vitest";
import { resolveWorkflow } from "./resolve.js";
import type { Workflow } from "./types.js";
import {
  mealPlan,
  mealRefs,
  mealSignatures,
  withArg,
  withFields,
  withStep,
} from "./testFixtures.js";

const resolve = (wf: unknown, refs = mealRefs, signatures = mealSignatures) =>
  resolveWorkflow(wf as Workflow, refs, signatures);

describe("resolveWorkflow", () => {
  it("resolves the meal plan", () => {
    const r = resolve(mealPlan);
    expect(r.problems).toEqual([]);
    expect(r.resolved!.imports).toEqual([
      { module: "./lists.agency", names: ["addListItems", "findLists"] },
      { module: "./notes.agency", names: ["readNote", "searchNotes"] },
    ]);
    expect(r.resolved!.steps[1]).toEqual({
      id: "text",
      kind: "tool",
      value: "step_text",
      module: "./notes.agency",
      tool: "readNote",
      holdsResult: true,
      limits: null,
      bindings: [
        {
          local: "step_text_id",
          field: "args.id",
          value: { kind: "step", step: "note", path: "[0].id" },
        },
      ],
      argOrder: ["id"],
    });
    expect(r.resolved!.steps[3]).toMatchObject({
      id: "meals",
      kind: "llm",
      value: "step_meals",
      outputType: "string[]",
      typeName: "Step_meals_output",
      bindings: [
        {
          local: "step_meals_context1",
          field: "context[0]",
          value: { kind: "step", step: "text", path: ".body" },
        },
      ],
      model: null,
      provider: null,
    });
    expect(r.resolved!.result).toEqual({ kind: "step", step: "add", path: "" });
    expect(r.resolved!.limits).toEqual({ maxCost: 1, maxTime: 300000 });
    expect(r.resolved!.warnings).toEqual([]);
  });

  it("sorts arguments by name and keeps a literal as a literal", () => {
    const add = resolve(mealPlan).resolved!.steps[4];
    expect(add.kind === "tool" && add.argOrder).toEqual(["items", "listId", "section"]);
    expect(add.bindings.map((b) => [b.local, b.value])).toEqual([
      ["step_add_items", { kind: "step", step: "meals", path: "" }],
      ["step_add_listId", { kind: "step", step: "list", path: "[0].id" }],
      ["step_add_section", { kind: "literal", value: "Meals" }],
    ]);
  });

  it("never reads a literal object as a reference", () => {
    const wf = withArg(mealPlan, "list", "query", { kind: "step", step: "x } evil", path: "" });
    const list = resolve(wf).resolved!.steps[2];
    expect(list.bindings[0].value).toEqual({
      kind: "literal",
      value: { kind: "step", step: "x } evil", path: "" },
    });
  });

  it("resolves a reference nested inside a list", () => {
    const wf = withArg(mealPlan, "add", "items", ["Leftovers", { $ref: "steps.list[0].title" }]);
    const add = resolve(wf).resolved!.steps[4];
    expect(add.bindings[0].value).toEqual({
      kind: "list",
      items: [
        { kind: "literal", value: "Leftovers" },
        { kind: "step", step: "list", path: "[0].title" },
      ],
    });
  });

  it("refuses a tool the host did not pass, even a std one", () => {
    const wf = withStep(mealPlan, 2, {
      module: "std::shell",
      tool: "bash",
      args: { command: "ls" },
    });
    expect(resolve(wf).problems).toEqual([
      {
        step: "list",
        field: "tool",
        message: 'tool "bash" from "std::shell" is not among the tools passed to this workflow',
      },
    ]);
  });

  it("refuses a tool passed under another module", () => {
    const wf = withStep(mealPlan, 0, { module: "./lists.agency" });
    expect(resolve(wf).problems[0].message).toBe(
      'tool "searchNotes" from "./lists.agency" is not among the tools passed to this workflow',
    );
  });

  it("refuses a tool with no signature", () => {
    const { ["./notes.agency.readNote"]: _readNote, ...signatures } = mealSignatures;
    expect(resolve(mealPlan, mealRefs, signatures).problems).toEqual([
      { step: "text", field: "tool", message: 'no signature for "./notes.agency"."readNote"' },
    ]);
  });

  it("refuses a forward reference", () => {
    const wf = withArg(mealPlan, "note", "query", { $ref: "steps.list[0].id" });
    expect(resolve(wf).problems).toEqual([
      {
        step: "note",
        field: "args.query",
        message: 'reference "steps.list[0].id" names step "list", which comes after this step',
      },
    ]);
  });

  it("refuses a reference to the step itself", () => {
    const wf = withArg(mealPlan, "note", "query", { $ref: "steps.note" });
    expect(resolve(wf).problems[0].message).toBe(
      'reference "steps.note" names step "note", which is this step',
    );
  });

  it("refuses a reference to no step", () => {
    const wf = withFields(mealPlan, { result: { $ref: "steps.nope" } });
    expect(resolve(wf).problems).toEqual([
      { step: null, field: "result", message: 'reference "steps.nope" names no step' },
    ]);
  });

  it("refuses an unknown input", () => {
    const wf = withArg(mealPlan, "note", "query", { $ref: "inputs.nope" });
    expect(resolve(wf).problems).toEqual([
      {
        step: "note",
        field: "args.query",
        message: 'reference "inputs.nope" names no declared input',
      },
    ]);
  });

  it("marks a plain return as not a Result", () => {
    const signatures = {
      ...mealSignatures,
      "./lists.agency.findLists": {
        signature: "findLists(query: string): string[]",
        returnType: "string[]",
        returnsResult: false,
        docstring: null,
      },
    };
    const list = resolve(mealPlan, mealRefs, signatures).resolved!.steps[2];
    expect(list.kind === "tool" && list.holdsResult).toBe(false);
  });

  it("holds a Result when a plain-returning step has limits", () => {
    const signatures = {
      ...mealSignatures,
      "./lists.agency.findLists": {
        signature: "findLists(query: string): string[]",
        returnType: "string[]",
        returnsResult: false,
        docstring: null,
      },
    };
    const limited = withStep(mealPlan, 2, { limits: { maxTime: 1000 } });
    const list = resolve(limited, mealRefs, signatures).resolved!.steps[2];
    expect(list.holdsResult).toBe(true);
    expect(list.limits).toEqual({ maxTime: 1000 });
  });

  it("reads empty limits as none, and gives an llm step a Result only with limits", () => {
    const empty = resolve(withStep(mealPlan, 3, { limits: {} })).resolved!.steps[3];
    expect(empty.limits).toBe(null);
    expect(empty.holdsResult).toBe(false);
    const limited = resolve(withStep(mealPlan, 3, { limits: { maxCost: 2 } })).resolved!.steps[3];
    expect(limited.holdsResult).toBe(true);
  });

  it("warns on a tool with no return type", () => {
    const signatures = {
      ...mealSignatures,
      "./notes.agency.searchNotes": {
        signature: "searchNotes(query: string)",
        returnType: null,
        returnsResult: false,
        docstring: null,
      },
    };
    const r = resolve(mealPlan, mealRefs, signatures);
    expect(r.problems).toEqual([]);
    expect(r.resolved!.warnings).toEqual([
      {
        step: "note",
        field: "tool",
        message:
          'step "note": "searchNotes" declares no return type, so references into its value are checked at run time',
      },
    ]);
  });

  it("warns on a tool that returns Json", () => {
    const signatures = {
      ...mealSignatures,
      "./notes.agency.searchNotes": {
        signature: "searchNotes(query: string): Json",
        returnType: "Json",
        returnsResult: false,
        docstring: null,
      },
    };
    const r = resolve(mealPlan, mealRefs, signatures);
    expect(r.resolved!.warnings).toEqual([
      {
        step: "note",
        field: "tool",
        message:
          'step "note": "searchNotes" returns Json, so references into its value are checked at run time',
      },
    ]);
  });

  it("warns on a tool that returns Result<Json>, whose value is untyped", () => {
    const signatures = {
      ...mealSignatures,
      "./notes.agency.searchNotes": {
        signature: "searchNotes(query: string): Result<Json, string>",
        returnType: "Result<Json, string>",
        returnsResult: true,
        docstring: null,
      },
    };
    const r = resolve(mealPlan, mealRefs, signatures);
    expect(r.resolved!.warnings).toEqual([
      {
        step: "note",
        field: "tool",
        message:
          'step "note": "searchNotes" returns Result<Json, string>, so references into its value are checked at run time',
      },
    ]);
  });

  it("does not warn on a Result of a typed value", () => {
    const signatures = {
      ...mealSignatures,
      "./notes.agency.searchNotes": {
        signature: "searchNotes(query: string): Result<Note[]>",
        returnType: "Result<Note[]>",
        returnsResult: true,
        docstring: null,
      },
    };
    expect(resolve(mealPlan, mealRefs, signatures).resolved!.warnings).toEqual([]);
  });

  it("prefixes every generated name", () => {
    const wf = withStep(withArg(mealPlan, "text", "id", { $ref: "steps.failure[0].id" }), 0, {
      id: "failure",
    });
    const steps = resolve(wf).resolved!.steps;
    expect(steps[0].value).toBe("step_failure");
    expect(steps[0].bindings[0].local).toBe("step_failure_query");
  });

  it("refuses a step id that produces an llm step's reply local", () => {
    const renamed = withStep(mealPlan, 4, { id: "meals_reply" });
    const wf = withFields(renamed, { result: { $ref: "steps.meals_reply" } });
    expect(resolve(wf).problems).toEqual([
      {
        step: "meals_reply",
        field: "id",
        message: 'step id "meals_reply" produces the same local as the reply of step "meals"',
      },
    ]);
  });

  it("refuses a step id that produces a context value's text local", () => {
    const renamed = withStep(mealPlan, 4, { id: "meals_context1_text" });
    const wf = withFields(renamed, { result: { $ref: "steps.meals_context1_text" } });
    expect(resolve(wf).problems).toEqual([
      {
        step: "meals_context1_text",
        field: "id",
        message:
          'step id "meals_context1_text" produces the same local as the text of context value 1 of step "meals"',
      },
    ]);
  });

  it("refuses a step id that produces another step's local", () => {
    const renamed = withStep(mealPlan, 2, { id: "note_query" });
    const wf = withArg(renamed, "add", "listId", { $ref: "steps.note_query[0].id" });
    expect(resolve(wf).problems).toEqual([
      {
        step: "note_query",
        field: "id",
        message: 'step id "note_query" produces the same local as argument "query" of step "note"',
      },
    ]);
  });

  it("refuses a tool whose name the generated program uses", () => {
    const refs = [...mealRefs, { module: "./notes.agency", name: "failure" }];
    const signatures = {
      ...mealSignatures,
      "./notes.agency.failure": {
        signature: "failure(): string",
        returnType: "string",
        returnsResult: false,
        docstring: null,
      },
    };
    const wf = withStep(mealPlan, 2, { module: "./notes.agency", tool: "failure", args: {} });
    expect(resolve(wf, refs, signatures).problems).toEqual([
      {
        step: "list",
        field: "tool",
        message: 'tool name "failure" is a name the generated program uses',
      },
    ]);
  });

  it("refuses a tool named like a generated local", () => {
    const refs = [...mealRefs, { module: "./notes.agency", name: "step_note" }];
    const signatures = {
      ...mealSignatures,
      "./notes.agency.step_note": {
        signature: "step_note(): string",
        returnType: "string",
        returnsResult: false,
        docstring: null,
      },
    };
    const wf = withStep(mealPlan, 2, { module: "./notes.agency", tool: "step_note", args: {} });
    expect(resolve(wf, refs, signatures).problems).toEqual([
      {
        step: "note",
        field: "id",
        message: 'step id "note" produces the same local as tool "step_note"',
      },
    ]);
  });

  it("carries model and provider for an llm step", () => {
    const wf = withStep(mealPlan, 3, { model: "gpt-5", provider: "openai" });
    expect(resolve(wf).resolved!.steps[3]).toMatchObject({ model: "gpt-5", provider: "openai" });
  });

  it("reads a null result as absent", () => {
    expect(resolve(withFields(mealPlan, { result: null })).resolved!.result).toBe(null);
  });

  it("uses a literal result and no limits as given", () => {
    const { limits: _limits, ...wf } = withFields(mealPlan, { result: "done" });
    const r = resolve(wf).resolved!;
    expect(r.result).toEqual({ kind: "literal", value: "done" });
    expect(r.limits).toBe(null);
  });
});
