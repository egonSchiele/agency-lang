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

describe("MessageThread label-preserving edits", () => {
  it("removeAt drops only that message's label, keeping the rest aligned", () => {
    const t = new MessageThread();
    t.push(smoltalk.systemMessage("facts"), null);
    t.push(smoltalk.userMessage("a"), "seed");
    t.push(smoltalk.userMessage("b"), "coder");

    t.removeAt(0);

    expect(t.getMessages()).toHaveLength(2);
    expect(t.labelAt(0)).toBe("seed");
    expect(t.labelAt(1)).toBe("coder");
  });

  it("adoptFrom takes the other thread's labels, not just its messages", () => {
    const restored = new MessageThread();
    restored.push(smoltalk.userMessage("a"), "seed");
    const live = new MessageThread();
    const liveId = live.id;

    live.adoptFrom(restored);

    expect(live.labelAt(0)).toBe("seed");
    // The alias survives: same object, same identity.
    expect(live.id).toBe(liveId);
  });

  it("adoptFrom copies, so later pushes do not leak between threads", () => {
    const source = new MessageThread();
    source.push(smoltalk.userMessage("a"), "seed");
    const live = new MessageThread();
    live.adoptFrom(source);
    live.push(smoltalk.userMessage("b"), "later");
    expect(source.getMessages()).toHaveLength(1);
    expect(source.messageLabels).toHaveLength(1);
  });

  it("setMessages takes labels when the caller has them", () => {
    const t = new MessageThread();
    t.setMessages([smoltalk.userMessage("a"), smoltalk.userMessage("b")], [
      null,
      "kept",
    ]);
    expect(t.labelAt(0)).toBe(null);
    expect(t.labelAt(1)).toBe("kept");
  });

  it("setMessages refuses a labels array of the wrong length", () => {
    // Unlabeled beats mislabeled: a length disagreement means the source
    // is already wrong, so do not guess an alignment.
    const t = new MessageThread();
    t.setMessages([smoltalk.userMessage("a"), smoltalk.userMessage("b")], [
      "only-one",
    ]);
    expect(t.messageLabels).toEqual([null, null]);
  });

  it("toJSON hands out a copy of the labels, not the live array", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("a"), "seed");
    const json = t.toJSON();
    (json.messageLabels as (string | null)[])[0] = "mutated";
    expect(t.labelAt(0)).toBe("seed");
  });

  it("omits messageLabels entirely when nothing is labeled", () => {
    // An all-null array says nothing the absent key doesn't, and emitting
    // it would change the serialized shape of every thread for every
    // program that never labels. Checkpoints and statelog dumps stay
    // byte-identical.
    const t = new MessageThread();
    t.push(smoltalk.userMessage("a"));
    t.push(smoltalk.assistantMessage("b"));
    expect("messageLabels" in t.toJSON()).toBe(false);
  });

  it("emits messageLabels as soon as one message is labeled", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("a"));
    t.push(smoltalk.assistantMessage("b"), "coder");
    expect(t.toJSON().messageLabels).toEqual([null, "coder"]);
  });

  it("revives labels from a full MessageThreadJSON round-trip (the checkpoint shape)", () => {
    // runPrompt checkpoints the FULL toJSON(); a bare messages array
    // would revive through the legacy branch with no labels at all.
    const t = new MessageThread();
    t.push(smoltalk.systemMessage("sys"));
    t.push(smoltalk.userMessage("go"), "coder");
    const revived = MessageThread.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
    expect(revived.labelAt(0)).toBe(null);
    expect(revived.labelAt(1)).toBe("coder");
  });
});

describe("MessageThread.queueMessage", () => {
  it("queues without touching the visible messages", () => {
    const t = new MessageThread();
    t.queueMessage("later");
    expect(t.getMessages()).toHaveLength(0);
    expect(t.hasQueuedMessages()).toBe(true);
  });

  it("takeQueuedMessages is FIFO, preserves role and label, and is destructive", () => {
    const t = new MessageThread();
    t.queueMessage("a");
    t.queueMessage("b", { role: "assistant", label: "lbl" });
    const q = t.takeQueuedMessages();
    expect(q.map((m) => m.content)).toEqual(["a", "b"]);
    expect(q[0]).toMatchObject({ role: "user", label: null });
    expect(q[1]).toMatchObject({ role: "assistant", label: "lbl" });
    expect(t.takeQueuedMessages()).toEqual([]);
    expect(t.hasQueuedMessages()).toBe(false);
  });

  it("survives a toJSON/fromJSON round trip through plain JSON", () => {
    const t = new MessageThread();
    t.queueMessage("survives");
    const revived = MessageThread.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
    expect(revived.takeQueuedMessages().map((m) => m.content)).toEqual(["survives"]);
  });

  it("an empty queue does not change the serialized shape", () => {
    const t = new MessageThread();
    expect("queuedMessages" in t.toJSON()).toBe(false);
  });

  it("adoptFrom carries the pending queue (the prompt.ts resume path)", () => {
    // prompt.ts:1048 restores via args.messages.adoptFrom(restored); a queue
    // that survives toJSON but not adoptFrom would be dropped exactly on
    // resume, the moment it matters most.
    const restored = new MessageThread();
    restored.queueMessage("pending across resume");
    const alias = new MessageThread();
    alias.adoptFrom(restored);
    expect(alias.takeQueuedMessages().map((m) => m.content)).toEqual([
      "pending across resume",
    ]);
  });
});
