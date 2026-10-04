import { describe, it, expect } from "vitest";
import {
  PromiseContextStorage,
  assertAsyncRewritten,
  isOutsideEveryFrame,
} from "./promiseContextStorage.js";

/**
 * These tests pause with `.then` and timers, never with `await`, so they mean
 * the same thing whether or not the build rewrites async functions. A real
 * `async` function is built with `new Function` where a test needs one,
 * because the rewrite would turn one written here into a plain function.
 */

function later<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function realAsyncFunction(body: string, ...args: unknown[]): () => Promise<unknown> {
  const names = args.map((_, i) => `arg${i}`);
  return new Function(...names, `return async () => { ${body} };`)(...args);
}

describe("PromiseContextStorage", () => {
  it("is empty outside run and holds the value inside it", () => {
    const store = new PromiseContextStorage<string>();
    expect(store.getStore()).toBeUndefined();
    expect(store.run("timers", () => store.getStore())).toBe("timers");
    expect(store.getStore()).toBeUndefined();
    expect(isOutsideEveryFrame()).toBe(true);
  });

  it("gives each paused caller its own value back", async () => {
    const store = new PromiseContextStorage<string>();
    // The timers call pauses for longer, so the lists call starts and
    // finishes while it is paused. A plain shared variable would say "lists"
    // for both.
    const timers = store.run("timers", () => later(20, null).then(() => store.getStore()));
    const lists = store.run("lists", () => later(5, null).then(() => store.getStore()));
    expect(await Promise.all([timers, lists])).toEqual(["timers", "lists"]);
  });

  it("carries the value through a chain of pauses", async () => {
    const store = new PromiseContextStorage<string>();
    const seen = store.run("timers", () =>
      later(1, null)
        .then(() => later(1, null))
        .then(() => later(1, null))
        .then(() => store.getStore()),
    );
    expect(await seen).toBe("timers");
  });

  it("carries the value into a timer callback", async () => {
    const store = new PromiseContextStorage<string>();
    const seen = store.run(
      "timers",
      () => new Promise((resolve) => setTimeout(() => resolve(store.getStore()), 1)),
    );
    expect(await seen).toBe("timers");
  });

  it("keeps two stores apart, and an inner run does not disturb the outer value", () => {
    const tools = new PromiseContextStorage<string>();
    const depth = new PromiseContextStorage<number>();
    const seen = tools.run("timers", () =>
      depth.run(1, () => {
        const inner = depth.run(2, () => [tools.getStore(), depth.getStore()]);
        return [inner, [tools.getStore(), depth.getStore()]];
      }),
    );
    expect(seen).toEqual([
      ["timers", 2],
      ["timers", 1],
    ]);
  });

  it("puts the old value back when the body throws", () => {
    const store = new PromiseContextStorage<string>();
    expect(() =>
      store.run("timers", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.getStore()).toBeUndefined();
  });

  it("exit runs its callback with no value", () => {
    const store = new PromiseContextStorage<string>();
    expect(store.run("timers", () => store.exit(() => store.getStore()))).toBeUndefined();
  });

  it("a real async function still returns to a caller that has its value", async () => {
    const store = new PromiseContextStorage<string>();
    const helper = realAsyncFunction("await null; return 1;");
    const seen = store.run("timers", () => helper().then(() => store.getStore()));
    expect(await seen).toBe("timers");
  });

  it("a real async function sees an empty context after its first await", async () => {
    const store = new PromiseContextStorage<string>();
    const helper = realAsyncFunction(
      "const before = arg0.getStore(); await null; return [before, arg0.getStore()];",
      store,
    );
    const seen = store.run("timers", () => helper());
    // Empty, and not some other caller's value.
    expect(await seen).toEqual(["timers", undefined]);
  });
});

describe("assertAsyncRewritten", () => {
  it("refuses a real async function and names it", () => {
    const helper = realAsyncFunction("return 1;");
    expect(() => assertAsyncRewritten(helper, "timers.agency:startTimer")).toThrow(
      /timers\.agency:startTimer is a real async function/,
    );
  });

  it("accepts a plain function that returns a promise", () => {
    expect(() => assertAsyncRewritten(() => Promise.resolve(1), "x")).not.toThrow();
  });
});
