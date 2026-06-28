import { describe, it, expect } from "vitest";
import { deepFreeze, updateTokenStats } from "./utils.js";
import { GlobalStore } from "./state/globalStore.js";

const usage = (i: number, o: number) => ({
  inputTokens: i,
  outputTokens: o,
  totalTokens: i + o,
});
const cost = (c: number) => ({ inputCost: 0, outputCost: 0, totalCost: c });

describe("deepFreeze", () => {
  it("freezes a plain object", () => {
    const obj = deepFreeze({ a: 1, b: "hello" });
    expect(Object.isFrozen(obj)).toBe(true);
    expect(() => { (obj as any).a = 2; }).toThrow(TypeError);
  });

  it("freezes nested objects", () => {
    const obj = deepFreeze({ nested: { x: 1 } });
    expect(Object.isFrozen(obj.nested)).toBe(true);
    expect(() => { (obj.nested as any).x = 2; }).toThrow(TypeError);
  });

  it("freezes arrays", () => {
    const arr = deepFreeze([1, 2, 3]);
    expect(Object.isFrozen(arr)).toBe(true);
    expect(() => { (arr as any).push(4); }).toThrow(TypeError);
  });

  it("freezes nested arrays inside objects", () => {
    const obj = deepFreeze({ items: [1, 2] });
    expect(Object.isFrozen(obj.items)).toBe(true);
    expect(() => { (obj.items as any).push(3); }).toThrow(TypeError);
  });

  it("returns primitives as-is", () => {
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze("hello")).toBe("hello");
    expect(deepFreeze(true)).toBe(true);
    expect(deepFreeze(null)).toBe(null);
    expect(deepFreeze(undefined)).toBe(undefined);
  });

  it("handles already-frozen objects", () => {
    const obj = Object.freeze({ a: 1 });
    expect(() => deepFreeze(obj)).not.toThrow();
    expect(Object.isFrozen(deepFreeze(obj))).toBe(true);
  });

  it("handles cyclic references without infinite recursion", () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    expect(() => deepFreeze(obj)).not.toThrow();
    expect(Object.isFrozen(obj)).toBe(true);
  });

  it("freezes class instances at top level only", () => {
    const s = deepFreeze(new Set([1, 2, 3]));
    expect(Object.isFrozen(s)).toBe(true);
    // Internal state is still mutable (known limitation)
    expect(() => s.add(4)).not.toThrow();
  });

  it("does not recurse into class instance properties", () => {
    const obj = deepFreeze({ data: new Map([["a", 1]]) });
    expect(Object.isFrozen(obj)).toBe(true);
    expect(Object.isFrozen(obj.data)).toBe(true);
    // Map internal state still mutable (known limitation)
    expect(() => obj.data.set("b", 2)).not.toThrow();
  });
});

describe("updateTokenStats per-model breakdown", () => {
  it("records a new model on first call", () => {
    const globals = GlobalStore.withTokenStats();
    updateTokenStats({ globals, usage: usage(10, 5), cost: cost(0.001), model: "opus-4.8" });
    const stats = globals.getTokenStats();
    expect(stats.models["opus-4.8"]).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalCost: 0.001,
    });
    // The aggregate totals still accumulate independently.
    expect(stats.usage.inputTokens).toBe(10);
    expect(stats.cost.totalCost).toBe(0.001);
  });

  it("accumulates repeated calls to the same model", () => {
    const globals = GlobalStore.withTokenStats();
    updateTokenStats({ globals, usage: usage(10, 5), cost: cost(0.001), model: "opus-4.8" });
    updateTokenStats({ globals, usage: usage(2, 3), cost: cost(0.0005), model: "opus-4.8" });
    expect(globals.getTokenStats().models["opus-4.8"]).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      totalCost: 0.0015,
    });
  });

  it("tracks multiple models separately (e.g. a subagent on a different model)", () => {
    const globals = GlobalStore.withTokenStats();
    updateTokenStats({ globals, usage: usage(10, 5), cost: cost(0.001), model: "gpt-5-mini" });
    updateTokenStats({ globals, usage: usage(20, 10), cost: cost(0.03), model: "opus-4.8" });
    const models = globals.getTokenStats().models;
    expect(models["gpt-5-mini"]).toEqual({ inputTokens: 10, outputTokens: 5, totalCost: 0.001 });
    expect(models["opus-4.8"]).toEqual({ inputTokens: 20, outputTokens: 10, totalCost: 0.03 });
  });

  it("does not record a model entry when no model name is supplied", () => {
    const globals = GlobalStore.withTokenStats();
    updateTokenStats({ globals, usage: usage(10, 5), cost: cost(0.001) });
    expect(globals.getTokenStats().models).toEqual({});
    // Aggregate totals still update even without a model name.
    expect(globals.getTokenStats().usage.totalTokens).toBe(15);
  });

  it("records usage + model even when cost is undefined (free/local models)", () => {
    // A local llama-cpp model has no pricing, so the completion's `cost` is
    // undefined. The token usage must still be recorded (otherwise the agent
    // footer shows ↑0 ↓0 and no model name).
    const globals = GlobalStore.withTokenStats();
    updateTokenStats({ globals, usage: usage(15, 7), cost: undefined, model: "smollm2-135m" });
    const stats = globals.getTokenStats();
    expect(stats.usage.inputTokens).toBe(15);
    expect(stats.usage.outputTokens).toBe(7);
    expect(stats.usage.totalTokens).toBe(22);
    expect(stats.models["smollm2-135m"]).toEqual({
      inputTokens: 15,
      outputTokens: 7,
      totalCost: 0,
    });
    expect(stats.cost.totalCost).toBe(0);
  });

  it("backfills the models slot for token-stats restored from older checkpoints", () => {
    const globals = GlobalStore.withTokenStats();
    // Simulate a checkpoint written before per-model tracking existed.
    const stats = globals.getTokenStats();
    delete stats.models;
    updateTokenStats({ globals, usage: usage(1, 1), cost: cost(0.0002), model: "opus-4.8" });
    expect(globals.getTokenStats().models["opus-4.8"]).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      totalCost: 0.0002,
    });
  });
});
