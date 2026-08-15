import { describe, expect, it } from "vitest";
import {
  _combine,
  _fill,
  _loadTemplateFromString,
  _parseExpr,
  _parseStatements,
} from "../../stdlib/template.js";
import { kindOf } from "./code.js";
import type { Code } from "./code.js";

function statements(source: string): Code {
  return _parseStatements(source);
}

function expr(source: string): Code {
  return _parseExpr(source);
}

function program(source: string): Code {
  return _loadTemplateFromString(source);
}

describe("_combine", () => {
  it("merges nothing into an empty statement list", () => {
    // Matches parseStatements("") and the empty code literal.
    const merged = _combine([]);
    expect(kindOf(merged)).toBe("statements");
    expect(merged.nodes).toHaveLength(0);
  });

  it("returns a single fragment unchanged", () => {
    // So combine around a loop that ran once behaves like no combine.
    const one = program(`def f(): number {\n  return 1\n}\n`);
    expect(_combine([one])).toBe(one);
  });

  it("merges program fragments into a program fragment", () => {
    const merged = _combine([
      program(`def a(): number {\n  return 1\n}\n`),
      program(`def b(): number {\n  return 2\n}\n`),
    ]);
    expect(kindOf(merged)).toBe("program");
  });

  it("concatenates nodes in order", () => {
    const merged = _combine([
      program(`def a(): number {\n  return 1\n}\n`),
      program(`def b(): number {\n  return 2\n}\n`),
    ]);
    const names = merged.nodes
      .filter((node) => node.type === "function")
      .map((node) => (node as { functionName: string }).functionName);
    expect(names).toEqual(["a", "b"]);
  });

  it("carries nodes through by identity rather than reshaping them", () => {
    const first = program(`def a(): number {\n  return 1\n}\n`);
    const second = program(`def b(): number {\n  return 2\n}\n`);
    const merged = _combine([first, second]);
    expect(merged.nodes[0]).toBe(first.nodes[0]);
    expect(merged.nodes[merged.nodes.length - 1]).toBe(second.nodes[second.nodes.length - 1]);
  });

  it("merges statement fragments into a statement fragment", () => {
    const merged = _combine([statements(`const a = 1`), statements(`const b = 2`)]);
    expect(kindOf(merged)).toBe("statements");
    expect(merged.nodes).toHaveLength(2);
  });

  it("merges several expressions into a statement list", () => {
    // Two expressions cannot be one expression. Widening is not a new
    // decision, since fill already accepts expr wherever statements go.
    const merged = _combine([expr(`1 + 1`), expr(`2 + 2`)]);
    expect(kindOf(merged)).toBe("statements");
    expect(merged.nodes).toHaveLength(2);
  });

  it("merges a mix of expressions and statements into a statement list", () => {
    const merged = _combine([expr(`1 + 1`), statements(`const b = 2`)]);
    expect(kindOf(merged)).toBe("statements");
  });

  it("refuses to merge a program fragment with loose statements", () => {
    // A declaration and a bare statement have different placement rules,
    // so a silent merge would fail much later with no useful position.
    expect(() =>
      _combine([program(`def a(): number {\n  return 1\n}\n`), statements(`const b = 2`)]),
    ).toThrow(/whole-program fragment cannot merge/);
  });

  it("names both mismatched kinds in the failure", () => {
    let message = "";
    try {
      _combine([program(`def a(): number {\n  return 1\n}\n`), expr(`2 + 2`)]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("expr");
    expect(message).toContain("program");
  });

  it("produces a fragment fill accepts wherever that kind is accepted", () => {
    // The property that makes combine useful rather than merely present.
    const merged = _combine([
      program(`def a(): number {\n  return 1\n}\n`),
      program(`def b(): number {\n  return 2\n}\n`),
    ]);
    const template = _loadTemplateFromString(
      `#...body\n\ndef caller(): number {\n  return a()\n}\n`,
    );
    const filled = _fill(template, { body: [merged] });
    const names = filled.nodes
      .filter((node) => node.type === "function")
      .map((node) => (node as { functionName: string }).functionName);
    expect(names).toEqual(expect.arrayContaining(["a", "b", "caller"]));
  });
});
