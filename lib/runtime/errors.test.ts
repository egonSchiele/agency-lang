import { describe, it, expect } from "vitest";
import { CheckpointError, RestoreSignal, AgencyCancelledError, isAbortError } from "./errors.js";

describe("CheckpointError", () => {
  it("should have correct name and message", () => {
    const err = new CheckpointError("test message");
    expect(err.name).toBe("CheckpointError");
    expect(err.message).toBe("test message");
    expect(err instanceof Error).toBe(true);
  });
});

describe("RestoreSignal", () => {
  it("should carry checkpoint and options", () => {
    const checkpoint = { id: 0, stack: {}, globals: {}, nodeId: "main" };
    const options = { messages: [{ role: "user", content: "retry" }] };
    const signal = new RestoreSignal(checkpoint as any, options as any);
    expect(signal.name).toBe("RestoreSignal");
    expect(signal.checkpoint).toBe(checkpoint);
    expect(signal.options).toBe(options);
    expect(signal instanceof Error).toBe(true);
  });

  it("should work without options", () => {
    const checkpoint = { id: 1, stack: {}, globals: {}, nodeId: "start" };
    const signal = new RestoreSignal(checkpoint as any);
    expect(signal.options).toBeUndefined();
  });
});

describe("AgencyCancelledError", () => {
  it("should have correct name and default message", () => {
    const err = new AgencyCancelledError();
    expect(err.name).toBe("AgencyCancelledError");
    expect(err.message).toBe("Agent execution was cancelled");
    expect(err instanceof Error).toBe(true);
  });

  it("should accept a custom reason", () => {
    const err = new AgencyCancelledError("user clicked stop");
    expect(err.message).toBe("user clicked stop");
  });
});

describe("isAbortError", () => {
  it("should detect AgencyCancelledError", () => {
    expect(isAbortError(new AgencyCancelledError())).toBe(true);
  });

  it("should detect DOMException with name AbortError", () => {
    const err = new DOMException("aborted", "AbortError");
    expect(isAbortError(err)).toBe(true);
  });

  it("should detect Error with name AbortError", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
  });

  it("should return false for regular errors", () => {
    expect(isAbortError(new Error("something else"))).toBe(false);
  });

  it("should return false for non-error values", () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("string")).toBe(false);
    expect(isAbortError(42)).toBe(false);
  });
});
