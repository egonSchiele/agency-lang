import { describe, expect, it } from "vitest";
import { z } from "zod";
import { __invalidArgument, describeValue } from "./invalidArgument.js";
import { failure } from "./result.js";
import { __validateType } from "./schema.js";
import type { ResultFailure } from "./result.js";

function refused(value: unknown, schema: z.ZodType): ResultFailure {
  return __validateType(value, schema) as ResultFailure;
}

describe("__invalidArgument", () => {
  const numberOrNull = z.union([z.number(), z.null()]);

  it("names the argument, its type, and what arrived", () => {
    const result = __invalidArgument({
      functionName: "logEntry",
      paramName: "value",
      typeText: "number | null",
      value: "seven",
      failure: refused("seven", numberOrNull),
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Argument "value" of logEntry must be number | null, but received the text "seven".',
    );
  });

  it("says how to send nothing when the text is a word for nothing", () => {
    const result = __invalidArgument({
      functionName: "logEntry",
      paramName: "value",
      typeText: "number | null",
      value: "None",
      failure: refused("None", numberOrNull),
    });
    expect(result.error).toBe(
      'Argument "value" of logEntry must be number | null, but received the text "None". To leave it empty, send null, not text.',
    );
  });

  it("gives no hint about null when the type does not take null", () => {
    const result = __invalidArgument({
      functionName: "setCount",
      paramName: "count",
      typeText: "number",
      value: "None",
      failure: refused("None", z.number()),
    });
    expect(result.error).toBe(
      'Argument "count" of setCount must be number, but received the text "None".',
    );
  });

  it("names the fields inside an object that did not fit", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const value = { name: "Ana", age: "ten" };
    const result = __invalidArgument({
      functionName: "savePerson",
      paramName: "person",
      typeText: "{ name: string, age: number }",
      value,
      failure: refused(value, schema),
    });
    expect(result.error).toBe(
      'Argument "person" of savePerson must be { name: string, age: number }, but received an object. Problems: age: Invalid input: expected number, received string.',
    );
  });

  it("passes a validator's own message through", () => {
    const result = __invalidArgument({
      functionName: "setAge",
      paramName: "age",
      typeText: "Age",
      value: -5,
      failure: failure("expected -5 to be > 0"),
    });
    expect(result.error).toBe('Argument "age" of setAge was refused: expected -5 to be > 0');
  });

  it("treats a validator message that only looks like a list as the validator's", () => {
    const result = __invalidArgument({
      functionName: "setTags",
      paramName: "tags",
      typeText: "Tags",
      value: ["a"],
      failure: failure('["a"] has too few tags'),
    });
    expect(result.error).toBe('Argument "tags" of setTags was refused: ["a"] has too few tags');
  });

  it("returns a failure that was passed in as the argument unchanged", () => {
    const earlier = failure("disk full");
    const result = __invalidArgument({
      functionName: "save",
      paramName: "count",
      typeText: "number",
      value: earlier,
      failure: refused(earlier, z.number()),
    });
    expect(result).toBe(earlier);
  });

  it("shortens a long text value", () => {
    const long = "x".repeat(200);
    expect(describeValue(long)).toBe(`the text "${"x".repeat(60)}"...`);
  });

  it("describes each kind of value", () => {
    expect(describeValue(3)).toBe("the number 3");
    expect(describeValue(null)).toBe("null");
    expect(describeValue(undefined)).toBe("null");
    expect(describeValue(true)).toBe("true");
    expect(describeValue([1])).toBe("a list");
    expect(describeValue({ a: 1 })).toBe("an object");
  });
});
