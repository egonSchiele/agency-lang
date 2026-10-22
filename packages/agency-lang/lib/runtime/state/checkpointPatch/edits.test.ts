import { describe, expect, it } from "vitest";
import { checkpointEditSchema, checkpointEditsSchema } from "./edits.js";

describe("checkpoint edit schemas", () => {
  it("parses each named edit", () => {
    const edits = [
      { op: "appendMessage", thread: { label: "main" }, text: "stop" },
      { op: "removeTool", tool: "search" },
      { op: "setGuard", guard: { label: "research" }, disarmed: true },
      { op: "setLocal", frame: { branchPath: ["tool_0_abc"], depth: 0 }, name: "x", value: 5 },
      { op: "setBranchResult", branch: { key: "fork_1" }, value: "done" },
      { op: "setArg", name: "query", value: "other" },
      { op: "setGlobal", module: "mod", name: "g", value: null },
    ];
    expect(checkpointEditsSchema.parse(edits)).toEqual(edits);
  });

  it("refuses an empty message, a prototype key, and an unknown op", () => {
    expect(checkpointEditSchema.safeParse({ op: "appendMessage", text: "" }).success).toBe(false);
    expect(
      checkpointEditSchema.safeParse({ op: "setLocal", name: "__proto__", value: 1 }).success,
    ).toBe(false);
    expect(checkpointEditSchema.safeParse({ op: "setLocal", name: "1x", value: 1 }).success).toBe(
      false,
    );
    expect(checkpointEditSchema.safeParse({ op: "jump", step: 3 }).success).toBe(false);
  });

  it("refuses a guard edit that changes nothing", () => {
    expect(
      checkpointEditSchema.safeParse({ op: "setGuard", guard: { label: "research" } }).success,
    ).toBe(false);
  });
});
