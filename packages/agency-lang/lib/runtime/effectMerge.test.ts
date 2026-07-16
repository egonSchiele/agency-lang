import { describe, it, expect } from "vitest";
import { mergeFor, mergeForIpc } from "./effectMerge.js";
import { interruptWithHandlers, mergeChainOutcomes, pass } from "./interrupts.js";
import { RuntimeContext } from "./state/context.js";

describe("mergeFor — the table is total", () => {
  it("an unregistered effect keeps the historical overwrite, including a valueless outer clobbering an inner value", () => {
    const merge = mergeFor("std::bash");
    expect(merge("inner", "outer")).toBe("outer");
    expect(merge("inner", undefined)).toBe(undefined);
  });

  it("the IPC default defers to the inner value when the outer is valueless", () => {
    const merge = mergeForIpc("std::bash");
    expect(merge("inner", "outer")).toBe("outer");
    expect(merge("inner", undefined)).toBe("inner");
  });
});

describe("mergeFor(std::guard) — approvals accumulate", () => {
  const merge = mergeFor("std::guard");

  it("sums grants per dimension and leaves untouched dimensions undefined", () => {
    expect(merge({ maxCost: 0.5 }, { maxCost: 0.5, maxTime: 60000 })).toEqual({
      maxCost: 1.0,
      maxTime: 60000,
      disarm: undefined,
      message: undefined,
    });
  });

  it("unions disarm lists without duplicates", () => {
    expect(
      merge({ disarm: ["cost"] }, { disarm: ["cost", "time"] }).disarm,
    ).toEqual(["cost", "time"]);
  });

  it("joins messages in inner-to-outer order (merge is not commutative)", () => {
    const three = [{ message: "a" }, { message: "b" }, { message: "c" }];
    expect(three.reduce(merge).message).toBe("a\nb\nc");
  });

  it("is the same function on the IPC path — guard grants accumulate across processes", () => {
    expect(mergeForIpc("std::guard")).toBe(merge);
  });
});

describe("the chain merges approvals through the effect table", () => {
  const makeCtx = (handlers: any[]): RuntimeContext<any> => {
    const ctx = new RuntimeContext({
      statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
      smoltalkDefaults: {},
      dirname: process.cwd(),
    });
    ctx.handlers = handlers;
    ctx.runId = "test-run";
    return ctx;
  };

  it("two std::guard approvals accumulate instead of overwriting", async () => {
    const ctx = makeCtx([
      async () => ({ type: "approve", value: { maxCost: 0.5, message: "outer says go" } }),
      async () => ({ type: "approve", value: { maxCost: 0.5 } }),
    ]);
    const verdict = await interruptWithHandlers("std::guard", "m", {}, "o", ctx);
    expect(verdict).toEqual({
      type: "approve",
      value: {
        maxCost: 1.0,
        maxTime: undefined,
        disarm: undefined,
        message: "outer says go",
      },
    });
  });

  it("an unregistered effect keeps outer-overwrites, valueless outer included", async () => {
    const ctx = makeCtx([
      async () => ({ type: "approve", value: undefined }),
      async () => ({ type: "approve", value: 42 }),
    ]);
    const verdict = await interruptWithHandlers("std::bash", "m", {}, "o", ctx);
    expect(verdict).toEqual({ type: "approve", value: undefined });
  });

  it("passes between approvals do not disturb the merge", async () => {
    const ctx = makeCtx([
      async () => ({ type: "approve", value: { maxCost: 0.25 } }),
      async () => pass(),
      async () => ({ type: "approve", value: { maxCost: 0.75 } }),
    ]);
    const verdict = (await interruptWithHandlers(
      "std::guard", "m", {}, "o", ctx,
    )) as any;
    expect(verdict.value.maxCost).toBe(1.0);
  });
});

describe("mergeChainOutcomes routes double-approves through the table", () => {
  it("std::guard grants accumulate across the process boundary", () => {
    const merged = mergeChainOutcomes(
      "std::guard",
      { kind: "approved", value: { maxCost: 0.5 } },
      { kind: "approved", value: { maxCost: 0.5 } },
    );
    expect(merged).toEqual({
      kind: "approved",
      value: { maxCost: 1.0, maxTime: undefined, disarm: undefined, message: undefined },
    });
  });
});
