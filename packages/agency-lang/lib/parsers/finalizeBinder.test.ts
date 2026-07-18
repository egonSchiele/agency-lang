import { describe, it, expect } from "vitest";
import { finalizeBlockParser } from "./parsers.js";
import { parseAgency } from "../parser.js";
import type { FinalizeBlock } from "../types/finalizeBlock.js";

function parseFinalize(src: string): FinalizeBlock {
  const r = finalizeBlockParser(src);
  expect(r.success).toBe(true);
  if (!r.success) throw new Error(r.message);
  return r.result;
}

describe("finalizeBlockParser — binder head forms (via the shared asParser)", () => {
  it("parses the bare form with empty params", () => {
    const node = parseFinalize("finalize {\n  return 1\n}");
    expect(node.type).toBe("finalizeBlock");
    expect(node.params).toEqual([]);
  });

  it("parses empty parens with empty params", () => {
    const node = parseFinalize("finalize() {\n  return 1\n}");
    expect(node.params).toEqual([]);
  });

  it("parses `as name` into params[0]", () => {
    const node = parseFinalize("finalize as draft {\n  return draft\n}");
    expect(node.params).toHaveLength(1);
    expect(node.params[0].name).toBe("draft");
  });

  it("parses `() as name`", () => {
    const node = parseFinalize("finalize() as best {\n  return best\n}");
    expect(node.params[0].name).toBe("best");
  });

  it("binder name is the user's choice", () => {
    const node = parseFinalize(
      "finalize as partialSoFar {\n  return partialSoFar\n}",
    );
    expect(node.params[0].name).toBe("partialSoFar");
  });

  it("a typed binder parses (the shared grammar allows it; the checker rules on it)", () => {
    const node = parseFinalize("finalize as draft: string {\n  return draft\n}");
    expect(node.params[0].name).toBe("draft");
    expect(node.params[0].typeHint).toBeDefined();
  });

  it("multiple binders parse (rejected later by AG6038, not here)", () => {
    const node = parseFinalize("finalize as (a, b) {\n  return a\n}");
    expect(node.params).toHaveLength(2);
  });

  it("does not swallow an identifier like finalizer(...)", () => {
    const r = finalizeBlockParser("finalizer(1)");
    expect(r.success).toBe(false);
  });

  it("`as` with no name parses as the binder-less form (the shared grammar's no-param rule)", () => {
    // blockParamsParser treats `as {` as "as, then zero params" — the
    // documented no-param block form (`fork() as { }`). Reusing the
    // grammar means finalize inherits it; the formatter canonicalizes
    // the stray `as` away, exactly like guard's legacy-as migration.
    const node = parseFinalize("finalize as {\n  return 1\n}");
    expect(node.params).toEqual([]);
  });

  it("parses inside a full function body", () => {
    const r = parseAgency(
      'def f(): string {\n  return "x"\n\n  finalize as d {\n    return "y"\n  }\n}\n',
      {},
      false,
    );
    expect(r.success).toBe(true);
  });
});
