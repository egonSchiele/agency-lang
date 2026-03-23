import { describe, it, expect } from "vitest";
import { PendingPromiseStore } from "./pendingPromiseStore.js";

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
      let callCount = 0;
      const key = store.add(Promise.resolve(99), () => { callCount++; });
      await store.awaitPending([key]);
      // After awaiting, awaitPending on the same key should be a no-op (entry gone),
      // so the setter should not be invoked again.
      await store.awaitPending([key]);
      expect(callCount).toBe(1);
    });

    it("silently skips missing keys", async () => {
      const store = new PendingPromiseStore();
      const result = await store.awaitPending(["__pending_nonexistent"]);
      expect(result).toBe(false);
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
      const interrupts = await store.awaitAll();
      expect(results).toContain(1);
      expect(results).toContain(2);
      expect(interrupts).toEqual([]);
    });

    it("is a no-op when empty", async () => {
      const store = new PendingPromiseStore();
      const interrupts = await store.awaitAll();
      expect(interrupts).toEqual([]);
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

    it("returns interrupts as an array when a promise returns an interrupt", async () => {
      const store = new PendingPromiseStore();
      const interruptResult = { type: "interrupt", data: "test" };
      store.add(Promise.resolve(interruptResult));
      const interrupts = await store.awaitAll();
      expect(interrupts).toHaveLength(1);
      expect(interrupts[0]).toEqual(interruptResult);
    });

    it("calls setters for non-interrupt results and collects interrupts", async () => {
      const store = new PendingPromiseStore();
      const results: any[] = [];
      store.add(Promise.resolve("before"), (v) => results.push(v));
      const interruptResult = { type: "interrupt", data: "boom" };
      store.add(Promise.resolve(interruptResult));
      store.add(Promise.resolve("after"), (v) => results.push(v));
      const interrupts = await store.awaitAll();
      expect(results).toContain("before");
      expect(results).toContain("after");
      expect(interrupts).toHaveLength(1);
      expect(interrupts[0]).toEqual(interruptResult);
    });

    it("collects multiple interrupts from different promises", async () => {
      const store = new PendingPromiseStore();
      const interrupt1 = { type: "interrupt", data: "first" };
      const interrupt2 = { type: "interrupt", data: "second" };
      store.add(Promise.resolve(interrupt1));
      store.add(Promise.resolve("normal"), (v) => {});
      store.add(Promise.resolve(interrupt2));
      const interrupts = await store.awaitAll();
      expect(interrupts).toHaveLength(2);
      expect(interrupts[0]).toEqual(interrupt1);
      expect(interrupts[1]).toEqual(interrupt2);
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
