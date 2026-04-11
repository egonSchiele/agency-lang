import { describe, it, expect } from "vitest";
import { success, failure, isSuccess, isFailure } from "./result.js";

describe("success", () => {
  it("creates a success result", () => {
    const result = success(42);
    expect(result).toEqual({ success: true, value: 42 });
  });

  it("creates a success result with a string value", () => {
    const result = success("hello");
    expect(result).toEqual({ success: true, value: "hello" });
  });

  it("creates a success result with null value", () => {
    const result = success(null);
    expect(result).toEqual({ success: true, value: null });
  });
});

describe("failure", () => {
  it("creates a failure result with string error", () => {
    const result = failure("something went wrong");
    expect(result).toEqual({ success: false, error: "something went wrong", checkpoint: null });
  });

  it("creates a failure result with object error", () => {
    const result = failure({ code: 404, message: "not found" });
    expect(result).toEqual({
      success: false,
      error: { code: 404, message: "not found" },
      checkpoint: null,
    });
  });

  it("always sets checkpoint to null", () => {
    const result = failure("error");
    expect(result.checkpoint).toBeNull();
  });
});

describe("isSuccess", () => {
  it("returns true for success results", () => {
    expect(isSuccess(success(42))).toBe(true);
  });

  it("returns false for failure results", () => {
    expect(isSuccess(failure("error"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isSuccess(null as any)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isSuccess(undefined as any)).toBe(false);
  });
});

describe("isFailure", () => {
  it("returns true for failure results", () => {
    expect(isFailure(failure("error"))).toBe(true);
  });

  it("returns false for success results", () => {
    expect(isFailure(success(42))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isFailure(null as any)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isFailure(undefined as any)).toBe(false);
  });
});
