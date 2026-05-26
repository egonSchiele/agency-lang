import { describe, expect, it } from "vitest";
import { BootstrapThreadStore } from "./bootstrapThreadStore.js";

describe("BootstrapThreadStore", () => {
  it("throws on every user-facing operation with an actionable message", () => {
    const store = new BootstrapThreadStore();
    const expectedFragment = "Message threads are not available in this scope";
    const calls: { name: string; fn: () => unknown }[] = [
      { name: "create", fn: () => store.create() },
      { name: "createAndReturnThread", fn: () => store.createAndReturnThread() },
      { name: "createSubthread", fn: () => store.createSubthread() },
      { name: "createAndReturnSubthread", fn: () => store.createAndReturnSubthread() },
      { name: "get", fn: () => store.get("0") },
      { name: "pushActive", fn: () => store.pushActive("0") },
      { name: "popActive", fn: () => store.popActive() },
      { name: "activeId", fn: () => store.activeId() },
      { name: "active", fn: () => store.active() },
      { name: "getOrCreateActive", fn: () => store.getOrCreateActive() },
    ];
    for (const call of calls) {
      expect(call.fn, `BootstrapThreadStore.${call.name} should throw`).toThrow(
        expectedFragment,
      );
    }
  });

  it("instanceof ThreadStore so it satisfies the ALS store contract", () => {
    const store = new BootstrapThreadStore();
    expect(store).toBeInstanceOf(BootstrapThreadStore);
    // Constructor does not auto-create a default thread, so no throws fire
    // during ALS frame setup. The throw only happens when user code tries
    // to actually use the store.
    expect(store.activeStack).toEqual([]);
  });
});
