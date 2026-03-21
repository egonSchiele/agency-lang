import { describe, it, expect } from "vitest";
import { PendingPromiseStore } from "./pendingPromiseStore.js";
import { ConcurrentInterruptError } from "../errors.js";

describe("PendingPromiseStore", () => {
  describe("add()", () => {
    it("returns unique keys", () => {
      const store = new PendingPromiseStore();
      const key1 = store.add(Promise.resolve(1));
      const key2 = store.add(Promise.resolve(2));
      expect(key1).not.toBe(key2);
    });

    it("concurrent adds get unique keys", () => {
      const store = new PendingPromiseStore();
      const keys = Array.from({ length: 10 }, () => store.add(Promise.resolve(42)));
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(10);
    });
  });

  describe("awaitPending()", () => {
    it("resolves specific promises and calls setters", async () => {
      const store = new PendingPromiseStore();
      let resolved: any = null;
      const key = store.add(Promise.resolve("hello"), (v) => { resolved = v; });
      await store.awaitPending([key]);
      expect(resolved).toBe("hello");
    });

    it("removes awaited entries from the store", async () => {
      const store = new PendingPromiseStore();
      const key = store.add(Promise.resolve(99));
      await store.awaitPending([key]);
      // After awaiting, awaitPending on the same key should be a no-op (entry gone)
      let called = false;
      await store.awaitPending([key]);
      expect(called).toBe(false);
    });

    it("silently skips missing keys", async () => {
      const store = new PendingPromiseStore();
      await expect(store.awaitPending(["__pending_nonexistent"])).resolves.toBeUndefined();
    });

    it("resolves all specified keys with multiple keys", async () => {
      const store = new PendingPromiseStore();
      const results: any[] = [];
      const key1 = store.add(Promise.resolve("a"), (v) => results.push(v));
      const key2 = store.add(Promise.resolve("b"), (v) => results.push(v));
      await store.awaitPending([key1, key2]);
      expect(results).toContain("a");
      expect(results).toContain("b");
    });
  });

  describe("awaitAll()", () => {
    it("resolves all pending promises and calls setters", async () => {
      const store = new PendingPromiseStore();
      const results: any[] = [];
      store.add(Promise.resolve(1), (v) => results.push(v));
      store.add(Promise.resolve(2), (v) => results.push(v));
      await store.awaitAll();
      expect(results).toContain(1);
      expect(results).toContain(2);
    });

    it("is a no-op when empty", async () => {
      const store = new PendingPromiseStore();
      await expect(store.awaitAll()).resolves.toBeUndefined();
    });

    it("clears the store after resolving", async () => {
      const store = new PendingPromiseStore();
      store.add(Promise.resolve(42));
      await store.awaitAll();
      // Adding a new entry and awaiting all should only process the new one
      let callCount = 0;
      store.add(Promise.resolve(1), () => { callCount++; });
      await store.awaitAll();
      expect(callCount).toBe(1);
    });

    it("throws ConcurrentInterruptError when a promise returns an interrupt", async () => {
      const store = new PendingPromiseStore();
      const interruptResult = { type: "interrupt", data: "test" };
      store.add(Promise.resolve(interruptResult));
      await expect(store.awaitAll()).rejects.toThrow(ConcurrentInterruptError);
    });

    it("calls setters for non-interrupt results added BEFORE the interrupt entry", async () => {
      const store = new PendingPromiseStore();
      const results: any[] = [];
      store.add(Promise.resolve("before"), (v) => results.push(v));
      const interruptResult = { type: "interrupt", data: "boom" };
      store.add(Promise.resolve(interruptResult));
      try {
        await store.awaitAll();
      } catch (e) {
        // expected
      }
      expect(results).toContain("before");
    });
  });

  describe("clear()", () => {
    it("removes all entries without awaiting", async () => {
      const store = new PendingPromiseStore();
      let called = false;
      store.add(Promise.resolve(1), () => { called = true; });
      store.clear();
      await store.awaitAll();
      expect(called).toBe(false);
    });
  });
});
