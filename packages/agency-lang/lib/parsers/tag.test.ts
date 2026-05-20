import { describe, expect, it } from "vitest";
import { tagParser } from "./parsers.js";

describe("tagParser", () => {
  it("parses a simple tag", () => {
    const result = tagParser("@optimize");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "tag",
      name: "optimize",
      arguments: [],
    });
  });

  it("parses a tag with a single string argument", () => {
    const result = tagParser('@goal("Suggest good gifts")');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.name).toBe("goal");
    expect(result.result.arguments).toHaveLength(1);
    const arg = result.result.arguments[0];
    expect(arg.type).toBe("string");
    if (arg.type === "string") {
      expect(arg.segments).toEqual([
        { type: "text", value: "Suggest good gifts" },
      ]);
    }
  });

  it("parses a tag with multiple identifier arguments", () => {
    const result = tagParser("@optimize(prompt, temperature)");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.name).toBe("optimize");
    expect(result.result.arguments).toHaveLength(2);
    expect(result.result.arguments[0]).toMatchObject({
      type: "variableName",
      value: "prompt",
    });
    expect(result.result.arguments[1]).toMatchObject({
      type: "variableName",
      value: "temperature",
    });
  });

  it("parses a tag with a single identifier argument", () => {
    const result = tagParser("@optimize(temperature)");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.name).toBe("optimize");
    expect(result.result.arguments).toHaveLength(1);
    expect(result.result.arguments[0]).toMatchObject({
      type: "variableName",
      value: "temperature",
    });
  });

  it("parses a tag with PFA arguments", () => {
    const result = tagParser(
      "@validate(min.partial(n: 0), max.partial(n: 150))",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.name).toBe("validate");
    expect(result.result.arguments).toHaveLength(2);
    expect(result.result.arguments[0].type).toBe("valueAccess");
    expect(result.result.arguments[1].type).toBe("valueAccess");
  });

  it("rejects bare function call tag arguments (must use PFA)", () => {
    // After the tag-arg restriction was tightened, `@validate(min(0))` is no
    // longer a valid tag — the bare function call must be expressed as a
    // PFA expression like `@validate(min.partial(n: 0))` instead. The tag
    // parser has a zero-args fallback (so `@name` alone still parses), so
    // here we assert that the bare-call form does NOT parse into a single
    // function-call argument: either it fails outright or falls back to
    // the no-args form with `(min(0))` left unconsumed.
    const result = tagParser("@validate(min(0))");
    if (result.success) {
      expect(result.result.arguments).toHaveLength(0);
      expect(result.rest.startsWith("(")).toBe(true);
    }
  });

  it("parses a tag with an object literal argument", () => {
    const result = tagParser('@jsonSchema({ format: "email" })');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.name).toBe("jsonSchema");
    expect(result.result.arguments).toHaveLength(1);
    expect(result.result.arguments[0].type).toBe("agencyObject");
  });

  it("parses a tag with an object literal containing spread", () => {
    const result = tagParser(
      '@jsonSchema({ ...emailFormat, description: "work" })',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.arguments[0].type).toBe("agencyObject");
  });

  it("parses a tag with number / boolean / null literal arguments", () => {
    const r1 = tagParser("@retry(3)");
    expect(r1.success).toBe(true);
    if (r1.success) expect(r1.result.arguments[0].type).toBe("number");

    const r2 = tagParser("@flag(true)");
    expect(r2.success).toBe(true);
    if (r2.success) expect(r2.result.arguments[0].type).toBe("boolean");

    const r3 = tagParser("@nullable(null)");
    expect(r3.success).toBe(true);
    if (r3.success) expect(r3.result.arguments[0].type).toBe("null");
  });

  it("does not accept binary operator expressions inside tags", () => {
    // `@validate(x > 5)` cannot be parsed as a well-formed tag with args:
    // after `x` is parsed as an identifier, `> 5` is leftover and the
    // argument-list expects a comma or closing paren. Because the tag
    // parser has a "no-args" fallback (for bare `@tag`), parsing
    // succeeds with the name `validate` and zero arguments, leaving
    // the `(x > 5)` portion unconsumed. We assert that here so any
    // future tightening (e.g. committing once a `(` is seen) makes
    // the failure mode explicit.
    const result = tagParser("@validate(x > 5)");
    if (result.success) {
      expect(result.result.arguments).toHaveLength(0);
      expect(result.rest.startsWith("(x")).toBe(true);
    }
  });

  it("fails on non-tag input", () => {
    const result = tagParser("const x = 5");
    expect(result.success).toBe(false);
  });

  it("does not consume non-tag input", () => {
    const result = tagParser("node main() {}");
    expect(result.success).toBe(false);
  });

  it("includes location info", () => {
    const result = tagParser("@optimize");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.loc).toBeDefined();
  });

  // The restricted tag-arg parser uses `simpleStringParser`, which does
  // not support interpolation segments or `+`-concatenation. These tests
  // assert that contract: malformed string-shaped args don't sneak
  // through as a valid single string argument.
  it("does not accept interpolated string arguments", () => {
    const result = tagParser('@validate("hello {name}")');
    if (result.success) {
      // If parsing succeeds, the interpolation must NOT have been parsed
      // as part of the tag argument. The argument should either be the
      // plain text (no interpolation segment) or the tag should have
      // zero arguments with the rest unconsumed.
      for (const arg of result.result.arguments) {
        if (arg.type === "string") {
          for (const seg of (arg as any).segments) {
            expect(seg.type).toBe("text");
          }
        }
      }
    }
  });

  it("does not accept `+`-concatenated string arguments", () => {
    // `"hi" + foo` must not parse as a single string arg in a tag.
    // Either the parser fails outright or the arg list contains only
    // the first literal and leaves `+ foo` unconsumed inside the parens
    // (which then makes the whole tag fail or fall back to zero-args).
    const result = tagParser('@goal("hi" + foo)');
    if (result.success) {
      const arg = result.result.arguments[0];
      if (arg && arg.type === "string") {
        // It must be the plain "hi" (one text segment) — never the
        // concatenated expression.
        expect((arg as any).segments).toEqual([
          { type: "text", value: "hi" },
        ]);
      }
    }
  });
});
