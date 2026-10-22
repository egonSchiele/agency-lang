import { describe, expect, it } from "vitest";
import { validate, VALIDATION_RULES } from "./validate.js";
import { agentShapedCheckpoint } from "./testCheckpoints.js";
import { deepClone } from "../../utils.js";
import { Checkpoint, type CheckpointJSON } from "../checkpointStore.js";

function source(): Checkpoint {
  return agentShapedCheckpoint();
}

/** A copy of the source's JSON to break, and the checkpoint over it. */
function copy(): { json: CheckpointJSON; checkpoint: Checkpoint } {
  const json = deepClone(source().toJSON());
  return { json, checkpoint: new Checkpoint(json) };
}

describe("validate", () => {
  it("every rule has a name, and a checkpoint equal to its source passes", () => {
    expect(VALIDATION_RULES.map((rule) => rule.name)).toEqual([
      "unanswered tool call",
      "guard over its limit",
    ]);
    expect(validate(source(), source())).toEqual([]);
  });

  it("a guard pushed over its limit without a disarm is refused, naming the rule", () => {
    const result = copy();
    result.json.stack.guards![0] = {
      ...result.json.stack.guards![0],
      kind: "time",
      timeLimit: 5000,
      elapsedMs: 10000,
    };
    expect(validate(source(), result.checkpoint)).toEqual([
      { refused: "guard over its limit: research would trip at once (10000 of 5000)" },
    ]);
    result.json.stack.guards![0].disarmed = true;
    expect(validate(source(), result.checkpoint)).toEqual([]);
  });

  it("a rule the source already breaks is not held against the result", () => {
    // The source's root loop ends in a call to search that only a
    // branch answers; take the branch away in both, and the source
    // breaks the rule too, so an unrelated edit still goes through.
    const broken = copy();
    delete broken.json.stack.stack[1].branches;
    const result = copy();
    delete result.json.stack.stack[1].branches;
    result.json.stack.stack[0].locals.answer = "x";
    expect(validate(broken.checkpoint, result.checkpoint)).toEqual([]);
    // Introduced by the edit, it is refused.
    expect(validate(source(), result.checkpoint)).toEqual([
      { refused: "unanswered tool call: thread main ends in a call to search with no result" },
    ]);
  });
});
