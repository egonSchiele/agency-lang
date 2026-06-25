import { describe, it, expect } from "vitest";
import {
  CheckpointError,
  RestoreSignal,
  AgencyAbort,
  AgencyCancelledError,
  isAbortError,
  makeAbortCause,
  readCause,
  type AbortCause,
} from "./errors.js";
import { GuardExceededError, isGuardExceededError } from "./guard.js";

describe("AgencyAbort (unified abort base)", () => {
  it("carries a cause; isAbortError true; readCause returns it", () => {
    const cause = makeAbortCause({ kind: "userKill" });
    const e = new AgencyAbort("m", cause);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("AgencyAbort");
    expect(isAbortError(e)).toBe(true);
    expect(readCause(e)).toBe(cause);
  });

  it("AgencyCancelledError and GuardExceededError are AgencyAbort subclasses", () => {
    expect(new AgencyCancelledError()).toBeInstanceOf(AgencyAbort);
    // Pass an explicit guardId — in the owned-guard-id routing a real trip
    // always carries the tripped guard's id, so keep that contract visible.
    const g = new GuardExceededError("time", 20, 21, "g-test");
    expect(g).toBeInstanceOf(AgencyAbort);
    expect(isGuardExceededError(g)).toBe(true);
    expect(g.type).toBe("time");
    expect(g.limit).toBe(20);
    expect(g.spent).toBe(21);
    const cause = readCause(g);
    expect(cause?.kind).toBe("guardTrip");
    expect((cause as { guardId: string }).guardId).toBe("g-test");
  });

  it("default AgencyCancelledError cause is branded so readCause round-trips", () => {
    const a = new AgencyCancelledError();
    expect(readCause(a)).not.toBeUndefined();
    expect(readCause(a)?.kind).toBe("userKill");
    const b = new AgencyCancelledError("custom reason");
    expect(readCause(b)?.kind).toBe("userKill");
  });

  it("name-based fallback classifies a cross-realm abort but does NOT recover its cause", () => {
    // Simulate an error reconstructed across a module boundary (subprocess
    // resolver shim): right name, no prototype chain to AgencyAbort, no
    // branded cause payload. Identity survives; the cause does not.
    const crossRealm = Object.assign(new Error("simulated cross-realm abort"), {
      name: "AgencyAbort",
    });
    expect(isAbortError(crossRealm)).toBe(true);
    expect(readCause(crossRealm)).toBeUndefined();
  });

  it("name-fallback also recognizes a cross-realm GuardExceededError", () => {
    // A guard trip crossing the subprocess shim loses its prototype chain;
    // its name is still "GuardExceededError", so isAbortError must classify
    // it as an abort (else it would be converted to a normal Failure instead
    // of propagating as control flow).
    const crossRealm = Object.assign(new Error("simulated cross-realm trip"), {
      name: "GuardExceededError",
    });
    expect(isAbortError(crossRealm)).toBe(true);
  });
});

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
    // NOTE: `new AgencyCancelledError()` now carries a branded userKill cause
    // by default (see the "default … cause is branded" test above), so it is
    // intentionally NOT asserted here.
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

describe("LLM resilience causes", () => {
  it("round-trips callTimeout through readCause on an AgencyAbort", () => {
    const t = new AgencyAbort("t", makeAbortCause({ kind: "callTimeout", limitMs: 600000 }));
    expect(readCause(t)?.kind).toBe("callTimeout");
    expect((readCause(t) as { limitMs: number }).limitMs).toBe(600000);
    expect(isAbortError(t)).toBe(true);
  });
});
