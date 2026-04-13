import { describe, expect, it } from "vitest";
import { tagParser } from "./tag.js";

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
    expect(result.result).toMatchObject({
      type: "tag",
      name: "goal",
      arguments: ["Suggest good gifts"],
    });
  });

  it("parses a tag with multiple identifier arguments", () => {
    const result = tagParser("@optimize(prompt, temperature)");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "tag",
      name: "optimize",
      arguments: ["prompt", "temperature"],
    });
  });

  it("parses a tag with a single identifier argument", () => {
    const result = tagParser("@optimize(temperature)");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "tag",
      name: "optimize",
      arguments: ["temperature"],
    });
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
