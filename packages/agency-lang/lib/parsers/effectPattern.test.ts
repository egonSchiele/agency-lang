import { describe, it, expect } from "vitest";
import { matchPatternParser, exprParser } from "./parsers.js";
import { parseAgency } from "@/parser.js";
import type { EffectPattern } from "../types/pattern.js";
import { normalizeCode } from "@/index.js";

/** Parse a whole program and return its error message. The committed
 *  failure `parseError` raises escapes a direct sub-parser call, so a
 *  committed-error assertion has to go through the top-level parser. */
function parseFailureMessage(src: string): string {
  const parsed = parseAgency(src, {}, false);
  if (parsed.success) throw new Error(`expected a failed parse for:\n${src}`);
  return parsed.message ?? "";
}

describe("effectPatternParser (via matchPatternParser)", () => {
  it("parses a bare namespaced effect name", () => {
    const result = matchPatternParser(normalizeCode("std::read"));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toEqualWithoutLoc({
      type: "effectPattern",
      effect: "std::read",
      binding: null,
    });
  });

  it("parses an effect name with an object binding", () => {
    const result = matchPatternParser(normalizeCode("std::read({ data })"));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const pattern = result.result as EffectPattern;
    expect(pattern.type).toBe("effectPattern");
    expect(pattern.effect).toBe("std::read");
    expect(pattern.binding?.type).toBe("objectPattern");
  });

  it("parses the binding form with a space before the parens", () => {
    // `std::read ({ data })` must be the binding form, not a bare pattern with
    // ` ({ data })` left unconsumed to die downstream with a generic error.
    const result = matchPatternParser(normalizeCode("std::read ({ data })"));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const pattern = result.result as EffectPattern;
    expect(pattern.type).toBe("effectPattern");
    expect(pattern.effect).toBe("std::read");
    expect(pattern.binding?.type).toBe("objectPattern");
  });

  it("leaves a bare identifier as a variableName binder, not an effect pattern", () => {
    const result = matchPatternParser(normalizeCode("foo"));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.result as { type: string }).type).toBe("variableName");
  });

  it("rejects a positional binding with a committed, specific error", () => {
    // `std::read(data)` — positional, no braces — is the model's observed
    // guess. It must NOT soft-fail through to variableNameParser; the commit in
    // effectPatternParser makes it a committed failure naming the object-pattern
    // requirement.
    const message = parseFailureMessage(
      "node main() {\n  match (intr) {\n    std::read(data) => { return approve() }\n    _ => { return reject() }\n  }\n}",
    );
    expect(message).toContain("object pattern");
    expect(message).toContain("std::read({ data })");
  });
});

describe("effect patterns after `is`", () => {
  it("parses `intr is std::read` as a bare effect pattern", () => {
    const result = exprParser("intr is std::read");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "isExpression",
      pattern: { type: "effectPattern", effect: "std::read", binding: null },
    });
  });

  it("parses `intr is std::read({ data })` with an object binding", () => {
    const result = exprParser("intr is std::read({ data })");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "isExpression",
      pattern: { type: "effectPattern", effect: "std::read", binding: { type: "objectPattern" } },
    });
  });
});
