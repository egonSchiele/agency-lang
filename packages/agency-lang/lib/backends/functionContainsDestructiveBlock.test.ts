import { describe, it, expect } from "vitest";
import { functionContainsDestructiveBlock } from "./functionContainsDestructiveBlock.js";
import type { AgencyNode } from "../types.js";

describe("functionContainsDestructiveBlock", () => {
  it("true for a top-level destructive seqBlock", () => {
    const body = [{ type: "seqBlock", destructive: true, body: [] }] as AgencyNode[];
    expect(functionContainsDestructiveBlock(body)).toBe(true);
  });

  it("true for a destructive seqBlock nested inside an if", () => {
    const body = [
      {
        type: "ifElse",
        condition: { type: "boolean", value: true },
        thenBody: [{ type: "seqBlock", destructive: true, body: [] }],
        elseBody: [],
      },
    ] as unknown as AgencyNode[];
    expect(functionContainsDestructiveBlock(body)).toBe(true);
  });

  it("false for a plain (non-destructive) seqBlock", () => {
    const body = [{ type: "seqBlock", body: [] }] as AgencyNode[];
    expect(functionContainsDestructiveBlock(body)).toBe(false);
  });

  it("true for the post-desugar markDestructiveRan leaf", () => {
    const body = [{ type: "markDestructiveRan" }] as AgencyNode[];
    expect(functionContainsDestructiveBlock(body)).toBe(true);
  });

  it("false when there is no seqBlock", () => {
    const body = [{ type: "returnStatement", value: { type: "number", value: 1 } }] as unknown as AgencyNode[];
    expect(functionContainsDestructiveBlock(body)).toBe(false);
  });
});
