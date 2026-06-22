import { describe, it, expect } from "vitest";
import {
  CheckpointError,
  RestoreSignal,
  AgencyCancelledError,
  isAbortError,
  makeAbortCause,
  readCause,
  type AbortCause,
} from "./errors.js";

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

  it("should carry a structured AbortCause when given one", () => {
    const cause = makeAbortCause({ kind: "userInterrupt" });
    const err = new AgencyCancelledError("esc", cause);
    expect(err.agencyCause).toBe(cause);
  });
});

describe("AbortCause / readCause", () => {
  const cases: AbortCause[] = [
    { kind: "userInterrupt" },
    { kind: "userKill", reason: "ts cancel" },
    { kind: "guardTrip", dimension: "time", limit: 20, spent: 21, guardId: "g1" },
    { kind: "guardTrip", dimension: "cost", limit: 2, spent: 3, guardId: "g2" },
    { kind: "raceLoser" },
    { kind: "cleanup" },
  ];

  it("round-trips every variant through an AbortSignal's reason", () => {
    for (const c of cases) {
      const controller = new AbortController();
      controller.abort(makeAbortCause(c));
      const read = readCause(controller.signal);
      expect(read?.kind).toBe(c.kind);
    }
  });

  it("round-trips every variant through AgencyCancelledError.agencyCause", () => {
    for (const c of cases) {
      const err = new AgencyCancelledError("x", makeAbortCause(c));
      const read = readCause(err);
      expect(read?.kind).toBe(c.kind);
    }
  });

  it("preserves guardTrip payload fields", () => {
    const controller = new AbortController();
    controller.abort(
      makeAbortCause({
        kind: "guardTrip",
        dimension: "time",
        limit: 20,
        spent: 21,
        guardId: "g7",
      }),
    );
    const read = readCause(controller.signal);
    expect(read).toMatchObject({
      kind: "guardTrip",
      dimension: "time",
      limit: 20,
      guardId: "g7",
    });
  });

  it("returns undefined when no structured cause is present", () => {
    // Bare string reason (the legacy shape) is not a structured cause.
    const controller = new AbortController();
    controller.abort("just a string");
    expect(readCause(controller.signal)).toBeUndefined();
    expect(readCause(new AgencyCancelledError("no cause"))).toBeUndefined();
    expect(readCause(new Error("plain"))).toBeUndefined();
    expect(readCause(null)).toBeUndefined();
  });

  it("a structured guardTrip cause is also recognized as an abort error when on AgencyCancelledError", () => {
    // The cause-carrying cancel must still pass isAbortError — this is
    // exactly why __tryCall checks the guardTrip cause BEFORE isAbortError.
    const err = new AgencyCancelledError(
      "sleep cancelled",
      makeAbortCause({
        kind: "guardTrip",
        dimension: "time",
        limit: 20,
        spent: 21,
        guardId: "g1",
      }),
    );
    expect(isAbortError(err)).toBe(true);
    expect(readCause(err)?.kind).toBe("guardTrip");
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
