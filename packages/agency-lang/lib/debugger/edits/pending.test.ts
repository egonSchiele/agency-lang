import { describe, expect, it } from "vitest";
import { previewOf, pendingLocals } from "./pending.js";
import { agentShapedCheckpoint } from "../../runtime/state/checkpointPatch/testCheckpoints.js";

const settings = { read: () => null, log: () => {} };

describe("previewOf", () => {
  it("draws the checkpoint as it will be, and says what changed", () => {
    const cp = agentShapedCheckpoint();
    const preview = previewOf(cp, [{ op: "setLocal", name: "answer", value: "x" }], settings);
    if ("refused" in preview) throw new Error(preview.refused.join());
    expect(preview.applied).toEqual(['answer = "x"']);
    expect(preview.checkpoint.stack.stack[0].locals.answer).toBe("x");
    expect(cp.stack.stack[0].locals.answer).toBeNull();
  });

  it("passes a refusal through", () => {
    const cp = agentShapedCheckpoint();
    expect(previewOf(cp, [{ op: "removeTool", tool: "nope" }], settings)).toEqual({
      refused: ["no tool nope in this loop (search, writeUp)"],
    });
  });
});

describe("pendingLocals", () => {
  it("the names a pending setLocal or setArg changes on a frame", () => {
    const edits = [
      { op: "setLocal" as const, frame: { branchPath: [], depth: 1 }, name: "answer", value: 1 },
      { op: "setArg" as const, frame: { branchPath: [], depth: 1 }, name: "task", value: "t" },
      {
        op: "setLocal" as const,
        frame: { branchPath: ["tool_0_abc"], depth: 1 },
        name: "url",
        value: "u",
      },
    ];
    expect(pendingLocals(edits, { branchPath: [], depth: 1 })).toEqual(["answer", "task"]);
    expect(pendingLocals(edits, { branchPath: ["tool_0_abc"], depth: 1 })).toEqual(["url"]);
  });
});
