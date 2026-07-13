import { describe, it, expect } from "vitest";
import { destructiveBlockParser } from "./parsers.js";
import { parseAgency } from "../parser.js";

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

  it("a full program: `destructive def` with a nested `destructive { }` parses", () => {
    const r = parseAgency(
      "destructive def f(): number {\n  destructive {\n    return 1\n  }\n}",
      {},
      false,
    );
    expect(r.success).toBe(true);
  });

  it("a top-level `destructive { }` inside a function body parses via the statement parser", () => {
    const r = parseAgency(
      "def f(): number {\n  destructive {\n    return 1\n  }\n}",
      {},
      false,
    );
    expect(r.success).toBe(true);
  });

  it("`destructive def` at program level still parses (regression)", () => {
    const r = parseAgency("destructive def f(): number {\n  return 1\n}", {}, false);
    expect(r.success).toBe(true);
  });
});
