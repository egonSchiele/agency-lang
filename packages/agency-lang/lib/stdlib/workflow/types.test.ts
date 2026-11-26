import { describe, expect, it } from "vitest";
import { resolveWorkflow } from "./resolve.js";
import {
  allResolved,
  allSteps,
  locatedSteps,
  REF_PATH,
  stepChildren,
  type Step,
  type Workflow,
} from "./types.js";
import { eachPlan, matchPlan, mealRefs, mealSignatures } from "./testFixtures.js";

function toolStep(id: string): Step {
  return { id, kind: "tool", module: "./lists.agency", tool: "findLists", args: { query: id } };
}

function withOtherwise(wf: Workflow, otherwise: Step[]): Workflow {
  const copy: Workflow = JSON.parse(JSON.stringify(wf));
  const route = copy.steps.find((step) => step.id === "route");
  if (route === undefined || route.kind !== "match") {
    throw new Error("the workflow has no match step named route");
  }
  route.otherwise = otherwise;
  return copy;
}

describe("allSteps", () => {
  it("lists every step in document order, a block before its steps", () => {
    expect(allSteps(eachPlan).map((step) => step.id)).toEqual([
      "search",
      "note",
      "text",
      "add",
      "done",
    ]);
  });

  it("lists a match's cases in order, then otherwise", () => {
    const wf = withOtherwise(matchPlan, [toolStep("fallback")]);
    expect(allSteps(wf).map((step) => step.id)).toEqual([
      "note",
      "route",
      "add",
      "fallback",
      "done",
    ]);
  });
});

describe("locatedSteps", () => {
  it("records each step's path", () => {
    const text = locatedSteps(eachPlan).find((entry) => entry.step.id === "text")!;
    expect(text.path).toEqual(["steps", 1, "steps", 0]);
  });

  it("skips malformed nesting without throwing", () => {
    for (const steps of [
      "x",
      [null, 3, "x"],
      [{ id: "r", kind: "match", cases: "x" }],
      [{ id: "r", kind: "match", cases: [{ is: "a" }], otherwise: 5 }],
      [{ id: "n", kind: "each", steps: null }],
    ]) {
      expect(() => locatedSteps({ steps })).not.toThrow();
    }
    expect(locatedSteps(null)).toEqual([]);
    expect(locatedSteps({ steps: [null, { id: "a" }] }).map((entry) => entry.path)).toEqual([
      ["steps", 1],
    ]);
  });
});

describe("REF_PATH", () => {
  it("accepts each as a reference root", () => {
    expect(REF_PATH.test("each.note.items[0].id")).toBe(true);
    expect(REF_PATH.test("every.note")).toBe(false);
  });
});

/** A plain tool step with no references. */
const listStep = (id: string): Step => ({
  id,
  kind: "tool",
  module: "./lists.agency",
  tool: "findLists",
  args: { query: id },
});

/** Every block kind, and every place a step list can be: a case's steps,
 *  `otherwise`, and an each's steps, nested inside one another. */
const everyBlock: Workflow = {
  format: 1,
  name: "everyBlock",
  description: "Every kind of block, nested.",
  inputs: "{ query: string; level: string }",
  steps: [
    {
      id: "search",
      kind: "tool",
      module: "./notes.agency",
      tool: "searchNotes",
      args: { query: { $ref: "inputs.query" } },
    },
    {
      id: "route",
      kind: "match",
      on: { $ref: "inputs.level" },
      cases: [
        {
          is: "a",
          steps: [
            {
              id: "loop",
              kind: "each",
              over: { $ref: "steps.search" },
              steps: [
                {
                  id: "inner",
                  kind: "match",
                  on: { $ref: "each.loop.title" },
                  cases: [{ is: "x", steps: [listStep("caseStep")] }],
                  otherwise: [listStep("innerOtherwise")],
                },
              ],
            },
          ],
        },
        { is: "b", steps: [listStep("secondCase")] },
      ],
      otherwise: [listStep("outerOtherwise")],
    },
    listStep("done"),
  ],
  result: { $ref: "steps.done" },
};

describe("the three step-list walks", () => {
  it("visit the same steps in the same order", () => {
    const expected = [
      "search",
      "route",
      "loop",
      "inner",
      "caseStep",
      "innerOtherwise",
      "secondCase",
      "outerOtherwise",
      "done",
    ];
    const walkParsed = (steps: Step[]): string[] =>
      steps.flatMap((step) => [step.id, ...stepChildren(step).flatMap(walkParsed)]);
    const resolved = resolveWorkflow(everyBlock, mealRefs, mealSignatures);
    expect(resolved.problems).toEqual([]);

    expect(locatedSteps(everyBlock).map((entry) => entry.step.id)).toEqual(expected);
    expect(walkParsed(everyBlock.steps)).toEqual(expected);
    expect(allResolved(resolved.resolved!.steps).map((step) => step.id)).toEqual(expected);
  });
});
