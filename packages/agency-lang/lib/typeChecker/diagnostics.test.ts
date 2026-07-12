import { describe, it, expect } from "vitest";
import {
  DIAGNOSTICS,
  DIAGNOSTIC_CATEGORIES,
  categoryForCode,
  diagnostic,
  renderMessage,
} from "./diagnostics.js";
import {
  formatOptionalUnboundWarning,
  formatRequiredUnboundError,
} from "../runtime/toolBlockDiagnostics.js";

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

  it("every brace in a template is a {word} placeholder or an {{escape}}", () => {
    for (const [, entry] of entries) {
      const withoutEscapes = entry.message.replace(/\{\{|\}\}/g, "");
      expect(withoutEscapes.replace(/\{\w+\}/g, "")).not.toMatch(/[{}]/);
    }
  });

  it("every code maps to exactly one category", () => {
    for (const [name, entry] of entries) {
      const cat = categoryForCode(entry.code);
      expect(
        cat,
        `${name} (${entry.code}) has no DIAGNOSTIC_CATEGORIES entry for prefix '${entry.code.slice(0, 3)}' — add one`,
      ).toBeDefined();
    }
  });

  it("no two categories share a prefix", () => {
    const prefixes = DIAGNOSTIC_CATEGORIES.map((c) => c.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
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

  it("unescapes literal braces written as {{ and }}", () => {
    expect(renderMessage("match (r) {{ {arm} }}", { arm: "..." })).toBe(
      "match (r) { ... }",
    );
  });
});

describe("registry <-> runtime formatter locks", () => {
  it("tool-binding templates render exactly what the runtime formatters produce", () => {
    // The compile-time wording moved into the registry; the runtime backstop
    // keeps its own formatters. This equality is what previously held "by
    // construction" via a shared formatter — now it is pinned.
    const typed = diagnostic(
      "toolRequiredParamUnboundTyped",
      { tool: "deploy", param: "block", type: "() => void" },
      null,
    );
    expect(typed.message).toBe(
      formatRequiredUnboundError("deploy", "block", "() => void"),
    );
    const untyped = diagnostic(
      "toolRequiredParamUnbound",
      { tool: "deploy", param: "block" },
      null,
    );
    expect(untyped.message).toBe(formatRequiredUnboundError("deploy", "block"));
    const dropped = diagnostic(
      "toolOptionalParamsDropped",
      { tool: "deploy", params: "'a', 'b'" },
      null,
    );
    expect(dropped.message).toBe(
      formatOptionalUnboundWarning("deploy", ["a", "b"]),
    );
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
    expect(err.params?.name).toBe("x");
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
    expect(diagnostic("reassignToConst", { name: "c" }, null).loc).toBe(null);
  });
});
