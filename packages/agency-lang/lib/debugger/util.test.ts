import { describe, it, expect } from "vitest";
import { parseCommandInput, formatValue, coerceArg } from "./util.js";
import type { FunctionParameter } from "../types.js";

describe("parseCommandInput", () => {
  it("returns null for empty input", () => {
    expect(parseCommandInput("")).toBeNull();
    expect(parseCommandInput("   ")).toBeNull();
  });

  it("returns null for unrecognized input", () => {
    expect(parseCommandInput("foobar")).toBeNull();
    expect(parseCommandInput("hello world")).toBeNull();
  });

  it("parses set with JSON value", () => {
    expect(parseCommandInput("set x = 42")).toEqual({
      type: "set",
      varName: "x",
      value: 42,
    });
  });

  it("parses set with string value (invalid JSON)", () => {
    expect(parseCommandInput("set name = hello")).toEqual({
      type: "set",
      varName: "name",
      value: "hello",
    });
  });

  it("parses set with JSON string value", () => {
    expect(parseCommandInput('set x = "hello"')).toEqual({
      type: "set",
      varName: "x",
      value: "hello",
    });
  });

  it("parses set with object value", () => {
    expect(parseCommandInput('set x = {"a":1}')).toEqual({
      type: "set",
      varName: "x",
      value: { a: 1 },
    });
  });

  it("parses checkpoint without label", () => {
    expect(parseCommandInput("checkpoint")).toEqual({
      type: "checkpoint",
      label: undefined,
    });
  });

  it("parses checkpoint with label", () => {
    expect(parseCommandInput('checkpoint "before loop"')).toEqual({
      type: "checkpoint",
      label: "before loop",
    });
  });

  it("parses print", () => {
    expect(parseCommandInput("print myVar")).toEqual({
      type: "print",
      varName: "myVar",
    });
  });

  it("parses reject without value", () => {
    expect(parseCommandInput("reject")).toEqual({
      type: "reject",
      value: undefined,
    });
  });

  it("parses reject with value", () => {
    expect(parseCommandInput('reject "not allowed"')).toEqual({
      type: "reject",
      value: "not allowed",
    });
  });

  it("parses resolve with JSON value", () => {
    expect(parseCommandInput("resolve 42")).toEqual({
      type: "resolve",
      value: 42,
    });
  });

  it("parses resolve with string value", () => {
    expect(parseCommandInput("resolve hello")).toEqual({
      type: "resolve",
      value: "hello",
    });
  });

  it("parses modify with single key=value", () => {
    expect(parseCommandInput("modify x=42")).toEqual({
      type: "modify",
      overrides: { x: 42 },
    });
  });

  it("parses modify with multiple key=value pairs", () => {
    expect(parseCommandInput('modify x=42 name="bob"')).toEqual({
      type: "modify",
      overrides: { x: 42, name: "bob" },
    });
  });

  it("parses save", () => {
    expect(parseCommandInput("save my-checkpoint")).toEqual({
      type: "save",
      path: "my-checkpoint",
    });
  });

  it("parses load", () => {
    expect(parseCommandInput("load my-checkpoint.json")).toEqual({
      type: "load",
      path: "my-checkpoint.json",
    });
  });
});

describe("formatValue", () => {
  it("formats undefined", () => {
    expect(formatValue(undefined)).toBe("undefined");
  });

  it("formats null", () => {
    expect(formatValue(null)).toBe("null");
  });

  it("formats strings with quotes", () => {
    expect(formatValue("hello")).toBe('"hello"');
  });

  it("formats numbers", () => {
    expect(formatValue(42)).toBe("42");
  });

  it("formats booleans", () => {
    expect(formatValue(true)).toBe("true");
  });

  it("formats short objects as JSON", () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });

  it("truncates long objects", () => {
    const longObj = { key: "a".repeat(100) };
    const result = formatValue(longObj);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).toMatch(/\.\.\.$/);
  });

  it("handles circular references", () => {
    const obj: any = {};
    obj.self = obj;
    expect(formatValue(obj)).toBe("[object]");
  });
});

describe("coerceArg", () => {
  function makeParam(
    name: string,
    primType?: string,
  ): FunctionParameter {
    return {
      type: "functionParameter",
      name,
      typeHint: primType
        ? { type: "primitiveType", value: primType } as any
        : undefined,
    };
  }

  it("coerces to number when type hint is number", () => {
    expect(coerceArg("42", makeParam("x", "number"))).toBe(42);
  });

  it("returns string if number coercion fails", () => {
    expect(coerceArg("abc", makeParam("x", "number"))).toBe("abc");
  });

  it("coerces to boolean when type hint is boolean", () => {
    expect(coerceArg("true", makeParam("x", "boolean"))).toBe(true);
    expect(coerceArg("false", makeParam("x", "boolean"))).toBe(false);
  });

  it("parses JSON objects", () => {
    expect(coerceArg('{"a":1}', makeParam("x"))).toEqual({ a: 1 });
  });

  it("returns raw string when JSON parse fails and no type hint", () => {
    expect(coerceArg("hello world", makeParam("x"))).toBe("hello world");
  });
});
