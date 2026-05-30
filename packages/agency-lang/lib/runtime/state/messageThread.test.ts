import { describe, it, expect } from "vitest";
import { MessageThread } from "./messageThread.js";

describe("MessageThread defaults", () => {
  it("has hidden=false, label=null, summary=null, parentId=null by default", () => {
    const t = new MessageThread();
    expect(t.hidden).toBe(false);
    expect(t.label).toBeNull();
    expect(t.summary).toBeNull();
    expect(t.parentId).toBeNull();
    expect(t.messages).toEqual([]);
  });
});

describe("MessageThread JSON round-trip", () => {
  it("preserves hidden / label / summary / parentId / messages", () => {
    const t = new MessageThread();
    t.hidden = true;
    t.label = "my-label";
    t.summary = "my-summary";
    t.parentId = "42";
    const restored = MessageThread.fromJSON(t.toJSON());
    expect(restored.hidden).toBe(true);
    expect(restored.label).toBe("my-label");
    expect(restored.summary).toBe("my-summary");
    expect(restored.parentId).toBe("42");
  });

  it("preserves default values across round-trip", () => {
    const t = new MessageThread();
    const restored = MessageThread.fromJSON(t.toJSON());
    expect(restored.hidden).toBe(false);
    expect(restored.label).toBeNull();
    expect(restored.summary).toBeNull();
    expect(restored.parentId).toBeNull();
  });

  it("defaults missing back-compat fields when reading old-shape JSON", () => {
    // Simulate a JSON blob produced by an older runtime that didn't
    // emit the `hidden` / `label` / `summary` fields at all.
    const oldShape = { messages: [] };
    const restored = MessageThread.fromJSON(oldShape as any);
    expect(restored.hidden).toBe(false);
    expect(restored.label).toBeNull();
    expect(restored.summary).toBeNull();
    expect(restored.parentId).toBeNull();
  });
});
