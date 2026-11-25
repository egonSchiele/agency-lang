import { describe, expect, it } from "vitest";
import { resolveWorkflow } from "./resolve.js";
import type {
  ResolvedEachStep,
  ResolvedMatchStep,
  ResolvedToolStep,
  Signature,
  Workflow,
} from "./types.js";
import {
  eachPlan,
  matchPlan,
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
        params: [],
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
        params: [],
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
        params: [],
      },
    };
    const r = resolve(mealPlan, mealRefs, signatures);
    expect(r.problems).toEqual([]);
    expect(r.resolved!.warnings).toEqual([
      {
        step: "note",
        field: "tool",
        message:
          "searchNotes declares no return type, so a reference into its value is checked only when the workflow runs",
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
        params: [],
      },
    };
    const r = resolve(mealPlan, mealRefs, signatures);
    expect(r.resolved!.warnings).toEqual([
      {
        step: "note",
        field: "tool",
        message:
          "searchNotes returns Json, so a reference into its value is checked only when the workflow runs",
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
        params: [],
      },
    };
    const r = resolve(mealPlan, mealRefs, signatures);
    expect(r.resolved!.warnings).toEqual([
      {
        step: "note",
        field: "tool",
        message:
          "searchNotes returns Result<Json, string>, so a reference into its value is checked only when the workflow runs",
      },
    ]);
  });

  it("warns on a tool that returns a bare Result", () => {
    const signatures = {
      ...mealSignatures,
      "./notes.agency.searchNotes": {
        signature: "searchNotes(query: string): Result",
        returnType: "Result",
        returnsResult: true,
        docstring: null,
        params: [],
      },
    };
    expect(resolve(mealPlan, mealRefs, signatures).resolved!.warnings).toEqual([
      {
        step: "note",
        field: "tool",
        message:
          "searchNotes returns Result, so a reference into its value is checked only when the workflow runs",
      },
    ]);
  });

  it("does not warn on an untyped step that nothing references", () => {
    const signatures = {
      ...mealSignatures,
      "./notes.agency.searchNotes": {
        signature: "searchNotes(query: string): Result",
        returnType: "Result",
        returnsResult: true,
        docstring: null,
        params: [],
      },
    };
    const wf = withArg(mealPlan, "text", "id", "note-1");
    expect(resolve(wf, mealRefs, signatures).resolved!.warnings).toEqual([]);
  });

  it("warns on an untyped step that only the result references", () => {
    const signatures = {
      ...mealSignatures,
      "./notes.agency.searchNotes": {
        signature: "searchNotes(query: string): Result",
        returnType: "Result",
        returnsResult: true,
        docstring: null,
        params: [],
      },
    };
    const wf = withFields(withArg(mealPlan, "text", "id", "note-1"), {
      result: { $ref: "steps.note[0].title" },
    });
    expect(resolve(wf, mealRefs, signatures).resolved!.warnings).toEqual([
      {
        step: "note",
        field: "tool",
        message:
          "searchNotes returns Result, so a reference into its value is checked only when the workflow runs",
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
        params: [],
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
        params: [],
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
        params: [],
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

describe("resolveWorkflow raises", () => {
  // mealSignatures gives readNote std::read and addListItems test::lists::add.
  const problemsWith = (raises: string[] | null, signatures = mealSignatures) =>
    resolve(withFields(mealPlan, { raises }), mealRefs, signatures).problems;

  it("reports an effect a step raises that raises does not allow, on the step's tool", () => {
    expect(problemsWith(["test::lists::add"])).toEqual([
      {
        step: "text",
        field: "tool",
        message: `readNote raises "std::read", which the workflow's raises does not allow`,
      },
    ]);
  });

  it("expands a set name to its members", () => {
    expect(problemsWith(["FileRead", "test::lists::add"])).toEqual([]);
  });

  it("allows anything with no raises, a null one, or a star", () => {
    expect(problemsWith(null)).toEqual([]);
    expect(problemsWith(["*"])).toEqual([]);
  });

  it("reports every effect of every step under an empty raises", () => {
    expect(problemsWith([]).map((problem) => problem.step)).toEqual(["text", "add"]);
  });

  it("never reports std::guard, which the program rejects itself", () => {
    const key = "./notes.agency.searchNotes";
    const signatures = {
      ...mealSignatures,
      [key]: { ...mealSignatures[key], effects: ["std::guard"] },
    };
    expect(problemsWith(["std::read", "test::lists::add"], signatures)).toEqual([]);
  });
});

/** A deep copy of `wf`, changed by `change`. */
function edited(wf: unknown, change: (copy: any) => void): Record<string, any> {
  const copy = JSON.parse(JSON.stringify(wf));
  change(copy);
  return copy;
}

/** A copy of mealSignatures with one tool's signature changed. */
function withSignature(key: string, patch: Partial<Signature>): Record<string, Signature> {
  return { ...mealSignatures, [key]: { ...mealSignatures[key], ...patch } };
}

const SEARCH = "./notes.agency.searchNotes";
const READ = "./notes.agency.readNote";

/** An LLM step that reads the current note, for the loop tests. */
const summarize = {
  id: "summary",
  kind: "llm",
  prompt: "Summarize the note.",
  context: [{ $ref: "each.note.body" }],
  output: "string",
};

/** An outer loop over groups and an inner loop over each group's items. */
const nestedLoops = {
  format: 1,
  name: "nested",
  description: "Add every item of every group.",
  inputs: "{ groups: { name: string; items: string[] }[] }",
  steps: [
    {
      id: "group",
      kind: "each",
      over: { $ref: "inputs.groups" },
      steps: [
        {
          id: "item",
          kind: "each",
          over: { $ref: "each.group.items" },
          steps: [
            {
              id: "add",
              kind: "tool",
              module: "./lists.agency",
              tool: "addListItems",
              args: {
                listId: { $ref: "each.group.name" },
                items: [{ $ref: "each.item" }],
                section: "Items",
              },
            },
          ],
        },
      ],
    },
    {
      id: "done",
      kind: "tool",
      module: "./lists.agency",
      tool: "findLists",
      args: { query: "done" },
    },
  ],
};

describe("resolveWorkflow match and each", () => {
  it("lets a step read an earlier step in its list, an enclosing list, and its loop's item", () => {
    expect(resolveWorkflow(eachPlan, mealRefs, mealSignatures).problems).toEqual([]);
    expect(resolveWorkflow(matchPlan, mealRefs, mealSignatures).problems).toEqual([]);
  });

  it("lets a step in an inner loop read both loops' items", () => {
    expect(resolve(nestedLoops).problems).toEqual([]);
  });

  it("refuses a step reference to a match or an each, which has no value", () => {
    const wf = edited(matchPlan, (copy) => (copy.steps[2].args.query = { $ref: "steps.route" }));
    expect(resolve(wf).problems).toEqual([
      {
        step: "done",
        field: "args.query",
        message: 'reference "steps.route" names step "route", a match step, which has no value',
      },
    ]);
    const loop = edited(eachPlan, (copy) => (copy.steps[2].args.query = { $ref: "steps.note" }));
    expect(resolve(loop).problems[0].message).toBe(
      'reference "steps.note" names step "note", an each step, which has no value',
    );
  });

  it("refuses a reference to a later step in the step's own list or an enclosing one", () => {
    const own = edited(
      eachPlan,
      (copy) => (copy.steps[1].steps[0].args.id = { $ref: "steps.add" }),
    );
    expect(resolve(own).problems).toEqual([
      {
        step: "text",
        field: "args.id",
        message: 'reference "steps.add" names step "add", which comes after this step',
      },
    ]);
    const enclosing = edited(
      eachPlan,
      (copy) => (copy.steps[1].steps[0].args.id = { $ref: "steps.done" }),
    );
    expect(resolve(enclosing).problems[0].message).toBe(
      'reference "steps.done" names step "done", which comes after this step',
    );
  });

  it("refuses a reference from outside a block to a step inside it", () => {
    const wf = edited(eachPlan, (copy) => (copy.steps[2].args.query = { $ref: "steps.text.body" }));
    expect(resolve(wf).problems).toEqual([
      {
        step: "done",
        field: "args.query",
        message:
          'reference "steps.text.body" names step "text", which is inside a block this step is not in',
      },
    ]);
  });

  it("refuses a reference from one case into another, in both directions", () => {
    const later = {
      id: "later",
      kind: "tool",
      module: "./lists.agency",
      tool: "findLists",
      args: { query: { $ref: "steps.add" } },
    };
    const wf = edited(matchPlan, (copy) => {
      copy.steps[1].cases[1].steps = [later];
      copy.steps[1].cases[0].steps[0].args.listId = { $ref: "steps.later" };
    });
    expect(resolve(wf).problems).toEqual([
      {
        step: "add",
        field: "args.listId",
        message:
          'reference "steps.later" names step "later", which is inside a block this step is not in',
      },
      {
        step: "later",
        field: "args.query",
        message:
          'reference "steps.add" names step "add", which is inside a block this step is not in',
      },
    ]);
  });

  it("refuses a reference from result into a loop", () => {
    const wf = edited(eachPlan, (copy) => (copy.result = { $ref: "steps.add" }));
    expect(resolve(wf).problems).toEqual([
      {
        step: null,
        field: "result",
        message:
          'reference "steps.add" names step "add", which is inside a block this step is not in',
      },
    ]);
  });

  it("refuses an item reference to a step that is not a loop", () => {
    const wf = edited(
      eachPlan,
      (copy) => (copy.steps[1].steps[0].args.id = { $ref: "each.search.id" }),
    );
    expect(resolve(wf).problems).toEqual([
      { step: "text", field: "args.id", message: 'reference "each.search.id" names no each step' },
    ]);
    const none = edited(
      eachPlan,
      (copy) => (copy.steps[1].steps[0].args.id = { $ref: "each.x.id" }),
    );
    expect(resolve(none).problems[0].message).toBe('reference "each.x.id" names no each step');
  });

  it("refuses an item reference from outside its loop", () => {
    const wf = edited(eachPlan, (copy) => (copy.steps[2].args.query = { $ref: "each.note.id" }));
    expect(resolve(wf).problems).toEqual([
      {
        step: "done",
        field: "args.query",
        message: 'reference "each.note.id" names loop "note", which this step is not inside',
      },
    ]);
    const own = edited(eachPlan, (copy) => (copy.steps[1].over = { $ref: "each.note" }));
    expect(resolve(own).problems[0]).toEqual({
      step: "note",
      field: "over",
      message: 'reference "each.note" names loop "note", which this step is not inside',
    });
  });

  it("asks for a result when the last top-level step is a block", () => {
    const wf = edited(matchPlan, (copy) => {
      copy.steps.pop();
      delete copy.result;
    });
    expect(resolve(wf).problems).toEqual([
      {
        step: null,
        field: "result",
        message: 'the last step, "route", is a match step and has no value; set result',
      },
    ]);
  });

  it("resolves an each step to a tree with its names", () => {
    const each = resolve(eachPlan).resolved!.steps[1] as ResolvedEachStep;
    expect(each.over).toEqual({
      local: "step_note_over",
      field: "over",
      value: { kind: "step", step: "search", path: "" },
    });
    expect(each.item).toBe("step_note_item");
    expect(each.steps.map((step) => step.id)).toEqual(["text", "add"]);
  });

  it("resolves a match step to a tree with its names", () => {
    const match = resolve(matchPlan).resolved!.steps[1] as ResolvedMatchStep;
    expect(match.on.local).toBe("step_route_on");
    expect(match.cases.map((item) => [item.is, item.test, item.steps.length])).toEqual([
      ["urgent", "step_route_case1", 1],
      ["normal", "step_route_case2", 0],
    ]);
    expect(match.otherwise).toBeNull();
  });

  it("resolves each.note.id to an item reference", () => {
    const each = resolve(eachPlan).resolved!.steps[1] as ResolvedEachStep;
    const text = each.steps[0] as ResolvedToolStep;
    expect(text.bindings[0].value).toEqual({ kind: "item", loop: "note", path: ".id" });
  });

  it("refuses a step id that equals a block's generated name", () => {
    const wf = edited(matchPlan, (copy) =>
      copy.steps.push({
        id: "route_on",
        kind: "tool",
        module: "./lists.agency",
        tool: "findLists",
        args: { query: "x" },
      }),
    );
    expect(resolve(wf).problems[0].message).toContain("produces the same local as");
  });

  it("refuses a nested step whose generated name collides with a top-level one", () => {
    const wf = edited(eachPlan, (copy) =>
      copy.steps.push({
        id: "text_id",
        kind: "tool",
        module: "./lists.agency",
        tool: "findLists",
        args: { query: "x" },
      }),
    );
    expect(resolve(wf).problems[0].message).toContain("produces the same local as");
  });

  it("imports a tool used only inside a case", () => {
    expect(resolve(matchPlan).resolved!.imports).toContainEqual({
      module: "./lists.agency",
      names: ["addListItems", "findLists"],
    });
  });

  it("refuses a tool inside a case that the host did not pass", () => {
    const refs = mealRefs.filter((ref) => ref.name !== "addListItems");
    expect(resolve(matchPlan, refs).problems[0]).toEqual({
      step: "add",
      field: "tool",
      message:
        'tool "addListItems" from "./lists.agency" is not among the tools passed to this workflow',
    });
  });

  it("warns about an untyped tool that only an over reads", () => {
    const signatures = withSignature(SEARCH, { returnType: "Json", returnsResult: false });
    const r = resolve(eachPlan, mealRefs, signatures);
    expect(r.problems).toEqual([]);
    expect(r.resolved!.warnings).toContainEqual({
      step: "search",
      field: "tool",
      message: expect.stringContaining("searchNotes returns Json"),
    });
  });

  const costMessage =
    "this loop runs a model once per item, and the workflow sets no limits.maxCost, so its cost depends on the length of the list";

  it("warns once, on the outer loop, for an LLM step in a nested loop", () => {
    const wf = edited(nestedLoops, (copy) =>
      copy.steps[0].steps[0].steps.push({
        id: "summary",
        kind: "llm",
        prompt: "Describe the item.",
        context: [{ $ref: "each.item" }],
        output: "string",
      }),
    );
    expect(resolve(wf).resolved!.warnings).toEqual([
      { step: "group", field: "over", message: costMessage },
    ]);
  });

  it("warns for an LLM step in a loop", () => {
    const wf = edited(eachPlan, (copy) => copy.steps[1].steps.push(summarize));
    expect(resolve(wf).resolved!.warnings).toEqual([
      { step: "note", field: "over", message: costMessage },
    ]);
  });

  it("warns for a handoff tool in a loop", () => {
    const signatures = withSignature(READ, { handoff: true });
    expect(resolve(eachPlan, mealRefs, signatures).resolved!.warnings).toEqual([
      { step: "note", field: "over", message: costMessage },
    ]);
  });

  it("gives no cost warning when the workflow sets maxCost", () => {
    const signatures = withSignature(READ, { handoff: true });
    const wf = withFields(eachPlan, { limits: { maxCost: 1 } });
    expect(resolve(wf, mealRefs, signatures).resolved!.warnings).toEqual([]);
  });

  it("gives no cost warning for a loop of plain tools", () => {
    expect(resolve(eachPlan).resolved!.warnings).toEqual([]);
  });

  it("reports a tool inside a loop that raises an effect raises does not allow", () => {
    const wf = withFields(eachPlan, { raises: [] });
    expect(resolve(wf).problems).toContainEqual({
      step: "add",
      field: "tool",
      message: expect.stringContaining('raises "test::lists::add"'),
    });
  });
});
