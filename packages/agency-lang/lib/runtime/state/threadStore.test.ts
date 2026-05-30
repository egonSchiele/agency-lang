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

describe("ThreadStore.resumeExisting", () => {
  it("re-activates a known top-level thread", () => {
    const store = new ThreadStore();
    const id = store.create();
    // simulate close by leaving activeStack empty
    store.resumeExisting(id);
    expect(store.activeId()).toBe(id);
  });

  it("throws for unknown ids", () => {
    const store = new ThreadStore();
    expect(() => store.resumeExisting("999")).toThrow(/unknown thread/);
  });

  it("formats numeric ids with a t-prefix in the error message", () => {
    const store = new ThreadStore();
    expect(() => store.resumeExisting("42")).toThrow(/t42/);
  });

  it("leaves non-numeric ids unchanged in the error message (no `tt1` double-prefix)", () => {
    const store = new ThreadStore();
    expect(() => store.resumeExisting("t1")).toThrow(/Cannot resume unknown thread id: t1$/m);
  });

  it("rejects subthreads", () => {
    const store = new ThreadStore();
    const parentId = store.create();
    store.pushActive(parentId);
    const childId = store.createSubthread();
    store.popActive();
    store.popActive();
    expect(() => store.resumeExisting(childId)).toThrow(/Cannot resume subthread/);
    expect(store.activeId()).toBeUndefined();
  });
});

describe("ThreadStore.openSession", () => {
  it("first entry creates and pushes; second entry resumes the same id", () => {
    const store = new ThreadStore();
    const a = store.openSession("coding");
    expect(a.existed).toBe(false);
    expect(store.activeId()).toBe(a.id);
    // simulate block-close
    store.popActive();
    const b = store.openSession("coding");
    expect(b.existed).toBe(true);
    expect(b.id).toBe(a.id);
    expect(store.activeId()).toBe(a.id);
    // only one thread exists
    expect(Object.keys(store.threads).length).toBe(1);
  });

  it("different session names create distinct threads", () => {
    const store = new ThreadStore();
    const a = store.openSession("coding");
    store.popActive();
    const b = store.openSession("weather");
    expect(b.id).not.toBe(a.id);
    expect(Object.keys(store.threads).length).toBe(2);
  });

  it("sessions survive JSON round-trip", () => {
    const store = new ThreadStore();
    store.openSession("coding");
    const restored = ThreadStore.fromJSON(store.toJSON());
    expect(restored.sessions.coding).toBe(store.sessions.coding);
  });
});
