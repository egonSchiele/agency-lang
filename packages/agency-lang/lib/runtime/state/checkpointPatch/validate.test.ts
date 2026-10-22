import { describe, expect, it } from "vitest";
import { validate, VALIDATION_RULES } from "./validate.js";
import { agentShapedCheckpoint } from "./testCheckpoints.js";
import { deepClone } from "../../utils.js";
import type { CheckpointJSON } from "../checkpointStore.js";

function source(): CheckpointJSON {
  return agentShapedCheckpoint().toJSON();
}

describe("validate", () => {
  it("every rule has a name, and a checkpoint equal to its source passes", () => {
    expect(VALIDATION_RULES.map((rule) => rule.name)).toEqual([
      "unanswered tool call",
      "guard over its limit",
      "shape",
    ]);
    expect(validate(source(), source())).toEqual([]);
  });

  it("a guard pushed over its limit without a disarm is refused, naming the rule", () => {
    const result = deepClone(source());
    result.stack.guards![0] = {
      ...result.stack.guards![0],
      kind: "time",
      timeLimit: 5000,
      elapsedMs: 10000,
    };
    expect(validate(source(), result)).toEqual([
      { refused: "guard over its limit: research would trip at once (10000 of 5000)" },
    ]);
    result.stack.guards![0].disarmed = true;
    expect(validate(source(), result)).toEqual([]);
  });

  it("a rule the source already breaks is not held against the result", () => {
    // The source's root loop ends in a call to search that only a
    // branch answers; take the branch away in both, and the source
    // breaks the rule too, so an unrelated edit still goes through.
    const broken = deepClone(source());
    delete broken.stack.stack[1].branches;
    const result = deepClone(broken);
    result.stack.stack[0].locals.answer = "x";
    expect(validate(broken, result)).toEqual([]);
    // Introduced by the edit, it is refused.
    const fresh = deepClone(source());
    delete fresh.stack.stack[1].branches;
    expect(validate(source(), fresh)).toEqual([
      { refused: "unanswered tool call: thread main ends in a call to search with no result" },
    ]);
  });

  it("a result the schema refuses is refused with its message", () => {
    const result = deepClone(source()) as unknown as Record<string, unknown>;
    result.nodeId = 5;
    const refusals = validate(source(), result as unknown as CheckpointJSON);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].refused).toMatch(/^shape: /);
  });
});
