import { describe, it, expect } from "vitest";
import { CheckpointError, RestoreSignal } from "./errors.js";

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
