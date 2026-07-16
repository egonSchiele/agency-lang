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
