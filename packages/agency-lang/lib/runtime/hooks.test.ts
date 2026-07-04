import { describe, it, expect, vi, afterEach } from "vitest";
import { AgencyCancelledError, RestoreSignal } from "./errors.js";
import { callHook, invokeCallbacks, registerGlobalHook } from "./hooks.js";
import { State, StateStack } from "./state/stateStack.js";

function ctxWithStack(
  stack: State[],
  tsCallbacks: any = {},
  topLevelCallbacks: Array<{ name: string; fn: any }> = [],
): any {
  const stateStack = new StateStack();
  stateStack.stack = stack;
  return { stateStack, callbacks: tsCallbacks, topLevelCallbacks };
}

function fakeCtx(): any {
  return {
    topLevelCallbacks: [],
    callbacks: {},
    stateStack: { collectScopedCallbacks: () => [] },
  };
}

describe("callHook", () => {
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

  it("ignores callback return values", async () => {
    const inner = new State();
    inner.scopedCallbacks = [
      { name: "onLLMCallEnd", fn: () => ["whatever"] },
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

describe("registerGlobalHook", () => {
  it("fires registered global hooks", async () => {
    const calls: string[] = [];
    registerGlobalHook("onEmit", (_data) => { calls.push("global"); });
    const ctx = fakeCtx();
    await callHook({ ctx, name: "onEmit", data: "hello" as any });
    expect(calls).toContain("global");
  });
});

describe("invokeCallbacks subprocess forwarding", () => {
  const originalSend = process.send;
  afterEach(() => {
    process.send = originalSend;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("forwards the event to the parent when in IPC mode", async () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const sent: any[] = [];
    process.send = ((m: any) => { sent.push(m); return true; }) as any;
    const ctx: any = { callbacks: {}, topLevelCallbacks: [], stateStack: new StateStack() };
    await invokeCallbacks({ ctx, name: "onNodeStart", data: { nodeName: "x" }, stateStack: ctx.stateStack });
    expect(sent).toEqual([{ type: "callback", name: "onNodeStart", data: { nodeName: "x" } }]);
  });

  it("does not forward outside IPC mode", async () => {
    const send = vi.fn(() => true);
    process.send = send as any;
    const ctx: any = { callbacks: {}, topLevelCallbacks: [], stateStack: new StateStack() };
    await invokeCallbacks({ ctx, name: "onNodeStart", data: { nodeName: "x" }, stateStack: ctx.stateStack });
    expect(send).not.toHaveBeenCalled();
  });

  it("forwarding is ADDITIVE: the local callback still fires in IPC mode", async () => {
    // Guards the "purely additive" invariant: the emit line must not replace or
    // short-circuit the existing local callback firing. A registered callback
    // must BOTH fire locally AND be forwarded.
    vi.stubEnv("AGENCY_IPC", "1");
    const sent: any[] = [];
    process.send = ((m: any) => { sent.push(m); return true; }) as any;
    const fired: any[] = [];
    const stack = new StateStack();
    const ctx: any = { callbacks: { onNodeStart: (d: any) => fired.push(d) }, topLevelCallbacks: [], stateStack: stack };
    await invokeCallbacks({ ctx, name: "onNodeStart", data: { nodeName: "x" }, stateStack: stack });
    expect(fired).toEqual([{ nodeName: "x" }]); // local callback still fired
    expect(sent).toEqual([{ type: "callback", name: "onNodeStart", data: { nodeName: "x" } }]); // and forwarded
  });
});
