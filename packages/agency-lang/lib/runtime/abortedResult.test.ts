import { describe, it, expect } from "vitest";
import { AbortedResult, isAborted, previewForLog, type AbortLog } from "./abortedResult.js";
import {
  AgencyCancelledError,
  CallDepthExceededError,
  makeAbortCause,
  readCause,
  type AbortCause,
} from "./errors.js";
import { State } from "./state/stateStack.js";

function tripCause(): AbortCause {
  return makeAbortCause({
    kind: "guardTrip",
    dimension: "cost",
    limit: 1,
    spent: 2,
    guardId: "g1",
  });
}

function abortError(cause = tripCause()): AgencyCancelledError {
  return new AgencyCancelledError("trip", cause);
}

function frameWithDraft(value: unknown): State {
  const frame = new State();
  frame.savedDraft = { value };
  return frame;
}

type RecordedEvent = Record<string, unknown>;

/** Run fn with a stub statelog client to hand to each hop, and return the
 *  events + span types it recorded. */
function withStubStatelog<T>(fn: (log: AbortLog) => T): {
  result: T;
  events: RecordedEvent[];
  spans: string[];
  endedSpans: string[];
} {
  const events: RecordedEvent[] = [];
  const spans: string[] = [];
  const endedSpans: string[] = [];
  const client = {
    startSpan(type: string): string {
      spans.push(type);
      return `span-${spans.length}`;
    },
    endSpan(id?: string): void {
      if (id !== undefined) endedSpans.push(id);
    },
    abortSalvage(e: RecordedEvent): Promise<void> {
      events.push(e);
      return Promise.resolve();
    },
    error(e: RecordedEvent): Promise<void> {
      events.push(e);
      return Promise.resolve();
    },
  };
  const result = fn(client as unknown as AbortLog);
  return { result, events, spans, endedSpans };
}

describe("AbortedResult.fromError (the frame-boundary conversion)", () => {
  it("carries the frame's saved draft as the partial", () => {
    const aborted = AbortedResult.fromError(
      undefined,
      abortError(),
      frameWithDraft("draft-v"),
      "code",
    );
    expect(aborted.partial).toEqual({ value: "draft-v" });
  });

  it("has no partial when the frame never saved one", () => {
    const aborted = AbortedResult.fromError(undefined, abortError(), new State(), "code");
    expect(aborted.partial).toBeUndefined();
  });

  it("keeps the cause object by identity, so the delivered flag still de-dups", () => {
    const cause = tripCause();
    const aborted = AbortedResult.fromError(undefined, abortError(cause), new State(), "code");
    expect(aborted.cause).toBe(cause);
    const rebuilt = aborted.toError();
    expect(readCause(rebuilt)).toBe(cause);
  });

  it("rebuilds the call-depth diagnostic after travelling up as a value", () => {
    // An abort loses its original Error object on the way up — only the cause
    // survives. The frames therefore ride the cause, so the message a user
    // finally sees names what recursed and how to raise the limit, instead of
    // the bare "Execution aborted (callDepthExceeded)" the kind alone gives.
    const original = new CallDepthExceededError(2048, 2049, ["main", "foo", "bar"]);
    const aborted = AbortedResult.fromError(undefined, original, new State(), "code");
    const rebuilt = aborted.toError();
    expect(rebuilt.message).toBe(original.message);
    expect(rebuilt.message).toContain("foo \u2192 bar");
    expect(rebuilt.message).toContain("2049 > 2048");
    expect(rebuilt.message).toContain("maxCallDepth");
  });

  it("emits a 'carried' event with previews and opens the unwind span", () => {
    const { result, events, spans } = withStubStatelog((log) =>
      AbortedResult.fromError(
        log,
        abortError(),
        (() => {
          const frame = frameWithDraft("draft-v");
          frame.args = { q: "question" };
          return frame;
        })(),
        "code",
      ),
    );
    expect(spans).toEqual(["abortUnwind"]);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("carried");
    expect(events[0].scopeName).toBe("code");
    expect(events[0].partial).toBe('"draft-v"');
    expect(events[0].functionArgs).toBe('{"q":"question"}');
    expect(result.unwindSpanId).toBe("span-1");
  });

  it("is silent and opens no span when there is no draft", () => {
    const { events, spans } = withStubStatelog((log) =>
      AbortedResult.fromError(log, abortError(), new State(), "quiet"),
    );
    expect(events).toHaveLength(0);
    expect(spans).toHaveLength(0);
  });

  it("works with no logger at all", () => {
    const aborted = AbortedResult.fromError(
      undefined,
      abortError(),
      frameWithDraft("draft-v"),
      "code",
    );
    expect(aborted.partial).toEqual({ value: "draft-v" });
  });
});

describe("AbortedResult.carryThrough (a caller stopping after its callee aborted)", () => {
  it("replaces the callee's partial with the caller's own draft", () => {
    const inner = AbortedResult.fromError(
      undefined,
      abortError(),
      frameWithDraft("inner"),
      "verify",
    );
    const outer = inner.carryThrough(undefined, frameWithDraft("outer"), "code");
    expect(outer.partial).toEqual({ value: "outer" });
  });

  it("drops the callee's partial when the caller has no draft, and logs the loss", () => {
    const { result, events } = withStubStatelog((log) => {
      const inner = AbortedResult.fromError(log, abortError(), frameWithDraft("inner"), "verify");
      return inner.carryThrough(log, new State(), "code");
    });
    expect(result.partial).toBeUndefined();
    expect(events.map((e) => e.action)).toEqual(["carried", "erased"]);
    expect(events[1].partial).toBe('"inner"');
  });

  it("is silent on an empty-to-empty hop", () => {
    const { events } = withStubStatelog((log) => {
      const inner = AbortedResult.fromError(log, abortError(), new State(), "verify");
      return inner.carryThrough(log, new State(), "code");
    });
    expect(events).toHaveLength(0);
  });

  it("does not mutate the original (every hop is a new instance)", () => {
    const inner = AbortedResult.fromError(
      undefined,
      abortError(),
      frameWithDraft("inner"),
      "verify",
    );
    inner.carryThrough(undefined, new State(), "code");
    expect(inner.partial).toEqual({ value: "inner" });
  });
});

describe("AbortedResult boundary drops", () => {
  it("droppedAtArgPosition removes the partial and logs it", () => {
    const { result, events } = withStubStatelog((log) => {
      const aborted = AbortedResult.fromError(log, abortError(), frameWithDraft("g-partial"), "g");
      return aborted.droppedAtArgPosition(log);
    });
    expect(result.partial).toBeUndefined();
    expect(result.cause.kind).toBe("guardTrip");
    expect(events.map((e) => e.action)).toEqual(["carried", "droppedAtArgPosition"]);
  });

  it("atForkBoundary removes the partial and logs it", () => {
    const { result, events } = withStubStatelog((log) => {
      const aborted = AbortedResult.fromError(
        log,
        abortError(),
        frameWithDraft("branch-partial"),
        "branch",
      );
      return aborted.atForkBoundary(log);
    });
    expect(result.partial).toBeUndefined();
    expect(events.map((e) => e.action)).toEqual(["carried", "clearedAtFork"]);
  });

  it("atNodeBoundary drops the partial and ends the unwind span", () => {
    // The run is over, so nothing above can consume the draft. Dropping it
    // through the same hop as the fork boundary is what leaves a record of
    // where it went and closes the abortUnwind span; throwing toError()
    // straight from the boundary would leave that span open forever.
    const { result, events, spans, endedSpans } = withStubStatelog((log) => {
      const aborted = AbortedResult.fromError(log, abortError(), frameWithDraft("draft"), "scope");
      return aborted.atNodeBoundary(log);
    });
    expect(result.partial).toBeUndefined();
    expect(events.map((e) => e.action)).toEqual(["carried", "droppedAtNodeBoundary"]);
    expect(spans).toEqual(["abortUnwind"]);
    expect(endedSpans).toEqual(["span-1"]);
  });

  it("keeps an erased hop's span open at argument position, where the abort travels on", () => {
    // "erased" opens the span while carrying no partial forward, so a span can
    // outlive the partial that started it. Argument position is not the end of
    // the abort's journey: closing the span here would make a later frame with
    // a draft of its own open a SECOND one, splitting the salvage trail.
    const { result, events, endedSpans } = withStubStatelog((log) => {
      const inner = AbortedResult.fromError(log, abortError(), frameWithDraft("inner"), "g");
      const erased = inner.carryThrough(log, new State(), "middle");
      return erased.droppedAtArgPosition(log);
    });
    expect(events.map((e) => e.action)).toEqual(["carried", "erased"]);
    expect(endedSpans).toEqual([]);
    expect(result.unwindSpanId).toBe("span-1");
  });

  it("closes that same span at the node boundary, where the abort stops", () => {
    const { events, endedSpans } = withStubStatelog((log) => {
      const inner = AbortedResult.fromError(log, abortError(), frameWithDraft("inner"), "g");
      const erased = inner.carryThrough(log, new State(), "middle");
      return erased.atNodeBoundary(log);
    });
    expect(events.map((e) => e.action)).toEqual(["carried", "erased", "droppedAtNodeBoundary"]);
    expect(endedSpans).toEqual(["span-1"]);
  });

  it("both are no-ops (same instance, no events) without a partial", () => {
    const { result, events } = withStubStatelog((log) => {
      const aborted = AbortedResult.fromError(log, abortError(), new State(), "g");
      return [aborted, aborted.droppedAtArgPosition(log), aborted.atForkBoundary(log)];
    });
    expect(result[1]).toBe(result[0]);
    expect(result[2]).toBe(result[0]);
    expect(events).toHaveLength(0);
  });
});

describe("AbortedResult.deliver (the guard salvaging)", () => {
  it("returns the partial and emits 'delivered'", () => {
    const { result, events } = withStubStatelog((log) => {
      const aborted = AbortedResult.fromError(
        log,
        abortError(),
        frameWithDraft("save-me"),
        "block",
      );
      return aborted.deliver(log);
    });
    expect(result).toEqual({ value: "save-me" });
    expect(events.map((e) => e.action)).toEqual(["carried", "delivered"]);
  });

  it("returns undefined without a partial", () => {
    const aborted = AbortedResult.fromError(undefined, abortError(), new State(), "block");
    expect(aborted.deliver(undefined)).toBeUndefined();
  });
});

describe("isAborted", () => {
  it("recognizes only AbortedResult instances", () => {
    const aborted = AbortedResult.fromError(undefined, abortError(), new State(), "x");
    expect(isAborted(aborted)).toBe(true);
    expect(isAborted({ __type: "abortedResult" })).toBe(false);
    expect(isAborted(null)).toBe(false);
    expect(isAborted("aborted")).toBe(false);
  });
});

describe("previewForLog", () => {
  it("truncates long values", () => {
    const preview = previewForLog("x".repeat(2000));
    expect(preview.length).toBeLessThan(600);
    expect(preview).toContain("…(truncated)");
  });

  it("stringifies unserializable values without throwing", () => {
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(previewForLog(cyclic)).toBe("[object Object]");
  });
});

describe("AbortedResult.partialValueOrNull", () => {
  it("returns the partial's value", () => {
    const aborted = AbortedResult.fromError(undefined, abortError(), frameWithDraft("d"), "code");
    expect(aborted.partialValueOrNull()).toBe("d");
  });

  it("returns a saved null (a real partial)", () => {
    const aborted = AbortedResult.fromError(undefined, abortError(), frameWithDraft(null), "code");
    expect(aborted.partialValueOrNull()).toBe(null);
  });

  it("returns null when there is no partial", () => {
    const aborted = AbortedResult.fromError(undefined, abortError(), new State(), "code");
    expect(aborted.partialValueOrNull()).toBe(null);
  });
});

describe("withFinalize passes the draft (finalize as draft)", () => {
  it("the finalize receives the partial this instance holds", async () => {
    const aborted = AbortedResult.fromError(
      undefined,
      abortError(),
      frameWithDraft("the-draft"),
      "code",
    );
    let received: unknown = "not-called";
    await aborted.withFinalize(
      undefined,
      async (draft) => {
        received = draft;
        return "finalized";
      },
      "code",
    );
    expect(received).toBe("the-draft");
  });

  it("no partial yields null, matching the binder's null case", async () => {
    const aborted = AbortedResult.fromError(undefined, abortError(), new State(), "code");
    let received: unknown = "not-called";
    await aborted.withFinalize(
      undefined,
      async (draft) => {
        received = draft;
        return "finalized";
      },
      "code",
    );
    expect(received).toBe(null);
  });

  it("a throwing finalize still returns `this` — the same draft is the fallback", async () => {
    const { result } = withStubStatelog(async (log) => {
      const aborted = AbortedResult.fromError(
        log,
        abortError(),
        frameWithDraft("the-draft"),
        "code",
      );
      const finalized = await aborted.withFinalize(
        log,
        async () => {
          throw new Error("boom");
        },
        "code",
      );
      return { aborted, finalized };
    });
    const { aborted, finalized } = await result;
    expect(finalized).toBe(aborted);
    expect(finalized.partialValueOrNull()).toBe("the-draft");
  });
});

describe("AbortedResult.withFinalize", () => {
  it("a finalize with no return keeps the saved draft", async () => {
    const aborted = AbortedResult.fromError(
      undefined,
      abortError(),
      frameWithDraft("draft"),
      "code",
    );
    const finalized = await aborted.withFinalize(
      undefined,
      async () => AbortedResult.FINALIZE_DID_NOT_RETURN,
      "code",
    );
    expect(finalized).toBe(aborted);
    expect(finalized.partialValueOrNull()).toBe("draft");
  });

  it("a finalize that returns a JS undefined still replaces the draft", async () => {
    const aborted = AbortedResult.fromError(
      undefined,
      abortError(),
      frameWithDraft("draft"),
      "code",
    );
    const finalized = await aborted.withFinalize(undefined, async () => undefined, "code");
    expect(finalized).not.toBe(aborted);
  });

  it("a finalize that returns null replaces the draft with null", async () => {
    const aborted = AbortedResult.fromError(
      undefined,
      abortError(),
      frameWithDraft("draft"),
      "code",
    );
    const finalized = await aborted.withFinalize(undefined, async () => null, "code");
    expect(finalized).not.toBe(aborted);
    expect(finalized.partialValueOrNull()).toBe(null);
  });

  it("replaces the partial with the finalize's return, cause by identity", async () => {
    const cause = tripCause();
    const aborted = AbortedResult.fromError(
      undefined,
      abortError(cause),
      frameWithDraft("draft"),
      "code",
    );
    const finalized = await aborted.withFinalize(undefined, async () => "finalized", "code");
    expect(finalized.partialValueOrNull()).toBe("finalized");
    expect(finalized.cause).toBe(cause);
  });

  it("a finalize returning null is a real partial", async () => {
    const aborted = AbortedResult.fromError(
      undefined,
      abortError(),
      frameWithDraft("draft"),
      "code",
    );
    const finalized = await aborted.withFinalize(undefined, async () => null, "code");
    expect(finalized.partial).toEqual({ value: null });
  });

  it("falls back to the saved draft when the finalize throws, and logs", async () => {
    const { result, events } = withStubStatelog(async (log) => {
      const aborted = AbortedResult.fromError(log, abortError(), frameWithDraft("draft"), "code");
      return aborted.withFinalize(
        log,
        async () => {
          throw new Error("boom");
        },
        "code",
      );
    });
    const finalized = await result;
    expect(finalized.partialValueOrNull()).toBe("draft");
    expect(events.some((e) => e.errorType === "finalizeError")).toBe(true);
  });

  it("with NO prior partial: a successful finalize becomes the partial", async () => {
    const aborted = AbortedResult.fromError(undefined, abortError(), new State(), "code");
    const finalized = await aborted.withFinalize(undefined, async () => "f", "code");
    expect(finalized.partialValueOrNull()).toBe("f");
  });

  it("with NO prior partial: a throwing finalize leaves no partial and does not crash", async () => {
    const aborted = AbortedResult.fromError(undefined, abortError(), new State(), "code");
    const finalized = await aborted.withFinalize(
      undefined,
      async () => {
        throw new Error("boom");
      },
      "code",
    );
    expect(finalized.partial).toBeUndefined();
    expect(finalized.partialValueOrNull()).toBe(null);
  });

  it("treats an interrupting finalize result as a failure (backstop)", async () => {
    const aborted = AbortedResult.fromError(
      undefined,
      abortError(),
      frameWithDraft("draft"),
      "code",
    );
    const fakeInterrupts = [
      { type: "interrupt", interruptId: "i1", effect: "std::x", message: "m" },
    ];
    const finalized = await aborted.withFinalize(undefined, async () => fakeInterrupts, "code");
    expect(finalized.partialValueOrNull()).toBe("draft");
  });

  it("treats an aborted finalize result as a failure (backstop)", async () => {
    const aborted = AbortedResult.fromError(
      undefined,
      abortError(),
      frameWithDraft("draft"),
      "code",
    );
    const nested = AbortedResult.fromError(undefined, abortError(), new State(), "inner");
    const finalized = await aborted.withFinalize(undefined, async () => nested, "code");
    expect(finalized.partialValueOrNull()).toBe("draft");
  });

  it("emits a carried event for the finalize's partial", async () => {
    const { result, events } = withStubStatelog(async (log) => {
      const aborted = AbortedResult.fromError(log, abortError(), new State(), "code");
      return aborted.withFinalize(log, async () => "f", "code");
    });
    await result;
    expect(events.map((e) => e.action)).toContain("carried");
  });
});

describe("AbortedResult.fromError marks a guard trip delivered", () => {
  it("sets the cause's delivered flag so later steps on the aborted signal run", () => {
    const cause = tripCause();
    expect(cause.kind === "guardTrip" && cause.delivered).toBeFalsy();
    AbortedResult.fromError(undefined, abortError(cause), new State(), "code");
    expect(cause.kind === "guardTrip" && cause.delivered).toBe(true);
  });
});
