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

  it("parses a tag with a function call argument", () => {
    const result = tagParser("@validate(min(0), max(150))");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.name).toBe("validate");
    expect(result.result.arguments).toHaveLength(2);
    expect(result.result.arguments[0].type).toBe("functionCall");
    expect(result.result.arguments[1].type).toBe("functionCall");
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
});
