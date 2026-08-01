import { describe, expect, it } from "vitest";
import { typeCheckSource } from "../compiler/typecheck.js";

const orderError = (source: string) =>
  typeCheckSource(source).errors.find(
    (e) => (e as { code?: string }).code === "AG6039",
  );

describe("required parameter after a defaulted one (AG6039)", () => {
  it("errors on a node", () => {
    const err = orderError('node t(a: string = "x", b: string) { return b }');
    expect(err).toBeDefined();
    expect(err?.message).toContain("'b'");
  });

  it("a def with the same shape is already rejected by the GRAMMAR", () => {
    // Node parameters accept any order at parse time (hence AG6039);
    // def parameters do not — the parser stops at the required-after-
    // defaulted parameter. The pass still covers defs in case the
    // grammar ever loosens.
    expect(() => typeCheckSource('def f(a: string = "x", b: string) { return b }'))
      .toThrow(/expected/);
  });

  it("allows defaults last", () => {
    expect(orderError('node t(a: string, b: string = "x") { return a }')).toBeUndefined();
  });

  it("allows every parameter defaulted", () => {
    expect(orderError('def f(a: string = "x", b: string = "y") { return a }')).toBeUndefined();
  });

  it("allows no defaults at all", () => {
    expect(orderError('node t(a: string, b: string) { return a }')).toBeUndefined();
  });
});
