import { describe, it, expect } from "vitest";
import { Schema, __validateType } from "./schema.js";
import { z } from "zod";

describe("Schema", () => {
  it("parse returns success for valid data", () => {
    const schema = new Schema(z.object({ name: z.string(), age: z.number() }));
    const result = schema.parse({ name: "Alice", age: 30 });
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ name: "Alice", age: 30 });
  });

  it("parse returns failure for invalid data", () => {
    const schema = new Schema(z.number());
    const result = schema.parse("not a number");
    expect(result.success).toBe(false);
  });

  it("parseJSON parses valid JSON and validates", () => {
    const schema = new Schema(z.object({ x: z.number() }));
    const result = schema.parseJSON('{"x": 42}');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ x: 42 });
  });

  it("parseJSON returns failure for invalid JSON", () => {
    const schema = new Schema(z.number());
    const result = schema.parseJSON("not json");
    expect(result.success).toBe(false);
  });

  it("parseJSON returns failure for valid JSON with wrong shape", () => {
    const schema = new Schema(z.object({ x: z.number() }));
    const result = schema.parseJSON('{"x": "hello"}');
    expect(result.success).toBe(false);
  });

  it("validates primitive types", () => {
    expect(new Schema(z.number()).parse(42).success).toBe(true);
    expect(new Schema(z.number()).parse("hi").success).toBe(false);
    expect(new Schema(z.string()).parse("hi").success).toBe(true);
    expect(new Schema(z.string()).parse(42).success).toBe(false);
    expect(new Schema(z.boolean()).parse(true).success).toBe(true);
    expect(new Schema(z.boolean()).parse("true").success).toBe(false);
  });

  it("validates union types", () => {
    const schema = new Schema(z.union([z.literal("happy"), z.literal("sad")]));
    expect(schema.parse("happy").success).toBe(true);
    expect(schema.parse("angry").success).toBe(false);
  });
});

describe("__validateType", () => {
  it("returns success when value matches schema", () => {
    const result = __validateType(42, z.number());
    expect(result.success).toBe(true);
    expect(result.value).toBe(42);
  });

  it("returns failure when value doesn't match", () => {
    const result = __validateType("nope", z.number());
    expect(result.success).toBe(false);
  });

  it("works with complex schemas", () => {
    const result = __validateType({ name: "Alice" }, z.object({ name: z.string() }));
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ name: "Alice" });
  });
});
