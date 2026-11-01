import { describe, expect, it } from "vitest";
import { stepEffects } from "./effects.js";
import { signatureKey } from "./types.js";
import { mealPlan, mealSignatures } from "./testFixtures.js";

describe("stepEffects", () => {
  it("gives one entry per tool step, in step order, with its tool's effects", () => {
    expect(stepEffects(mealPlan, mealSignatures)).toEqual([
      { step: "note", tool: "searchNotes", effects: [] },
      { step: "text", tool: "readNote", effects: ["std::read"] },
      { step: "list", tool: "findLists", effects: [] },
      { step: "add", tool: "addListItems", effects: ["test::lists::add"] },
    ]);
  });

  it("leaves out std::guard, which the program answers itself", () => {
    const key = signatureKey("./lists.agency", "addListItems");
    const signatures = {
      ...mealSignatures,
      [key]: { ...mealSignatures[key], effects: ["std::guard", "test::lists::add"] },
    };
    const add = stepEffects(mealPlan, signatures).find((entry) => entry.step === "add");
    expect(add?.effects).toEqual(["test::lists::add"]);
  });

  it("adds nothing for an LLM step", () => {
    const steps = stepEffects(mealPlan, mealSignatures).map((entry) => entry.step);
    expect(steps).not.toContain("meals");
  });

  it("gives a step whose signature is missing no effects", () => {
    const [first] = stepEffects(mealPlan, {});
    expect(first).toEqual({ step: "note", tool: "searchNotes", effects: [] });
  });
});
