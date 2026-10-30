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
  it("preserves a message-thread identity through serialization", () => {
    const thread = new MessageThread();
    expect(MessageThread.fromJSON(thread.toJSON()).id).toBe(thread.id);
  });

  it("accepts old snapshots and keeps adoption's destination identity", () => {
    const legacy = MessageThread.fromJSON({ messages: [] });
    expect(legacy.id.length).toBeGreaterThan(0);
    const destination = new MessageThread();
    const identity = destination.id;
    destination.adoptFrom(legacy);
    expect(destination.id).toBe(identity);
  });

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
  it("stores a label on a pushed message and reads it back by index", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("hi"), "verifier");
    t.push(smoltalk.assistantMessage("ok"));
    expect(t.labelAt(0)).toBe("verifier");
    expect(t.labelAt(1)).toBe(null);
    expect(t.getMessages()[0].metadata).toEqual({ label: "verifier" });
  });

  it("round-trips labels through toJSON/fromJSON in the messages themselves", () => {
    const t = new MessageThread();
    t.push(smoltalk.systemMessage("sys"));
    t.push(smoltalk.userMessage("go"), "coder");
    const json = JSON.parse(JSON.stringify(t.toJSON()));
    expect("messageLabels" in json).toBe(false);
    const revived = MessageThread.fromJSON(json);
    expect(revived.labelAt(0)).toBe(null);
    expect(revived.labelAt(1)).toBe("coder");
  });

  it("leaves the JSON of an unlabeled thread without metadata", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("a"));
    t.push(smoltalk.assistantMessage("b"));
    expect(JSON.stringify(t.toJSON())).not.toContain("metadata");
  });

  it("does not change a message another holder shares", () => {
    const shared = smoltalk.userMessage("a");
    const t = new MessageThread();
    t.push(shared, "seed");
    expect(shared.metadata).toBeUndefined();
  });

  it("push keeps metadata the message already carries when given no value for it", () => {
    const t = new MessageThread();
    t.enterHandoffScope("explorer:c1");
    t.push(smoltalk.systemMessage("persona", { metadata: { label: "persona" } }));
    expect(t.labelAt(0)).toBe("persona");
    expect(t.expiryAt(0)).toEqual({ at: "handoff", key: "explorer:c1" });
  });

  it("a subthread child starts with its parent's labels", () => {
    const parent = new MessageThread();
    parent.push(smoltalk.userMessage("a"), "seed");
    const child = parent.newSubthreadChild(null);
    child.push(smoltalk.userMessage("b"), "child");
    expect(child.labelAt(0)).toBe("seed");
    expect(child.labelAt(1)).toBe("child");
  });
});

describe("MessageThread edits keep each message's metadata", () => {
  it("removeAt removes only that message", () => {
    const t = new MessageThread();
    t.push(smoltalk.systemMessage("facts"));
    t.push(smoltalk.userMessage("a"), "seed");
    t.push(smoltalk.userMessage("b"), "coder");
    t.removeAt(0);
    expect(t.getMessages()).toHaveLength(2);
    expect(t.labelAt(0)).toBe("seed");
    expect(t.labelAt(1)).toBe("coder");
  });

  it("adoptFrom takes the other thread's messages with their metadata", () => {
    const restored = new MessageThread();
    restored.push(smoltalk.userMessage("a"), "seed", { at: "llmCall", key: "k1" });
    const live = new MessageThread();
    const liveId = live.id;
    live.adoptFrom(restored);
    expect(live.labelAt(0)).toBe("seed");
    expect(live.expiryAt(0)).toEqual({ at: "llmCall", key: "k1" });
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
  });

  it("setMessages keeps whatever metadata the new messages carry", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("a"), "kept", { at: "llmCall", key: "k1" });
    const [kept] = t.getMessages();
    t.setMessages([smoltalk.systemMessage("summary"), kept]);
    expect(t.labelAt(0)).toBe(null);
    expect(t.labelAt(1)).toBe("kept");
    expect(t.expiryAt(1)).toEqual({ at: "llmCall", key: "k1" });
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
    expect(alias.takeQueuedMessages().map((m) => m.content)).toEqual(["pending across resume"]);
  });
});

describe("queueMessage validation and copy semantics (PR 651 review)", () => {
  it("rejects an invalid role at enqueue time", () => {
    const t = new MessageThread();
    expect(() => t.queueMessage("x", { role: "system" as never })).toThrow(
      /role must be "user" or "assistant"/,
    );
  });

  it("rejects assistant-role content that is not a string", () => {
    const t = new MessageThread();
    expect(() =>
      t.queueMessage([{ type: "text", text: "hi" }] as never, { role: "assistant" }),
    ).toThrow(/assistant-role queued messages must have string content/);
  });

  it("mutating toJSON output does not mutate the live queue", () => {
    const t = new MessageThread();
    t.queueMessage("original");
    const json = t.toJSON();
    (json.queuedMessages![0] as { content: string }).content = "tampered";
    expect(t.takeQueuedMessages()[0].content).toBe("original");
  });

  it("fromJSON tolerates queuedMessages: null in persisted JSON", () => {
    const t = new MessageThread();
    const json = t.toJSON();
    (json as { queuedMessages: unknown }).queuedMessages = null;
    const revived = MessageThread.fromJSON(json);
    expect(revived.hasQueuedMessages()).toBe(false);
  });
});

describe("repair generation — markRepaired / isNewerThan", () => {
  it("defaults to 0 and stays out of JSON until incremented", () => {
    const t = new MessageThread([smoltalk.userMessage("hi")]);
    expect(t.repairs).toBe(0);
    expect("repairs" in t.toJSON()).toBe(false);
  });

  it("markRepaired is monotonic and round-trips through JSON", () => {
    const t = new MessageThread([smoltalk.userMessage("hi")]);
    t.markRepaired();
    t.markRepaired();
    expect(t.repairs).toBe(2);
    expect(MessageThread.fromJSON(t.toJSON()).repairs).toBe(2);
  });

  it("legacy JSON without the field revives as 0", () => {
    expect(MessageThread.fromJSON({ messages: [] }).repairs).toBe(0);
  });

  it("adoptFrom copies the counter with the content", () => {
    const a = new MessageThread();
    const b = new MessageThread([smoltalk.userMessage("hi")]);
    b.markRepaired();
    a.adoptFrom(b);
    expect(a.repairs).toBe(1);
  });

  it("isNewerThan orders live thread against a snapshot", () => {
    const live = new MessageThread();
    const snapshot = new MessageThread();
    expect(live.isNewerThan(snapshot)).toBe(false); // equal → restorable
    live.markRepaired();
    expect(live.isNewerThan(snapshot)).toBe(true); // repaired after → stale
    snapshot.markRepaired();
    expect(live.isNewerThan(snapshot)).toBe(false); // snapshot post-repair → fine
  });
});

describe("MessageThread.replaceAt", () => {
  it("swaps the message and keeps the old message's label", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("q"), "ask");
    thread.push(smoltalk.assistantMessage("a"), "answer");
    thread.replaceAt(1, smoltalk.assistantMessage("b"));
    expect(thread.getMessages().map((message) => message.content)).toEqual(["q", "b"]);
    expect(thread.labelAt(1)).toBe("answer");
  });

  it("refuses an index outside the thread", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("q"));
    expect(() => thread.replaceAt(1, smoltalk.userMessage("x"))).toThrow();
    expect(() => thread.replaceAt(-1, smoltalk.userMessage("x"))).toThrow();
    expect(thread.getMessages().map((message) => message.content)).toEqual(["q"]);
  });
});

describe("MessageThread.removeMatching", () => {
  it("removes matching messages from the index on and keeps the other labels", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.systemMessage("keep: before the index"), "s0");
    thread.push(smoltalk.userMessage("u1"), "u1");
    thread.push(smoltalk.systemMessage("drop"), "s1");
    thread.push(smoltalk.assistantMessage("a1"), "a1");
    thread.push(smoltalk.systemMessage("drop too"), "s2");
    thread.removeMatching(1, (message) => message.role === "system");
    expect(thread.getMessages().map((message) => message.content)).toEqual([
      "keep: before the index",
      "u1",
      "a1",
    ]);
    expect([0, 1, 2].map((index) => thread.labelAt(index))).toEqual(["s0", "u1", "a1"]);
  });
});

describe("MessageThread expiring messages", () => {
  const contents = (t: MessageThread) => t.getMessages().map((m) => m.content);

  it("push writes the label and expiry into the message's metadata", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("hi"), "first", { at: "llmCall", key: "c1" });
    expect(t.labelAt(0)).toBe("first");
    expect(t.expiryAt(0)).toEqual({ at: "llmCall", key: "c1" });
    expect(t.getMessages()[0].metadata).toEqual({
      label: "first",
      expires: { at: "llmCall", key: "c1" },
    });
  });

  it("a system message pushed inside a handoff scope expires with it; other roles do not", () => {
    const t = new MessageThread();
    t.push(smoltalk.systemMessage("caller"));
    t.enterHandoffScope("explorer:c1");
    t.push(smoltalk.systemMessage("persona"));
    t.push(smoltalk.userMessage("brief"));
    t.exitHandoffScope();
    t.push(smoltalk.systemMessage("after"));
    expect([0, 1, 2, 3].map((i) => t.expiryAt(i))).toEqual([
      null,
      { at: "handoff", key: "explorer:c1" },
      null,
      null,
    ]);
  });

  it("an explicit expiry wins over the handoff default", () => {
    const t = new MessageThread();
    t.enterHandoffScope("explorer:c1");
    t.push(smoltalk.systemMessage("hint"), null, { at: "llmCall", key: "k1" });
    expect(t.expiryAt(0)).toEqual({ at: "llmCall", key: "k1" });
  });

  it("nested scopes tag with the innermost key", () => {
    const t = new MessageThread();
    t.enterHandoffScope("outer:1");
    t.push(smoltalk.systemMessage("outer"));
    t.enterHandoffScope("inner:2");
    t.push(smoltalk.systemMessage("inner"));
    t.exitHandoffScope();
    t.push(smoltalk.systemMessage("outer again"));
    t.exitHandoffScope();
    expect([0, 1, 2].map((i) => t.expiryAt(i)?.key)).toEqual(["outer:1", "inner:2", "outer:1"]);
  });

  it("expire removes only messages matching both at and key, and never a tool message", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("hello"), "first");
    t.push(smoltalk.systemMessage("persona"), null, { at: "handoff", key: "explorer:c1" });
    t.push(smoltalk.userMessage("warn"), null, { at: "llmCall", key: "k1" });
    t.push(smoltalk.systemMessage("other"), null, { at: "handoff", key: "oracle:c2" });
    t.push(
      smoltalk.messageFromJSON({
        role: "tool",
        content: "result",
        name: "lookup",
        tool_call_id: "c9",
        metadata: { expires: { at: "handoff", key: "explorer:c1" } },
      }),
    );
    t.expire("handoff", "explorer:c1");
    expect(contents(t)).toEqual(["hello", "warn", "other", "result"]);
    expect(t.labelAt(0)).toBe("first");
  });

  it("claimUnkeyed keys only the unkeyed messages with that at", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("a"), null, { at: "llmCall", key: null });
    t.push(smoltalk.userMessage("b"), null, { at: "llmCall", key: "k0" });
    t.push(smoltalk.systemMessage("c"), null, { at: "handoff", key: null });
    t.claimUnkeyed("llmCall", "k1");
    expect([0, 1, 2].map((i) => t.expiryAt(i))).toEqual([
      { at: "llmCall", key: "k1" },
      { at: "llmCall", key: "k0" },
      { at: "handoff", key: null },
    ]);
  });

  it("push refuses an expiry on an assistant, tool, or developer message", () => {
    const t = new MessageThread();
    const expires = { at: "llmCall" as const, key: "k" };
    expect(() => t.push(smoltalk.assistantMessage("x"), null, expires)).toThrow(/cannot expire/);
    expect(() =>
      t.push(smoltalk.toolMessage("x", { tool_call_id: "c", name: "t" }), null, expires),
    ).toThrow(/cannot expire/);
    expect(() => t.push(smoltalk.developerMessage("x"), null, expires)).toThrow(/cannot expire/);
    expect(t.getMessages()).toHaveLength(0);
  });

  it("toJSON writes neither messageLabels nor messageScopes", () => {
    const t = new MessageThread();
    t.push(smoltalk.userMessage("a"), "seed");
    t.enterHandoffScope("explorer:c1");
    t.push(smoltalk.systemMessage("persona"));
    const json = t.toJSON();
    expect("messageLabels" in json).toBe(false);
    expect("messageScopes" in json).toBe(false);
    const revived = MessageThread.fromJSON(JSON.parse(JSON.stringify(json)));
    expect(revived.labelAt(0)).toBe("seed");
    expect(revived.expiryAt(1)).toEqual({ at: "handoff", key: "explorer:c1" });
  });

  it("fromJSON folds an old checkpoint's messageLabels and messageScopes into the messages", () => {
    const json = {
      messages: [
        smoltalk.systemMessage("a").toJSON(),
        smoltalk.userMessage("b").toJSON(),
        smoltalk.systemMessage("c").toJSON(),
      ],
      messageLabels: ["s0", null, "s2"],
      messageScopes: ["explorer:c1", null, null],
    };
    const t = MessageThread.fromJSON(json);
    expect([0, 1, 2].map((i) => t.labelAt(i))).toEqual(["s0", null, "s2"]);
    expect(t.expiryAt(0)).toEqual({ at: "handoff", key: "explorer:c1" });
    expect(t.expiryAt(1)).toBeNull();
    expect(t.expiryAt(2)).toBeNull();
    t.expire("handoff", "explorer:c1");
    expect(contents(t)).toEqual(["b", "c"]);
  });

  it("fromJSON ignores legacy arrays whose length disagrees with the messages", () => {
    const json = {
      messages: [smoltalk.userMessage("a").toJSON(), smoltalk.userMessage("b").toJSON()],
      messageLabels: ["only-one"],
    };
    const t = MessageThread.fromJSON(json);
    expect([t.labelAt(0), t.labelAt(1)]).toEqual([null, null]);
  });

  it("a subthread child keeps its parent's expiring messages", () => {
    const parent = new MessageThread();
    parent.push(smoltalk.userMessage("warn"), null, { at: "llmCall", key: "k1" });
    const child = parent.newSubthreadChild(null);
    expect(child.expiryAt(0)).toEqual({ at: "llmCall", key: "k1" });
  });
});
