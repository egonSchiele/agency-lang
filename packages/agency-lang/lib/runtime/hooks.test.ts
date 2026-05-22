import { describe, it, expect, vi } from "vitest";
import { AgencyFunction } from "./agencyFunction.js";
import { AgencyCancelledError, RestoreSignal } from "./errors.js";
import { callHook } from "./hooks.js";
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

  it("throws loudly when a callback halts with an unhandled Interrupt[]", async () => {
    // Simulate an AgencyFunction callback body that produced an interrupt
    // value (i.e. interrupt was raised inside the callback and no handler
    // on the call stack caught it). callHook must surface this instead of
    // silently dropping the interrupt.
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
    await callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    // Error is logged (not rethrown — fireWithGuard's catch turns it into a
    // console.error to keep one buggy callback from killing the whole run),
    // but it MUST be visible.
    expect(consoleErr).toHaveBeenCalled();
    const logged = consoleErr.mock.calls.map((c) => String(c[1])).join("\n");
    expect(logged).toMatch(/unhandled interrupt/i);
    expect(logged).toMatch(/myapp::oops/);
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
