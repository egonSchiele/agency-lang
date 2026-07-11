import { describe, it, expect, vi, afterEach } from "vitest";
import {
  interrupt,
  hasInterrupts,
  reportUnhandledInterrupts,
  mergeChainOutcomes,
  interruptWithHandlers,
  gatherChainOutcome,
} from "./interrupts.js";
import { RuntimeContext } from "./state/context.js";

describe("interruptWithHandlers resolvedBy attribution (IPC mode)", () => {
  const originalSend = process.send;
  const originalIpc = process.env.AGENCY_IPC;

  afterEach(() => {
    process.send = originalSend;
    if (originalIpc === undefined) delete process.env.AGENCY_IPC;
    else process.env.AGENCY_IPC = originalIpc;
    vi.restoreAllMocks();
  });

  const makeCtx = (handlers: any[]): RuntimeContext<any> => {
    const ctx = new RuntimeContext({
      statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
      smoltalkDefaults: {},
      dirname: process.cwd(),
    });
    ctx.handlers = handlers;
    return ctx;
  };

  /** Wire process.send to reply to the interrupt consult with the given
   * parent chain outcome. */
  const parentReplies = (outcome: any) => {
    process.send = vi.fn((msg: any) => {
      if (msg.type === "interrupt") {
        setImmediate(() => {
          process.emit("message" as any, {
            type: "decision",
            interruptId: msg.interruptId,
            outcome,
          } as any);
        });
      }
      return true;
    }) as any;
  };

  it("a verdict settled purely by local handlers is resolvedBy handler", async () => {
    process.env.AGENCY_IPC = "1";
    parentReplies({ kind: "noResponse" });
    const ctx = makeCtx([async () => ({ type: "approve", value: "ok" })]);
    const resolved = vi.spyOn(ctx.statelogClient, "interruptResolved");

    const verdict = await interruptWithHandlers("std::bash", "m", {}, "o", ctx);
    expect(verdict).toEqual({ type: "approve", value: "ok" });
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "approved", resolvedBy: "handler" }),
    );
  });

  it("a verdict the parent participated in is resolvedBy ipc", async () => {
    process.env.AGENCY_IPC = "1";
    parentReplies({ kind: "approved", value: "parent-ok" });
    const ctx = makeCtx([]);
    const resolved = vi.spyOn(ctx.statelogClient, "interruptResolved");

    const verdict = await interruptWithHandlers("std::bash", "m", {}, "o", ctx);
    expect(verdict).toEqual({ type: "approve", value: "parent-ok" });
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "approved", resolvedBy: "ipc" }),
    );
  });

  it("a local reject emits exactly ONE terminal event and never consults the parent", async () => {
    process.env.AGENCY_IPC = "1";
    const send = vi.fn(() => true);
    process.send = send as any;
    const ctx = makeCtx([async () => ({ type: "reject", value: "no" })]);
    const resolved = vi.spyOn(ctx.statelogClient, "interruptResolved");

    const verdict = await interruptWithHandlers("std::bash", "m", {}, "o", ctx);
    expect(verdict).toEqual({ type: "reject", value: "no" });
    expect(send).not.toHaveBeenCalled();
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "rejected", resolvedBy: "handler" }),
    );
  });

  it("a relay hop (gatherChainOutcome) emits NO terminal event on reject", async () => {
    // The parent process evaluating a child's relayed interrupt: only
    // handlerDecision events belong to the hop — the terminal
    // interruptResolved is emitted once, at the origin.
    const ctx = makeCtx([async () => ({ type: "reject", value: "no" })]);
    const resolved = vi.spyOn(ctx.statelogClient, "interruptResolved");

    const { outcome } = await gatherChainOutcome(
      { effect: "std::bash", message: "m", data: {}, origin: "o" },
      ctx,
      undefined,
      "child-intr-1",
    );
    expect(outcome).toEqual({ kind: "rejected", value: "no" });
    expect(resolved).not.toHaveBeenCalled();
  });
});

describe("interruptWithHandlers expectsValue", () => {
  const makeCtx = (handlers: any[]): RuntimeContext<any> => {
    const ctx = new RuntimeContext({
      statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
      smoltalkDefaults: {},
      dirname: process.cwd(),
    });
    ctx.handlers = handlers;
    // The surfaced path stamps the run id onto the Interrupt (renderVerdict →
    // ctx.getRunId()), which a real run sets when the exec context is created.
    ctx.runId = "test-run";
    return ctx;
  };

  it("a surfaced assignment-position interrupt carries expectsValue", async () => {
    const verdict = await interruptWithHandlers(
      "unknown", "Question for user", {}, "o", makeCtx([]), undefined,
      { expectsValue: true },
    );
    expect(Array.isArray(verdict)).toBe(true);
    expect((verdict as any)[0].expectsValue).toBe(true);
  });

  it("a statement-position interrupt does NOT carry expectsValue", async () => {
    const verdict = await interruptWithHandlers(
      "std::error", "m", {}, "o", makeCtx([]),
    );
    expect(Array.isArray(verdict)).toBe(true);
    expect((verdict as any)[0].expectsValue).toBeUndefined();
  });

  it("handlers see expectsValue on the interrupt they are deciding", async () => {
    const seen: any[] = [];
    const ctx = makeCtx([
      async (intr: any) => {
        seen.push(intr.expectsValue);
        return { type: "approve", value: "Adit" };
      },
    ]);
    const verdict = await interruptWithHandlers(
      "unknown", "Question for user", {}, "o", ctx, undefined,
      { expectsValue: true },
    );
    expect(verdict).toEqual({ type: "approve", value: "Adit" });
    expect(seen).toEqual([true]);
  });
});

describe("mergeChainOutcomes", () => {
  const approvedA = { kind: "approved", value: "a" } as const;
  const approvedB = { kind: "approved", value: "b" } as const;
  const approvedNoValue = { kind: "approved", value: undefined } as const;
  const rejected = { kind: "rejected", value: "no" } as const;
  const propagated = { kind: "propagated" } as const;
  const silent = { kind: "noResponse" } as const;

  it("outer reject wins over inner approve", () => {
    expect(mergeChainOutcomes(approvedA, rejected)).toEqual(rejected);
  });

  it("inner reject wins regardless of outer", () => {
    expect(mergeChainOutcomes(rejected, approvedA)).toEqual(rejected);
  });

  it("any propagate beats approve", () => {
    expect(mergeChainOutcomes(propagated, approvedA)).toEqual(propagated);
    expect(mergeChainOutcomes(approvedA, propagated)).toEqual(propagated);
  });

  it("inner approve + outer silence = approve (the regression fix)", () => {
    expect(mergeChainOutcomes(approvedA, silent)).toEqual(approvedA);
  });

  it("outer approved value wins; falls back to inner value", () => {
    expect(mergeChainOutcomes(approvedA, approvedB)).toEqual(approvedB);
    expect(mergeChainOutcomes(approvedA, approvedNoValue)).toEqual({
      kind: "approved",
      value: "a",
    });
  });

  it("total silence stays noResponse for the caller to map to propagate", () => {
    expect(mergeChainOutcomes(silent, silent)).toEqual(silent);
  });
});

describe("hasInterrupts", () => {
  it("returns true for an array of interrupts", () => {
    const interrupts = [
      interrupt({ effect: "unknown", message: "test1", data: {}, origin: "", runId: "run1" }),
      interrupt({ effect: "unknown", message: "test2", data: {}, origin: "", runId: "run1" }),
    ];
    expect(hasInterrupts(interrupts)).toBe(true);
  });

  it("returns true for a single-element array", () => {
    expect(hasInterrupts([interrupt({ effect: "unknown", message: "test", data: {}, origin: "", runId: "run1" })])).toBe(true);
  });

  it("returns false for null/undefined", () => {
    expect(hasInterrupts(null)).toBe(false);
    expect(hasInterrupts(undefined)).toBe(false);
  });

  it("returns false for a non-array", () => {
    expect(hasInterrupts("hello")).toBe(false);
    expect(hasInterrupts({ type: "interrupt" })).toBe(false);
  });

  it("returns false for an empty array", () => {
    expect(hasInterrupts([])).toBe(false);
  });

  it("returns false for an array of non-interrupts", () => {
    expect(hasInterrupts([1, 2, 3])).toBe(false);
  });
});

describe("reportUnhandledInterrupts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when the result has no interrupts", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    reportUnhandledInterrupts({ messages: {} as any, data: "the answer" });

    expect(err).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("prints a helpful message and exits non-zero for an unhandled interrupt", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    reportUnhandledInterrupts({
      messages: {} as any,
      data: [
        interrupt({
          effect: "std::edit",
          message: "edit the file",
          data: { path: "a.ts" },
          origin: "./foo.agency",
          runId: "run1",
        }),
      ],
    });

    expect(exit).toHaveBeenCalledWith(1);
    const printed = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toContain('Interrupt "std::edit" was not handled');
    expect(printed).toContain("edit the file");
    expect(printed).toContain('"path":"a.ts"');
    expect(printed).toContain("wrapping them in a handler");
    expect(printed).toContain("https://agency-lang.com/guide/handlers.html");
  });

  it("reports every interrupt when several are unhandled", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    reportUnhandledInterrupts({
      messages: {} as any,
      data: [
        interrupt({ effect: "std::read", message: "read", data: {}, origin: "", runId: "r" }),
        interrupt({ effect: "std::edit", message: "edit", data: {}, origin: "", runId: "r" }),
      ],
    });

    const printed = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toContain('Interrupt "std::read" was not handled');
    expect(printed).toContain('Interrupt "std::edit" was not handled');
  });
});
