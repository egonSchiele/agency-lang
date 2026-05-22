import { describe, it, expect, vi } from "vitest";
import { AgencyFunction } from "./agencyFunction.js";
import { AgencyCancelledError, RestoreSignal } from "./errors.js";
import { callHook, callHookAndDrop } from "./hooks.js";
import { State, StateStack } from "./state/stateStack.js";

// Minimal fake context shape. Only the fields callHook touches.
function fakeCtx(): any {
  return {
    topLevelCallbacks: [],
    callbacks: {},
    stateStack: { collectScopedCallbacks: () => [] },
  };
}

// Build an AgencyFunction stub whose `.invoke(...)` returns the given value.
function fakeAgencyFn(invokeResult: any): AgencyFunction {
  const fn = {
    name: "fake-cb",
    invoke: vi.fn(async () => invokeResult),
  } as unknown as AgencyFunction;
  (fn as any).__agencyFunction = true;
  return fn;
}

function ctxWithStack(
  stack: State[],
  tsCallbacks: any = {},
  topLevelCallbacks: Array<{ name: string; fn: any }> = [],
): any {
  const stateStack = new StateStack();
  stateStack.stack = stack;
  return { stateStack, callbacks: tsCallbacks, topLevelCallbacks };
}

describe("callHook (rewritten)", () => {
  it("fires scoped callbacks innermost → outermost", async () => {
    const calls: string[] = [];
    const outer = new State();
    outer.scopedCallbacks = [
      { name: "onNodeStart", fn: () => { calls.push("outer"); } },
    ];
    const inner = new State();
    inner.scopedCallbacks = [
      { name: "onNodeStart", fn: () => { calls.push("inner"); } },
    ];
    const ctx = ctxWithStack([outer, inner]);
    await callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    expect(calls).toEqual(["inner", "outer"]);
  });

  it("fires TS-passed callback last", async () => {
    const calls: string[] = [];
    const inner = new State();
    inner.scopedCallbacks = [
      { name: "onNodeStart", fn: () => { calls.push("scoped"); } },
    ];
    const ctx = ctxWithStack([inner], { onNodeStart: () => { calls.push("ts"); } });
    await callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    expect(calls).toEqual(["scoped", "ts"]);
  });

  it("ignores callback return values (no message override)", async () => {
    const inner = new State();
    inner.scopedCallbacks = [
      { name: "onLLMCallEnd", fn: () => ["overridden"] },
    ];
    const ctx = ctxWithStack([inner]);
    const result = await callHook({
      ctx,
      name: "onLLMCallEnd",
      data: {},
    } as any);
    expect(result).toBeUndefined();
  });

  it("catches and logs ordinary errors, continues firing others", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const inner = new State();
    inner.scopedCallbacks = [
      { name: "onNodeStart", fn: () => { throw new Error("boom"); } },
      { name: "onNodeStart", fn: () => { calls.push("after"); } },
    ];
    const ctx = ctxWithStack([inner]);
    await callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    expect(calls).toEqual(["after"]);
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("rethrows RestoreSignal control-flow errors", async () => {
    const signal = new RestoreSignal({ id: 1 } as any);
    const inner = new State();
    inner.scopedCallbacks = [
      { name: "onNodeStart", fn: () => { throw signal; } },
    ];
    const ctx = ctxWithStack([inner]);
    await expect(
      callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any),
    ).rejects.toBe(signal);
  });

  it("rethrows AgencyCancelledError", async () => {
    const cancelled = new AgencyCancelledError("user cancelled");
    const inner = new State();
    inner.scopedCallbacks = [
      { name: "onNodeStart", fn: () => { throw cancelled; } },
    ];
    const ctx = ctxWithStack([inner]);
    await expect(
      callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any),
    ).rejects.toBe(cancelled);
  });

  it("TS-passed onLLMCallStart return value is discarded (message override removed)", async () => {
    const ctx = ctxWithStack(
      [new State()],
      { onLLMCallStart: () => [{ role: "system", content: "OVERRIDE" }] as any },
    );
    const result = await callHook({
      ctx,
      name: "onLLMCallStart",
      data: { messages: [{ role: "user", content: "original" }] },
    } as any);
    expect(result).toBeUndefined();
  });

  it("fires scoped → top-level → TS-passed (in that order)", async () => {
    const calls: string[] = [];
    const inner = new State();
    inner.scopedCallbacks = [
      { name: "onNodeStart", fn: () => { calls.push("scoped"); } },
    ];
    const ctx = ctxWithStack(
      [inner],
      { onNodeStart: () => { calls.push("ts"); } },
      [{ name: "onNodeStart", fn: () => { calls.push("topLevel"); } }],
    );
    await callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    expect(calls).toEqual(["scoped", "topLevel", "ts"]);
  });

  it("filters topLevelCallbacks by name", async () => {
    const calls: string[] = [];
    const ctx = ctxWithStack(
      [new State()],
      {},
      [
        { name: "onNodeStart", fn: () => { calls.push("matching"); } },
        { name: "onNodeEnd", fn: () => { calls.push("other"); } },
      ],
    );
    await callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    expect(calls).toEqual(["matching"]);
  });

  it("multiple distinct callbacks for the same event all fire in order", async () => {
    const calls: string[] = [];
    const frame = new State();
    frame.addScopedCallback("onNodeStart", () => { calls.push("a"); });
    frame.addScopedCallback("onNodeStart", () => { calls.push("b"); });
    frame.addScopedCallback("onNodeStart", () => { calls.push("c"); });
    const ctx = ctxWithStack([frame]);
    await callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("returns the Interrupt[] when a callback halts with an unhandled interrupt", async () => {
    // After Phase 0, callHook no longer logs and drops on unhandled
    // interrupts — it returns the Interrupt[] so the caller can decide
    // what to do (callHookAndDrop logs; future codegen sites will
    // checkpoint + propagate).
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const fakeInterrupt = { type: "interrupt", kind: "myapp::oops", message: "x" };
    const callbackFn = AgencyFunction.create(
      {
        name: "__bad_cb",
        module: "test",
        fn: async () => [fakeInterrupt],
        params: [{ name: "data", hasDefault: false, defaultValue: undefined, variadic: false }],
        toolDefinition: null,
      },
      {},
    );
    const inner = new State();
    inner.scopedCallbacks = [{ name: "onNodeStart", fn: callbackFn }];
    const ctx = ctxWithStack([inner]);
    const out = await callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    expect(out).toEqual([fakeInterrupt]);
    // callHook itself no longer logs the unhandled interrupt — that
    // responsibility moves to callHookAndDrop.
    expect(consoleErr).not.toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("per-instance recursion guard skips re-entry of the same fn", async () => {
    let depth = 0;
    let maxDepth = 0;
    const ctxHolder: { ctx: any } = { ctx: undefined };
    const fn = async (data: any) => {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      if (depth < 5) {
        await callHook({ ctx: ctxHolder.ctx, name: "onNodeStart", data } as any);
      }
      depth--;
    };
    const inner = new State();
    inner.scopedCallbacks = [{ name: "onNodeStart", fn }];
    ctxHolder.ctx = ctxWithStack([inner]);
    await callHook({ ctx: ctxHolder.ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    expect(maxDepth).toBe(1);
  });
});

describe("invokeCallback / fireWithGuard interrupt return", () => {
  it("returns the interrupt array when an AgencyFunction callback halts with interrupts", async () => {
    const ctx = fakeCtx();
    const intr = { type: "interrupt", kind: "myapp::test", message: "hi", data: null, origin: "x", interruptId: "i-1" };
    const cb = fakeAgencyFn([intr]);
    ctx.topLevelCallbacks = [{ name: "onNodeStart", fn: cb }];

    const out = await callHook({ ctx, name: "onNodeStart", data: { nodeName: "n" } });
    expect(out).toEqual([intr]);
  });

  it("collects interrupts from every callback even when earlier ones halt", async () => {
    const ctx = fakeCtx();
    const intrA = { type: "interrupt", kind: "a::k", message: "A", data: null, origin: "x", interruptId: "i-a" };
    const intrB = { type: "interrupt", kind: "b::k", message: "B", data: null, origin: "x", interruptId: "i-b" };
    const cbA = fakeAgencyFn([intrA]);
    const cbB = fakeAgencyFn([intrB]);
    ctx.topLevelCallbacks = [
      { name: "onNodeStart", fn: cbA },
      { name: "onNodeStart", fn: cbB },
    ];

    const out = await callHook({ ctx, name: "onNodeStart", data: { nodeName: "n" } });
    expect(out).toEqual([intrA, intrB]);
    // Both callbacks must have been invoked — an interrupt in A must not
    // short-circuit B. This is the concurrent-batching invariant that
    // mirrors runForkAll: every sibling runs to completion, all halts
    // are batched together.
    expect((cbA as any).invoke).toHaveBeenCalledTimes(1);
    expect((cbB as any).invoke).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when no callback halts", async () => {
    const ctx = fakeCtx();
    ctx.topLevelCallbacks = [{ name: "onNodeStart", fn: fakeAgencyFn(undefined) }];
    const out = await callHook({ ctx, name: "onNodeStart", data: { nodeName: "n" } });
    expect(out).toBeUndefined();
  });

  it("real JS errors in a callback do NOT appear in the returned interrupts", async () => {
    const ctx = fakeCtx();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cbCrash = {
      invoke: vi.fn(async () => { throw new Error("boom"); }),
    } as unknown as AgencyFunction;
    (cbCrash as any).__agencyFunction = true;
    ctx.topLevelCallbacks = [{ name: "onNodeStart", fn: cbCrash }];
    const out = await callHook({ ctx, name: "onNodeStart", data: { nodeName: "n" } });
    expect(out).toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("callHookAndDrop", () => {
  it("returns void and logs to console.error when interrupts come back", async () => {
    const ctx = fakeCtx();
    const intr = { type: "interrupt", kind: "x::y", message: "", data: null, origin: "x", interruptId: "i-1" };
    ctx.topLevelCallbacks = [{ name: "onNodeStart", fn: fakeAgencyFn([intr]) }];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out: void = await callHookAndDrop({ ctx, name: "onNodeStart", data: { nodeName: "n" } });
    expect(out).toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[agency] onNodeStart callback raised an unhandled interrupt"),
      expect.anything(),
    );
    errSpy.mockRestore();
  });

  it("returns void with no logging when no interrupts are raised", async () => {
    const ctx = fakeCtx();
    ctx.topLevelCallbacks = [{ name: "onNodeStart", fn: fakeAgencyFn(undefined) }];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await callHookAndDrop({ ctx, name: "onNodeStart", data: { nodeName: "n" } });
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
