/**
 * Spec 2026-06-03 Part 5.4: runtime tool-registration backstop.
 *
 * Direct unit tests for `AgencyFunction.validateForLLM`. The agency-js
 * end-to-end test (test #39) lives separately so the smoltalk-mock
 * round-trip is covered. The unified-wording check (test #42) is also
 * included here because it cross-references the compile-time message
 * produced by the validator.
 */
import { describe, expect, it } from "vitest";
import { AgencyFunction } from "./agencyFunction.js";
import { formatUnboundClause } from "./toolBlockDiagnostics.js";

function makeFn(
  params: {
    name: string;
    isFunctionTyped?: boolean;
    hasDefault?: boolean;
    variadic?: boolean;
    isBound?: boolean;
    boundValue?: unknown;
  }[],
) {
  return new AgencyFunction({
    name: "deploy",
    module: "test.agency",
    fn: async (...args: unknown[]) => args,
    params: params.map((p) => ({
      name: p.name,
      hasDefault: p.hasDefault ?? false,
      defaultValue: undefined,
      variadic: p.variadic ?? false,
      isFunctionTyped: p.isFunctionTyped ?? false,
      isBound: p.isBound,
      boundValue: p.boundValue,
    })),
    toolDefinition: null,
  });
}

describe("AgencyFunction.validateForLLM (runtime tool backstop)", () => {
  // #36 — rejects unbound required function-typed param.
  it("throws when a required function-typed param is unbound", () => {
    const fn = makeFn([{ name: "block", isFunctionTyped: true }]);
    expect(() => fn.validateForLLM()).toThrow();
    try {
      fn.validateForLLM();
    } catch (e: any) {
      expect(e.message).toContain("deploy");
      expect(e.message).toContain("block");
      expect(e.message).toContain(".partial(");
    }
  });

  // #37 — accepts when bound.
  it("does not throw when the function-typed param is PFA-bound", () => {
    const fn = makeFn([
      { name: "block", isFunctionTyped: true, isBound: true, boundValue: () => {} },
    ]);
    expect(() => fn.validateForLLM()).not.toThrow();
  });

  // #38 — ignores optional unbound function-typed params (compile-time
  // warning is the only signal).
  it("does not throw for optional unbound function-typed params", () => {
    const fn = makeFn([
      { name: "block", isFunctionTyped: true, hasDefault: true },
    ]);
    expect(() => fn.validateForLLM()).not.toThrow();
  });

  // #36b — non-function-typed params are never the backstop's business.
  it("does not throw for a required non-function-typed param", () => {
    const fn = makeFn([{ name: "id", isFunctionTyped: false }]);
    expect(() => fn.validateForLLM()).not.toThrow();
  });

  // #42 — unified runtime/compile-time error wording. The canonical clause
  // `required function-typed parameter '<name>' is unbound` appears in BOTH
  // the compile-time error message (toolBlockBinding.test.ts #12) and the
  // runtime error message thrown here. Pinning the shared substring keeps
  // the two paths from drifting apart silently.
  it("produces an error message containing the canonical unbound clause", () => {
    const fn = makeFn([{ name: "block", isFunctionTyped: true }]);
    expect(() => fn.validateForLLM()).toThrow(formatUnboundClause("block"));
    expect(formatUnboundClause("block")).toBe(
      "required function-typed parameter 'block' is unbound",
    );
  });
});

describe("AgencyFunction.partial — variadic shape backstop", () => {
  // #41 — when the static type was `any` and a non-array value sneaks
  // through, the runtime throws at .partial() time with a clear message.
  it("throws when binding a variadic to a non-array value", () => {
    const fn = new AgencyFunction({
      name: "foo",
      module: "test.agency",
      fn: async (...args: unknown[]) => args,
      params: [
        {
          name: "rest",
          hasDefault: false,
          defaultValue: undefined,
          variadic: true,
        },
      ],
      toolDefinition: null,
    });
    expect(() => fn.partial({ rest: "not-an-array" as any })).toThrow(
      /must be bound to an array/,
    );
  });
});
