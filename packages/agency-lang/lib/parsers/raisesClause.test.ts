import { describe, it, expect } from "vitest";
import { functionParser, graphNodeParser } from "./parsers.js";

describe("raises clause on def", () => {
  it("parses an inline effect-set raises clause after a return type", () => {
    const r = functionParser('def readFile(p: string): string raises <std::read> { return read(p) }');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.raises).toMatchObject({
      type: "unionType",
      isEffectSet: true,
      types: [{ type: "stringLiteralType", value: "std::read" }],
    });
  });

  it("parses a raises clause with no return type", () => {
    // Body avoids `raise` (added in a later task) so this test is self-contained.
    const r = functionParser('def w(p: string) raises <std::write> { return 1 }');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.raises).toMatchObject({ isEffectSet: true });
  });

  it("parses a bare effectSet reference", () => {
    const r = functionParser('def d(): number raises FsKinds { return 1 }');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.raises).toMatchObject({ type: "typeAliasVariable", aliasName: "FsKinds" });
  });

  it("parses raises <> and raises <*>", () => {
    const empty = functionParser('def s(): number raises <> { return 1 }');
    expect(empty.success).toBe(true);
    if (empty.success) expect(empty.result.raises).toMatchObject({ type: "unionType", types: [] });
    const star = functionParser('def l(): number raises <*> { return 1 }');
    expect(star.success).toBe(true);
    if (star.success) expect(star.result.raises).toMatchObject({ type: "primitiveType", value: "any" });
  });

  it("leaves raises undefined when no clause is present", () => {
    const r = functionParser('def p(x: number): number { return x }');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.raises == null).toBe(true);
  });
});

describe("raises clause on node", () => {
  it("parses raises on a node definition", () => {
    const r = graphNodeParser('node main() raises <std::read, std::write> { print("hi") }');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.raises).toMatchObject({
      type: "unionType",
      isEffectSet: true,
      types: [
        { type: "stringLiteralType", value: "std::read" },
        { type: "stringLiteralType", value: "std::write" },
      ],
    });
  });

  it("leaves raises undefined when absent on a node", () => {
    const r = graphNodeParser('node main() { print("hi") }');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.raises == null).toBe(true);
  });
});

import { blockTypeParser } from "./parsers.js";

describe("raises clause on function types", () => {
  it("parses a raises clause after the return type", () => {
    const r = blockTypeParser("(string) -> string raises <std::read>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect((r.result as any).raises).toMatchObject({ type: "unionType", isEffectSet: true });
  });

  it("leaves raises undefined when absent", () => {
    const r = blockTypeParser("(string) -> string");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect((r.result as any).raises == null).toBe(true);
  });
});
