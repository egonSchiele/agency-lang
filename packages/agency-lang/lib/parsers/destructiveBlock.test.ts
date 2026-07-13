import { describe, it, expect } from "vitest";
import { destructiveBlockParser } from "./parsers.js";

describe("destructiveBlockParser", () => {
  it("parses to a seqBlock flagged destructive", () => {
    const r = destructiveBlockParser("destructive { return f(x) }");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({ type: "seqBlock", destructive: true });
    expect(r.result.body.length).toBe(1);
  });

  it("parses an empty block", () => {
    const r = destructiveBlockParser("destructive { }");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({ type: "seqBlock", destructive: true, body: [] });
  });

  it("does NOT match `destructive def` (soft-fails at `{`, backtracks)", () => {
    const r = destructiveBlockParser("destructive def f() { }");
    expect(r.success).toBe(false);
  });
});
