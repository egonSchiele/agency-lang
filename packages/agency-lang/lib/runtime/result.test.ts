import { describe, it, expect } from "vitest";
import { success, failure, isSuccess, isFailure, __pipeBind, __tryCall } from "./result.js";
import {
  AgencyAbort,
  AgencyCancelledError,
  makeAbortCause,
  type AbortCause,
} from "./errors.js";

describe("__tryCall — guardTrip cause conversion (the CI-crash fix)", () => {
  it("converts a guardTrip-cause-carrying abort to a timeoutFailure (NOT a throw)", async () => {
    // This is the exact shape an aborted in-flight `sleep` rejects with
    // when a time guard trips. It MUST convert to a Failure here — even
    // though it is also an abort error — because the guardTrip check runs
    // BEFORE the blanket `isAbortError -> throw`.
    const cause = makeAbortCause({
      kind: "guardTrip",
      dimension: "time",
      limit: 20,
      spent: 21,
      guardId: "g1",
    });
    // The boundary OWNS guard g1, so it converts its own trip.
    const result = await __tryCall(
      () => {
        throw new AgencyCancelledError("sleep cancelled", cause);
      },
      { ownedGuardIds: ["g1"] },
    );
    expect(isFailure(result)).toBe(true);
    expect((result as { error: { type: string; maxTime: number } }).error).toMatchObject({
      type: "timeoutFailure",
      maxTime: 20,
    });
  });

  it("converts a cost guardTrip cause to a guardFailure", async () => {
    const cause = makeAbortCause({
      kind: "guardTrip",
      dimension: "cost",
      limit: 2,
      spent: 3,
      guardId: "g2",
    });
    const result = await __tryCall(
      () => {
        throw new AgencyCancelledError("cancelled", cause);
      },
      { ownedGuardIds: ["g2"] },
    );
    expect((result as { error: { type: string; maxCost: number } }).error).toMatchObject({
      type: "guardFailure",
      maxCost: 2,
    });
  });

  it("marks the cause `delivered` so the runner path won't re-deliver the same trip", async () => {
    const cause = makeAbortCause({
      kind: "guardTrip",
      dimension: "time",
      limit: 20,
      spent: 21,
      guardId: "g1",
    });
    await __tryCall(
      () => {
        throw new AgencyCancelledError("sleep cancelled", cause);
      },
      { ownedGuardIds: ["g1"] },
    );
    expect((cause as { delivered?: boolean }).delivered).toBe(true);
  });

  it("still RE-THROWS a non-guard abort (userInterrupt) — cancellation must propagate", async () => {
    const cause = makeAbortCause({ kind: "userInterrupt" });
    await expect(
      __tryCall(() => {
        throw new AgencyCancelledError("cancelled by user", cause);
      }),
    ).rejects.toBeInstanceOf(AgencyCancelledError);
  });

  it("still re-throws a bare abort with no cause", async () => {
    await expect(
      __tryCall(() => {
        throw new AgencyCancelledError("cancelled");
      }),
    ).rejects.toBeInstanceOf(AgencyCancelledError);
  });
});

describe("__tryCall — propagate-never-swallow lock-in (C2: ownedGuardIds)", () => {
  // CLAUDE.md safety invariant: an AgencyAbort must propagate untouched, never
  // be silently converted to a Failure — EXCEPT a guardTrip that THIS boundary
  // owns. With no ownedGuardIds (a plain `try`, or a boundary that owns a
  // DIFFERENT guard), EVERY abort — including a guardTrip — re-throws. This is
  // the smallest fully-deterministic test that catches a regression where the
  // single rung is inverted, removed, or moved below the conversion path.
  const reThrows = async (cause: AbortCause) => {
    await expect(
      __tryCall(() => {
        throw new AgencyAbort("abort", cause);
      }),
    ).rejects.toBeInstanceOf(AgencyAbort);
  };

  it("re-throws a userInterrupt abort", () =>
    reThrows(makeAbortCause({ kind: "userInterrupt" })));
  it("re-throws a userKill abort", () =>
    reThrows(makeAbortCause({ kind: "userKill" })));
  it("re-throws a raceLoser abort", () =>
    reThrows(makeAbortCause({ kind: "raceLoser" })));
  it("re-throws a cleanup abort", () =>
    reThrows(makeAbortCause({ kind: "cleanup" })));

  it("re-throws a guardTrip when no ownedGuardIds (a plain try must not swallow it)", () =>
    reThrows(
      makeAbortCause({
        kind: "guardTrip",
        dimension: "time",
        limit: 20,
        spent: 21,
        guardId: "g1",
      }),
    ));

  it("negative control: a non-AgencyAbort Error converts to a Failure", async () => {
    const result = await __tryCall(() => {
      throw new Error("plain boom");
    });
    expect(isFailure(result)).toBe(true);
  });
});

describe("__tryCall — ownedGuardIds routing (C2)", () => {
  const guardTrip = (guardId: string) =>
    makeAbortCause({ kind: "guardTrip", dimension: "time", limit: 20, spent: 21, guardId });

  it("converts a trip it OWNS (guardId in ownedGuardIds)", async () => {
    const result = await __tryCall(
      () => {
        throw new AgencyAbort("trip", guardTrip("g1"));
      },
      { ownedGuardIds: ["g1"] },
    );
    expect(isFailure(result)).toBe(true);
    expect((result as { error: { type: string } }).error.type).toBe("timeoutFailure");
  });

  it("re-throws an OUTER guard's trip (guardId not owned by this inner boundary)", async () => {
    await expect(
      __tryCall(
        () => {
          throw new AgencyAbort("trip", guardTrip("gOUTER"));
        },
        { ownedGuardIds: ["gINNER"] },
      ),
    ).rejects.toBeInstanceOf(AgencyAbort);
  });

  it("re-throws when ownedGuardIds is absent (plain try inside a guarded block)", async () => {
    await expect(
      __tryCall(() => {
        throw new AgencyAbort("trip", guardTrip("g1"));
      }),
    ).rejects.toBeInstanceOf(AgencyAbort);
  });
});

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
      skippedFunctions: [],
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
      skippedFunctions: [],
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
