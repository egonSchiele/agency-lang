import { describe, it, expect } from "vitest";
import {
  __stampCarriedDraft,
  __markReturnCarry,
  previewForLog,
} from "./carriedDraft.js";
import { AgencyAbort, makeAbortCause } from "./errors.js";
import { State } from "./state/stateStack.js";

function makeAbort(): AgencyAbort {
  return new AgencyAbort(
    "trip",
    makeAbortCause({
      kind: "guardTrip",
      dimension: "cost",
      limit: 1,
      spent: 2,
      guardId: "g1",
    }),
  );
}

type RecordedEvent = Record<string, unknown>;

function makeStubClient() {
  const events: RecordedEvent[] = [];
  const spans: string[] = [];
  return {
    events,
    spans,
    client: {
      startSpan(type: string): string {
        spans.push(type);
        return `span-${spans.length}`;
      },
      endSpan(_id?: string): void {},
      abortSalvage(e: RecordedEvent): Promise<void> {
        events.push(e);
        return Promise.resolve();
      },
    },
  };
}

function ctxWith(client: unknown): any {
  return { statelogClient: client };
}

describe("__stampCarriedDraft (the level rule)", () => {
  it("stamps the frame's savedDraft and emits 'carried'", () => {
    const abort = makeAbort();
    const frame = new State({ args: { q: "question" } });
    frame.savedDraft = { value: "draft-v" };
    const stub = makeStubClient();

    __stampCarriedDraft(abort, frame, "code", ctxWith(stub.client));

    expect(abort.carriedDraft).toEqual({ value: "draft-v" });
    expect(stub.spans).toEqual(["abortUnwind"]);
    expect(stub.events).toHaveLength(1);
    expect(stub.events[0].action).toBe("carried");
    expect(stub.events[0].scopeName).toBe("code");
    expect(stub.events[0].partial).toBe('"draft-v"');
    expect(stub.events[0].functionArgs).toBe('{"q":"question"}');
  });

  it("erases a prior carried draft and emits 'erased' with the dead value", () => {
    const abort = makeAbort();
    abort.carriedDraft = { value: "inner-partial" };
    const frame = new State();
    const stub = makeStubClient();

    __stampCarriedDraft(abort, frame, "code", ctxWith(stub.client));

    expect(abort.carriedDraft).toBeUndefined();
    expect(stub.events[0].action).toBe("erased");
    expect(stub.events[0].partial).toBe('"inner-partial"');
  });

  it("finalizeResult wins over a saved draft", () => {
    const abort = makeAbort();
    const frame = new State();
    frame.savedDraft = { value: "draft" };
    const stub = makeStubClient();

    __stampCarriedDraft(abort, frame, "code", ctxWith(stub.client), {
      value: "finalized",
    });

    expect(abort.carriedDraft).toEqual({ value: "finalized" });
    expect(stub.events[0].action).toBe("carried");
  });

  it("a marked abort with no draft passes through and emits 'passedThrough'", () => {
    const abort = makeAbort();
    abort.carriedDraft = { value: "callee-partial" };
    __markReturnCarry(abort);
    const frame = new State();
    const stub = makeStubClient();

    __stampCarriedDraft(abort, frame, "code", ctxWith(stub.client));

    expect(abort.carriedDraft).toEqual({ value: "callee-partial" });
    expect(abort.returnCarry).toBe(false);
    expect(stub.events[0].action).toBe("passedThrough");
  });

  it("the frame's own draft beats pass-through", () => {
    const abort = makeAbort();
    abort.carriedDraft = { value: "callee-partial" };
    __markReturnCarry(abort);
    const frame = new State();
    frame.savedDraft = { value: "own-draft" };
    const stub = makeStubClient();

    __stampCarriedDraft(abort, frame, "code", ctxWith(stub.client));

    expect(abort.carriedDraft).toEqual({ value: "own-draft" });
    expect(stub.events[0].action).toBe("carried");
  });

  it("consumes the returnCarry flag even when unused, so it cannot skip a level", () => {
    const abort = makeAbort();
    abort.carriedDraft = { value: "callee-partial" };
    __markReturnCarry(abort);
    const stub = makeStubClient();

    // First rung: has its own draft — pass-through unused, flag consumed.
    const withDraft = new State();
    withDraft.savedDraft = { value: "level-1" };
    __stampCarriedDraft(abort, withDraft, "one", ctxWith(stub.client));
    expect(abort.carriedDraft).toEqual({ value: "level-1" });

    // Second rung: no draft, no fresh mark — erases.
    __stampCarriedDraft(abort, new State(), "two", ctxWith(stub.client));
    expect(abort.carriedDraft).toBeUndefined();
    expect(stub.events.map((e) => e.action)).toEqual(["carried", "erased"]);
  });

  it("is silent and opens no span on an empty-to-empty transition", () => {
    const abort = makeAbort();
    const stub = makeStubClient();

    __stampCarriedDraft(abort, new State(), "quiet", ctxWith(stub.client));

    expect(abort.carriedDraft).toBeUndefined();
    expect(abort.unwindSpanId).toBeUndefined();
    expect(stub.spans).toHaveLength(0);
    expect(stub.events).toHaveLength(0);
  });

  it("leaves non-abort errors untouched and silent", () => {
    const err = new Error("boom") as Error & { carriedDraft?: unknown };
    const frame = new State();
    frame.savedDraft = { value: "draft" };
    const stub = makeStubClient();

    __stampCarriedDraft(err, frame, "code", ctxWith(stub.client));

    expect(err.carriedDraft).toBeUndefined();
    expect(stub.events).toHaveLength(0);
  });

  it("does not crash without a statelog client, and still stamps", () => {
    const abort = makeAbort();
    const frame = new State();
    frame.savedDraft = { value: "draft" };

    __stampCarriedDraft(abort, frame, "code", ctxWith(undefined));

    expect(abort.carriedDraft).toEqual({ value: "draft" });
  });

  it("truncates the statelog preview but carries the FULL value", () => {
    const abort = makeAbort();
    const frame = new State();
    const big = "x".repeat(2000);
    frame.savedDraft = { value: big };
    const stub = makeStubClient();

    __stampCarriedDraft(abort, frame, "code", ctxWith(stub.client));

    expect((abort.carriedDraft as { value: string }).value).toHaveLength(2000);
    expect((stub.events[0].partial as string).length).toBeLessThan(600);
    expect(stub.events[0].partial).toContain("…(truncated)");
  });
});

describe("previewForLog", () => {
  it("stringifies unserializable values without throwing", () => {
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(previewForLog(cyclic)).toBe("[object Object]");
  });
});
