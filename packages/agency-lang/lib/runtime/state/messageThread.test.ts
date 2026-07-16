import { describe, it, expect } from "vitest";
import * as smoltalk from "smoltalk";
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

describe("MessageThread per-message labels", () => {
  it("stores a label alongside a pushed message and reads it back by index", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("hi"), "verifier");
    t.push(smoltalk.assistantMessage("ok"));
    expect(t.labelAt(0)).toBe("verifier");
    expect(t.labelAt(1)).toBe(null);
  });

  it("round-trips labels through toJSON/fromJSON", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("hi"), "verifier");
    const revived = MessageThread.fromJSON(t.toJSON());
    expect(revived.labelAt(0)).toBe("verifier");
  });

  it("revives legacy JSON without messageLabels as all-null labels", () => {
    const json = new MessageThread([smoltalk.userMessage("hi")]).toJSON();
    delete (json as any).messageLabels;
    const revived = MessageThread.fromJSON(json);
    expect(revived.labelAt(0)).toBe(null);
    expect(revived.messageLabels).toHaveLength(1);
  });

  it("setMessages resets labels (summarize/repair drop them)", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("hi"), "verifier");
    t.setMessages([smoltalk.userMessage("summary")]);
    expect(t.labelAt(0)).toBe(null);
    expect(t.messageLabels).toHaveLength(1);
  });

  // --- the invariant: length always matches, at every writer ---

  it("a constructor-seeded thread stays aligned when pushed to", () => {
    // Without a constructor seed, messageLabels would be [] against 2
    // messages, and this push would put "late" at index 0.
    const t = new MessageThread([
      smoltalk.userMessage("a"),
      smoltalk.userMessage("b"),
    ]);
    t.push(smoltalk.userMessage("c"), "late");
    expect(t.labelAt(0)).toBe(null);
    expect(t.labelAt(1)).toBe(null);
    expect(t.labelAt(2)).toBe("late");
  });

  it("addMessage keeps the arrays aligned (it delegates to push)", () => {
    const t = new MessageThread();
    t.addMessage(smoltalk.userMessage("a"));
    t.push(smoltalk.userMessage("b"), "second");
    expect(t.labelAt(0)).toBe(null);
    expect(t.labelAt(1)).toBe("second");
  });

  it("a subthread child seeded from a parent starts aligned", () => {
    const parent = new MessageThread();
    parent.push(smoltalk.userMessage("a"), "seed");
    const child = parent.newSubthreadChild(null);
    child.push(smoltalk.userMessage("b"), "child");
    // The parent's labels do not travel (cloneMessages copies messages
    // only); what matters is the child does not mis-attribute.
    expect(child.labelAt(0)).toBe(null);
    expect(child.labelAt(1)).toBe("child");
  });
});
