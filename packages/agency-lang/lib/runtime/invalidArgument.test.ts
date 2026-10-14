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

  describe("a value that fits no option of a union", () => {
    const day = z.union([z.literal("Mon"), z.literal("Fri")]);
    const repeatRule = z.union([
      z.null(),
      z.object({ type: z.literal("daily") }),
      z.object({ type: z.literal("daysOfWeek"), days: z.array(day) }),
      z.object({ type: z.literal("dayOfMonth"), day: z.number() }),
    ]);

    function repeatRuleMessage(value: unknown): string {
      return __invalidArgument({
        functionName: "scheduleTask",
        paramName: "repeatRule",
        typeText: "RepeatRule",
        value,
        failure: refused(value, repeatRule),
      }).error;
    }

    it("lists the choices when the value is none of a union of literals", () => {
      const result = __invalidArgument({
        functionName: "pickDay",
        paramName: "day",
        typeText: '"Mon" | "Fri"',
        value: "friday",
        failure: refused("friday", day),
      });
      expect(result.error).toBe(
        'Argument "day" of pickDay must be "Mon" | "Fri", but received the text "friday". Problems: expected one of "Mon", "Fri", but received the text "friday".',
      );
    });

    it("lists the tags when the object's tag matches no option", () => {
      expect(repeatRuleMessage({ type: "weekly", days: ["Fri"] })).toBe(
        'Argument "repeatRule" of scheduleTask must be RepeatRule, but received an object. Problems: type: expected one of "daily", "daysOfWeek", "dayOfMonth", but received the text "weekly".',
      );
    });

    it("reports the problems of the option whose tag matched", () => {
      expect(repeatRuleMessage({ type: "daysOfWeek", days: ["Mon", "friday"] })).toBe(
        'Argument "repeatRule" of scheduleTask must be RepeatRule, but received an object. Problems: days.1: expected one of "Mon", "Fri", but received the text "friday".',
      );
      expect(repeatRuleMessage({ type: "dayOfMonth" })).toBe(
        'Argument "repeatRule" of scheduleTask must be RepeatRule, but received an object. Problems: day: Invalid input: expected number, received undefined.',
      );
    });

    it("says what arrived when a field is not its one literal", () => {
      const relativeDay = z.union([
        z.object({ type: z.literal("daily") }),
        z.object({ type: z.literal("relativeDayOfMonth"), anchor: z.literal("end") }),
      ]);
      const value = { type: "relativeDayOfMonth", anchor: "start" };
      const result = __invalidArgument({
        functionName: "scheduleTask",
        paramName: "repeatRule",
        typeText: "RepeatRule",
        value,
        failure: refused(value, relativeDay),
      });
      expect(result.error).toBe(
        'Argument "repeatRule" of scheduleTask must be RepeatRule, but received an object. Problems: anchor: expected "end", but received the text "start".',
      );
    });

    it("reports the only option of the right kind", () => {
      const countOrPerson = z.union([z.number(), z.object({ name: z.string() })]);
      const value = { name: 7 };
      const result = __invalidArgument({
        functionName: "greet",
        paramName: "who",
        typeText: "number | { name: string }",
        value,
        failure: refused(value, countOrPerson),
      });
      expect(result.error).toBe(
        'Argument "who" of greet must be number | { name: string }, but received an object. Problems: name: Invalid input: expected string, received number.',
      );
    });

    it("adds nothing when no option stands out", () => {
      const nameOrAge = z.union([z.object({ name: z.string() }), z.object({ age: z.number() })]);
      const result = __invalidArgument({
        functionName: "describe",
        paramName: "person",
        typeText: "{ name: string } | { age: number }",
        value: {},
        failure: refused({}, nameOrAge),
      });
      expect(result.error).toBe(
        'Argument "person" of describe must be { name: string } | { age: number }, but received an object.',
      );
    });

    it("adds nothing when the value is the wrong kind for every option", () => {
      expect(repeatRuleMessage("every friday")).toBe(
        'Argument "repeatRule" of scheduleTask must be RepeatRule, but received the text "every friday".',
      );
    });
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
