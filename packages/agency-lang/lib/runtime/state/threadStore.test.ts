import { describe, it, expect } from "vitest";
import { ThreadStore } from "./threadStore.js";
import { MessageThread } from "./messageThread.js";

describe("ThreadStore parentId tracking", () => {
  it("create() returns a top-level thread with parentId null", () => {
    const store = new ThreadStore();
    const id = store.create();
    expect(store.get(id).parentId).toBeNull();
  });

  it("createSubthread() sets parentId to the active thread id", () => {
    const store = new ThreadStore();
    const parentId = store.create();
    store.pushActive(parentId);
    const childId = store.createSubthread();
    expect(store.get(childId).parentId).toBe(parentId);
  });

  it("parentId survives JSON round-trip", () => {
    const store = new ThreadStore();
    const parentId = store.create();
    store.pushActive(parentId);
    const childId = store.createSubthread();
    const json = store.toJSON();
    const restored = ThreadStore.fromJSON(json);
    expect(restored.get(parentId).parentId).toBeNull();
    expect(restored.get(childId).parentId).toBe(parentId);
  });

  it("MessageThread JSON round-trip preserves parentId", () => {
    const mt = new MessageThread();
    mt.parentId = "42";
    const restored = MessageThread.fromJSON(mt.toJSON());
    expect(restored.parentId).toBe("42");
  });

  it("MessageThread JSON round-trip preserves null parentId", () => {
    const mt = new MessageThread();
    const restored = MessageThread.fromJSON(mt.toJSON());
    expect(restored.parentId).toBeNull();
  });
});
