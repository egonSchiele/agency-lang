import { describe, it, expect, vi } from "vitest";
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

  it("propagates interrupt errors", async () => {
    const interrupt = Object.assign(new Error("interrupt"), {
      __agencyInterrupt: true,
    });
    const inner = new State();
    inner.scopedCallbacks = [
      { name: "onNodeStart", fn: () => { throw interrupt; } },
    ];
    const ctx = ctxWithStack([inner]);
    await expect(
      callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any),
    ).rejects.toBe(interrupt);
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
