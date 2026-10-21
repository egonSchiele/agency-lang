import * as path from "path";
import { describe, expect, it } from "vitest";

import { loadInputs } from "../loadInputs.js";
import { loadGradersJson } from "./load.js";

const FIXTURE = path.join(__dirname, "fixtures", "packaging-decision");

describe("a test folder with graders.json, end to end", () => {
  it("loads through the suite loader and builds the seven graders in file order", async () => {
    const [test] = loadInputs(FIXTURE);
    expect(test.id).toBe("packaging-decision");
    expect(test.goal).toBeUndefined();
    expect(test.graders).toBe(path.join(FIXTURE, "graders.json"));

    const graders = await loadGradersJson(test.graders ?? "");
    expect(graders.map((grader) => grader.name())).toEqual([
      "takes-a-position",
      "grounded-in-repo",
      "finds-the-hinge",
      "readability",
      "llm-calls",
      "wall-seconds",
      "cost-usd",
    ]);
    const gate = graders[0];
    expect(gate.mustPass()).toBe(true);
    expect(gate.passes({ score: { kind: "scalar", value: 0.4 } })).toBe(false);
    expect(gate.passes({ score: { kind: "scalar", value: 0.6 } })).toBe(true);
    expect(graders.slice(1).every((grader) => !grader.mustPass())).toBe(true);
    expect(graders.map((grader) => grader.weight())).toEqual([1, 1, 0.5, 0.5, 0.1, 0.1, 0.1]);
  });
});
