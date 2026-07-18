import { describe, it, expect } from "vitest";
import { AbortedResult, isAborted, previewForLog } from "./abortedResult.js";
import {
  AgencyCancelledError,
  makeAbortCause,
  readCause,
  type AbortCause,
} from "./errors.js";
import { State, StateStack } from "./state/stateStack.js";
import { runInTestContext } from "./asyncContext.js";
import { ThreadStore } from "./state/threadStore.js";

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

/** Run fn inside an ALS frame whose ctx carries a stub statelog client,
 *  and return the events + span types it recorded. */
function withStubStatelog<T>(fn: () => T): {
  result: T;
  events: RecordedEvent[];
  spans: string[];
} {
  const events: RecordedEvent[] = [];
  const spans: string[] = [];
  const client = {
    startSpan(type: string): string {
      spans.push(type);
      return `span-${spans.length}`;
    },
    endSpan(): void {},
    abortSalvage(e: RecordedEvent): Promise<void> {
      events.push(e);
      return Promise.resolve();
    },
    error(e: RecordedEvent): Promise<void> {
      events.push(e);
      return Promise.resolve();
    },
  };
  const ctx = { statelogClient: client } as any;
  const result = runInTestContext(
    ctx,
    new StateStack(),
    new ThreadStore(),
    fn,
  );
  return { result, events, spans };
}

describe("AbortedResult.fromError (the frame-boundary conversion)", () => {
  it("carries the frame's saved draft as the partial", () => {
    const aborted = AbortedResult.fromError(
      abortError(),
      frameWithDraft("draft-v"),
      "code",
    );
    expect(aborted.partial).toEqual({ value: "draft-v" });
  });

  it("has no partial when the frame never saved one", () => {
    const aborted = AbortedResult.fromError(abortError(), new State(), "code");
    expect(aborted.partial).toBeUndefined();
  });

  it("keeps the cause object by identity, so the delivered flag still de-dups", () => {
    const cause = tripCause();
    const aborted = AbortedResult.fromError(
      abortError(cause),
      new State(),
      "code",
    );
    expect(aborted.cause).toBe(cause);
    const rebuilt = aborted.toError();
    expect(readCause(rebuilt)).toBe(cause);
  });

  it("emits a 'carried' event with previews and opens the unwind span", () => {
    const { result, events, spans } = withStubStatelog(() =>
      AbortedResult.fromError(
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
    const { events, spans } = withStubStatelog(() =>
      AbortedResult.fromError(abortError(), new State(), "quiet"),
    );
    expect(events).toHaveLength(0);
    expect(spans).toHaveLength(0);
  });

  it("works with no statelog client and no ALS frame at all", () => {
    const aborted = AbortedResult.fromError(
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
      abortError(),
      frameWithDraft("inner"),
      "verify",
    );
    const outer = inner.carryThrough(frameWithDraft("outer"), "code");
    expect(outer.partial).toEqual({ value: "outer" });
  });

  it("drops the callee's partial when the caller has no draft, and logs the loss", () => {
    const { result, events } = withStubStatelog(() => {
      const inner = AbortedResult.fromError(
        abortError(),
        frameWithDraft("inner"),
        "verify",
      );
      return inner.carryThrough(new State(), "code");
    });
    expect(result.partial).toBeUndefined();
    expect(events.map((e) => e.action)).toEqual(["carried", "erased"]);
    expect(events[1].partial).toBe('"inner"');
  });

  it("is silent on an empty-to-empty hop", () => {
    const { events } = withStubStatelog(() => {
      const inner = AbortedResult.fromError(abortError(), new State(), "verify");
      return inner.carryThrough(new State(), "code");
    });
    expect(events).toHaveLength(0);
  });

  it("does not mutate the original (every hop is a new instance)", () => {
    const inner = AbortedResult.fromError(
      abortError(),
      frameWithDraft("inner"),
      "verify",
    );
    inner.carryThrough(new State(), "code");
    expect(inner.partial).toEqual({ value: "inner" });
  });
});

describe("AbortedResult boundary drops", () => {
  it("droppedAtArgPosition removes the partial and logs it", () => {
    const { result, events } = withStubStatelog(() => {
      const aborted = AbortedResult.fromError(
        abortError(),
        frameWithDraft("g-partial"),
        "g",
      );
      return aborted.droppedAtArgPosition();
    });
    expect(result.partial).toBeUndefined();
    expect(result.cause.kind).toBe("guardTrip");
    expect(events.map((e) => e.action)).toEqual([
      "carried",
      "droppedAtArgPosition",
    ]);
  });

  it("atForkBoundary removes the partial and logs it", () => {
    const { result, events } = withStubStatelog(() => {
      const aborted = AbortedResult.fromError(
        abortError(),
        frameWithDraft("branch-partial"),
        "branch",
      );
      return aborted.atForkBoundary();
    });
    expect(result.partial).toBeUndefined();
    expect(events.map((e) => e.action)).toEqual(["carried", "clearedAtFork"]);
  });

  it("both are no-ops (same instance, no events) without a partial", () => {
    const { result, events } = withStubStatelog(() => {
      const aborted = AbortedResult.fromError(abortError(), new State(), "g");
      return [aborted, aborted.droppedAtArgPosition(), aborted.atForkBoundary()];
    });
    expect(result[1]).toBe(result[0]);
    expect(result[2]).toBe(result[0]);
    expect(events).toHaveLength(0);
  });
});

describe("AbortedResult.deliver (the guard salvaging)", () => {
  it("returns the partial and emits 'delivered'", () => {
    const { result, events } = withStubStatelog(() => {
      const aborted = AbortedResult.fromError(
        abortError(),
        frameWithDraft("save-me"),
        "block",
      );
      return aborted.deliver();
    });
    expect(result).toEqual({ value: "save-me" });
    expect(events.map((e) => e.action)).toEqual(["carried", "delivered"]);
  });

  it("returns undefined without a partial", () => {
    const aborted = AbortedResult.fromError(abortError(), new State(), "block");
    expect(aborted.deliver()).toBeUndefined();
  });
});

describe("isAborted", () => {
  it("recognizes only AbortedResult instances", () => {
    const aborted = AbortedResult.fromError(abortError(), new State(), "x");
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
    const aborted = AbortedResult.fromError(
      abortError(),
      frameWithDraft("d"),
      "code",
    );
    expect(aborted.partialValueOrNull()).toBe("d");
  });

  it("returns a saved null (a real partial)", () => {
    const aborted = AbortedResult.fromError(
      abortError(),
      frameWithDraft(null),
      "code",
    );
    expect(aborted.partialValueOrNull()).toBe(null);
  });

  it("returns null when there is no partial", () => {
    const aborted = AbortedResult.fromError(abortError(), new State(), "code");
    expect(aborted.partialValueOrNull()).toBe(null);
  });
});

describe("withFinalize passes the draft (finalize as draft)", () => {
  it("the finalize receives the partial this instance holds", async () => {
    const aborted = AbortedResult.fromError(
      abortError(),
      frameWithDraft("the-draft"),
      "code",
    );
    let received: unknown = "not-called";
    await aborted.withFinalize(async (draft) => {
      received = draft;
      return "finalized";
    }, "code");
    expect(received).toBe("the-draft");
  });

  it("no partial yields null, matching the binder's null case", async () => {
    const aborted = AbortedResult.fromError(abortError(), new State(), "code");
    let received: unknown = "not-called";
    await aborted.withFinalize(async (draft) => {
      received = draft;
      return "finalized";
    }, "code");
    expect(received).toBe(null);
  });

  it("a throwing finalize still returns `this` — the same draft is the fallback", async () => {
    const { result } = withStubStatelog(async () => {
      const aborted = AbortedResult.fromError(
        abortError(),
        frameWithDraft("the-draft"),
        "code",
      );
      const finalized = await aborted.withFinalize(async () => {
        throw new Error("boom");
      }, "code");
      return { aborted, finalized };
    });
    const { aborted, finalized } = await result;
    expect(finalized).toBe(aborted);
    expect(finalized.partialValueOrNull()).toBe("the-draft");
  });
});

describe("AbortedResult.withFinalize", () => {
  it("replaces the partial with the finalize's return, cause by identity", async () => {
    const cause = tripCause();
    const aborted = AbortedResult.fromError(
      abortError(cause),
      frameWithDraft("draft"),
      "code",
    );
    const finalized = await aborted.withFinalize(async () => "finalized", "code");
    expect(finalized.partialValueOrNull()).toBe("finalized");
    expect(finalized.cause).toBe(cause);
  });

  it("a finalize returning null is a real partial", async () => {
    const aborted = AbortedResult.fromError(
      abortError(),
      frameWithDraft("draft"),
      "code",
    );
    const finalized = await aborted.withFinalize(async () => null, "code");
    expect(finalized.partial).toEqual({ value: null });
  });

  it("falls back to the saved draft when the finalize throws, and logs", async () => {
    const { result, events } = withStubStatelog(async () => {
      const aborted = AbortedResult.fromError(
        abortError(),
        frameWithDraft("draft"),
        "code",
      );
      return aborted.withFinalize(async () => {
        throw new Error("boom");
      }, "code");
    });
    const finalized = await result;
    expect(finalized.partialValueOrNull()).toBe("draft");
    expect(events.some((e) => e.errorType === "finalizeError")).toBe(true);
  });

  it("with NO prior partial: a successful finalize becomes the partial", async () => {
    const aborted = AbortedResult.fromError(abortError(), new State(), "code");
    const finalized = await aborted.withFinalize(async () => "f", "code");
    expect(finalized.partialValueOrNull()).toBe("f");
  });

  it("with NO prior partial: a throwing finalize leaves no partial and does not crash", async () => {
    const aborted = AbortedResult.fromError(abortError(), new State(), "code");
    const finalized = await aborted.withFinalize(async () => {
      throw new Error("boom");
    }, "code");
    expect(finalized.partial).toBeUndefined();
    expect(finalized.partialValueOrNull()).toBe(null);
  });

  it("treats an interrupting finalize result as a failure (backstop)", async () => {
    const aborted = AbortedResult.fromError(
      abortError(),
      frameWithDraft("draft"),
      "code",
    );
    const fakeInterrupts = [
      { type: "interrupt", interruptId: "i1", effect: "std::x", message: "m" },
    ];
    const finalized = await aborted.withFinalize(async () => fakeInterrupts, "code");
    expect(finalized.partialValueOrNull()).toBe("draft");
  });

  it("treats an aborted finalize result as a failure (backstop)", async () => {
    const aborted = AbortedResult.fromError(
      abortError(),
      frameWithDraft("draft"),
      "code",
    );
    const nested = AbortedResult.fromError(abortError(), new State(), "inner");
    const finalized = await aborted.withFinalize(async () => nested, "code");
    expect(finalized.partialValueOrNull()).toBe("draft");
  });

  it("emits a carried event for the finalize's partial", async () => {
    const { result, events } = withStubStatelog(async () => {
      const aborted = AbortedResult.fromError(abortError(), new State(), "code");
      return aborted.withFinalize(async () => "f", "code");
    });
    await result;
    expect(events.map((e) => e.action)).toContain("carried");
  });
});

describe("AbortedResult.fromError marks a guard trip delivered", () => {
  it("sets the cause's delivered flag so later steps on the aborted signal run", () => {
    const cause = tripCause();
    expect(cause.kind === "guardTrip" && cause.delivered).toBeFalsy();
    AbortedResult.fromError(abortError(cause), new State(), "code");
    expect(cause.kind === "guardTrip" && cause.delivered).toBe(true);
  });
});
