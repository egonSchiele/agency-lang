import { describe, it, expect } from "vitest";
import { AsyncLocalStorage as NodeAls } from "./asyncLocalStorage.js";
import {
  AsyncLocalStorage as BrowserAls,
  PORTABLE_CONTEXT as BROWSER_PORTABLE_CONTEXT,
  pickContextStorage,
} from "./asyncLocalStorage.browser.js";
import { PromiseContextStorage } from "./promiseContextStorage.js";

describe("async-context seam: Node re-export", () => {
  it("is a real AsyncLocalStorage and carries context across awaits", async () => {
    const als = new NodeAls<{ id: string }>();
    const seen = await als.run({ id: "a" }, async () => {
      await Promise.resolve();
      return als.getStore()?.id;
    });
    expect(seen).toBe("a");
  });

  it("exit() runs its callback with no active store", () => {
    const als = new NodeAls<{ id: string }>();
    const inside = als.run({ id: "a" }, () => als.exit(() => als.getStore()));
    expect(inside).toBeUndefined();
  });
});

/**
 * A synchronous stand-in for `AsyncContext.Variable`. It cannot carry a value
 * across `await`, so these tests check the adapter's mapping inside
 * synchronous scopes only.
 */
class FakeVariable<T> {
  private readonly stack: T[] = [];

  get(): T | undefined {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : undefined;
  }

  run<R>(value: T, fn: () => R): R {
    this.stack.push(value);
    try {
      return fn();
    } finally {
      this.stack.pop();
    }
  }
}

describe("async-context seam: browser store", () => {
  it("uses native AsyncContext when the engine has it", () => {
    const picked = pickContextStorage({ Variable: FakeVariable });
    const als = new picked.AsyncLocalStorage<{ id: string }>();

    expect(picked.PORTABLE_CONTEXT).toBe(false);
    expect(als.run({ id: "a" }, () => als.getStore()?.id)).toBe("a");
    expect(als.run({ id: "a" }, () => als.exit(() => als.getStore()))).toBeUndefined();
    expect(als.getStore()).toBeUndefined();
  });

  it("uses the promise-tracking store when the engine has no AsyncContext", () => {
    const picked = pickContextStorage(undefined);

    expect(picked.PORTABLE_CONTEXT).toBe(true);
    expect(picked.AsyncLocalStorage).toBe(PromiseContextStorage);
  });

  it("picks the promise-tracking store on this engine", () => {
    // Node has no `AsyncContext` global, which is the case every browser is
    // in today. The module-level exports are what a browser bundle imports.
    expect(BROWSER_PORTABLE_CONTEXT).toBe(true);
    expect(BrowserAls).toBe(PromiseContextStorage);
  });
});
