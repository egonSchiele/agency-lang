import { describe, it, expect, afterEach } from "vitest";
import { AsyncLocalStorage as NodeAls } from "./asyncLocalStorage.js";
import { AsyncLocalStorage as BrowserAls } from "./asyncLocalStorage.browser.js";

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
 * A synchronous stand-in for `AsyncContext.Variable`. Userland cannot propagate
 * across `await`, so these tests exercise the adapter's mapping within
 * synchronous scopes only — the part we can validate without a native engine.
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

describe("async-context seam: browser adapter", () => {
  const withAsyncContext = globalThis as { AsyncContext?: unknown };

  afterEach(() => {
    delete withAsyncContext.AsyncContext;
  });

  it("maps run / getStore / exit onto native AsyncContext.Variable", () => {
    withAsyncContext.AsyncContext = { Variable: FakeVariable };
    const als = new BrowserAls<{ id: string }>();

    expect(als.run({ id: "a" }, () => als.getStore()?.id)).toBe("a");
    expect(als.run({ id: "a" }, () => als.exit(() => als.getStore()))).toBeUndefined();
    expect(als.getStore()).toBeUndefined();
  });

  it("throws a clear error when native AsyncContext is absent", () => {
    delete withAsyncContext.AsyncContext;
    expect(() => new BrowserAls()).toThrow(/native AsyncContext/);
  });
});
