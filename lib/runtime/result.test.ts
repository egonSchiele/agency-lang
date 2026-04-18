import { describe, it, expect } from "vitest";
import { success, failure, isSuccess, isFailure, __pipeBind } from "./result.js";

describe("success", () => {
  it("creates a success result", () => {
    const result = success(42);
    expect(result).toEqual({ __type: "resultType", success: true, value: 42 });
  });

  it("creates a success result with a string value", () => {
    const result = success("hello");
    expect(result).toEqual({ __type: "resultType", success: true, value: "hello" });
  });

  it("creates a success result with null value", () => {
    const result = success(null);
    expect(result).toEqual({ __type: "resultType", success: true, value: null });
  });
});

describe("failure", () => {
  it("creates a failure result with string error", () => {
    const result = failure("something went wrong");
    expect(result).toEqual({
      __type: "resultType",
      success: false,
      error: "something went wrong",
      checkpoint: null,
      retryable: false,
      functionName: null,
      args: null,
    });
  });

  it("creates a failure result with object error", () => {
    const result = failure({ code: 404, message: "not found" });
    expect(result).toEqual({
      __type: "resultType",
      success: false,
      error: { code: 404, message: "not found" },
      checkpoint: null,
      retryable: false,
      functionName: null,
      args: null,
    });
  });

  it("accepts opts with checkpoint, retryable, functionName, args", () => {
    const cp = { id: 1 };
    const result = failure("error", {
      checkpoint: cp,
      retryable: true,
      functionName: "myFunc",
      args: { x: 10 },
    });
    expect(result.checkpoint).toBe(cp);
    expect(result.retryable).toBe(true);
    expect(result.functionName).toBe("myFunc");
    expect(result.args).toEqual({ x: 10 });
  });

  it("defaults checkpoint to null when no opts", () => {
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

describe("__pipeBind", () => {
  it("short-circuits on failure", async () => {
    const fail = failure("something went wrong");
    const result = await __pipeBind(fail, (x) => success(x + 1));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("something went wrong");
  });

  it("applies function on success (bind: fn returns Result)", async () => {
    const ok = success(5);
    const result = await __pipeBind(ok, (x) => success(x * 2));
    expect(result.success).toBe(true);
    if (result.success) expect(result.value).toBe(10);
  });

  it("wraps plain return value in success (fmap)", async () => {
    const ok = success(5);
    const result = await __pipeBind(ok, (x) => x * 2);
    expect(result.success).toBe(true);
    if (result.success) expect(result.value).toBe(10);
  });

  it("propagates failure from fn (bind)", async () => {
    const ok = success(5);
    const result = await __pipeBind(ok, (_x) => failure("downstream error"));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("downstream error");
  });

  it("chains multiple pipes", async () => {
    const start = success(2);
    const r1 = await __pipeBind(start, (x) => success(x + 3));
    const r2 = await __pipeBind(r1, (x) => x * 10);
    const r3 = await __pipeBind(r2, (x) => success(x + 1));
    expect(r3.success).toBe(true);
    if (r3.success) expect(r3.value).toBe(51);
  });

  it("chains stop at first failure", async () => {
    const start = success(2);
    const r1 = await __pipeBind(start, (_x) => failure("oops"));
    const r2 = await __pipeBind(r1, (x) => success(x + 100));
    expect(r2.success).toBe(false);
    if (!r2.success) expect(r2.error).toBe("oops");
  });
});
