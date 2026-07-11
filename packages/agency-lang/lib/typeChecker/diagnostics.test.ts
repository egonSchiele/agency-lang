import { describe, it, expect } from "vitest";
import { DIAGNOSTICS, diagnostic, renderMessage } from "./diagnostics.js";

describe("diagnostic registry invariants", () => {
  const entries = Object.entries(DIAGNOSTICS);

  it("codes are unique", () => {
    const codes = entries.map(([, entry]) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("codes match AG####", () => {
    for (const [, entry] of entries) {
      expect(entry.code).toMatch(/^AG\d{4}$/);
    }
  });

  it("no template contains an unconverted TS interpolation", () => {
    // The likeliest sweep mistake: copying `${expr}` verbatim instead of
    // converting to {placeholder}. Neither the render regex nor the
    // placeholder regex would touch it — this tripwire does.
    for (const [, entry] of entries) {
      expect(entry.message).not.toContain("${");
    }
  });

  it("every brace in a template is part of a well-formed {word} placeholder", () => {
    for (const [, entry] of entries) {
      expect(entry.message.replace(/\{\w+\}/g, "")).not.toMatch(/[{}]/);
    }
  });
});

describe("renderMessage", () => {
  it("substitutes named params", () => {
    expect(renderMessage("got '{a}' and '{b}'", { a: "x", b: 2 })).toBe(
      "got 'x' and '2'",
    );
  });

  it("THROWS on a missing param instead of rendering undefined", () => {
    expect(() => renderMessage("got '{a}'", {})).toThrow(/missing param 'a'/);
  });
});

describe("diagnostic factory", () => {
  it("renders the message byte-identically to the legacy string", () => {
    const err = diagnostic(
      "reassignToConst",
      { name: "counter" },
      { line: 3, col: 2, start: 40, end: 55 },
    );
    expect(err.message).toBe("Cannot reassign to constant 'counter'.");
    expect(err.code).toBe(DIAGNOSTICS.reassignToConst.code);
    expect(err.name).toBe("reassignToConst");
    expect(err.severity).toBe("error");
    expect(err.params).toEqual({ name: "counter" });
    expect(err.loc).toEqual({ line: 3, col: 2, start: 40, end: 55 });
  });

  it("renders the multi-param assignability golden byte-identically", () => {
    const err = diagnostic(
      "typeNotAssignable",
      { actual: "string", expected: "number", name: "x" },
      null,
    );
    expect(err.message).toBe(
      "Type 'string' is not assignable to type 'number'.",
    );
    // extra structured key (name) rides along in params without rendering
    expect(err.params.name).toBe("x");
  });

  it("renders the pluralized arity golden byte-identically", () => {
    const err = diagnostic(
      "tooManyTypeArgs",
      { alias: "Pair", max: 1, argumentWord: "argument", count: 3, context: "f" },
      null,
    );
    expect(err.message).toBe(
      "Pair expects at most 1 type argument, got 3 (referenced in 'f').",
    );
  });

  it("severity override wins over the registry default", () => {
    const err = diagnostic("reassignToConst", { name: "c" }, null, {
      severity: "warning",
    });
    expect(err.severity).toBe("warning");
  });

  it("loc null is carried through (file-level diagnostic)", () => {
    // Task 4 flips this to .toBe(null) when TypeCheckError.loc becomes
    // `SourceLocation | null`.
    expect(diagnostic("reassignToConst", { name: "c" }, null).loc).toBeUndefined();
  });
});
