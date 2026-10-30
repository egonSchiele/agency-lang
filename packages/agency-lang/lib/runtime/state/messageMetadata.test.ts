import { describe, it, expect } from "vitest";
import * as smoltalk from "smoltalk";
import { expiryOf, labelOf, mayExpire, withMetadata } from "./messageMetadata.js";

describe("labelOf and expiryOf", () => {
  it("return null on a message with no metadata", () => {
    const m = smoltalk.userMessage("hi");
    expect(labelOf(m)).toBeNull();
    expect(expiryOf(m)).toBeNull();
  });

  it("ignore an expiry on a tool message revived from JSON", () => {
    const m = smoltalk.messageFromJSON({
      role: "tool",
      content: "ok",
      name: "lookup",
      tool_call_id: "c1",
      metadata: { expires: { at: "handoff", key: "explorer:c1:1" } },
    });
    expect(expiryOf(m)).toBeNull();
  });

  it("ignore a malformed expiry", () => {
    const m = smoltalk.userMessage("hi", { metadata: { expires: { at: "soon", key: "k" } } });
    expect(expiryOf(m)).toBeNull();
  });
});

describe("withMetadata", () => {
  it("sets a label on a copy and leaves the original untouched", () => {
    const original = smoltalk.userMessage("hi");
    const copy = withMetadata(original, { label: "first" });
    expect(labelOf(copy)).toBe("first");
    expect(copy.role).toBe("user");
    expect(copy.content).toBe("hi");
    expect(copy).toBeInstanceOf(smoltalk.UserMessage);
    expect(original.metadata).toBeUndefined();
  });

  it("removes a key set to null and keeps the others", () => {
    const m = withMetadata(smoltalk.userMessage("hi"), {
      label: "first",
      expires: { at: "llmCall", key: "k1" },
    });
    const cleared = withMetadata(m, { expires: null });
    expect(expiryOf(cleared)).toBeNull();
    expect(labelOf(cleared)).toBe("first");
  });

  it("keeps a key the patch leaves out", () => {
    const labeled = withMetadata(smoltalk.systemMessage("persona"), { label: "persona" });
    const expiring = withMetadata(labeled, { expires: { at: "handoff", key: "explorer:c1:1" } });
    expect(labelOf(expiring)).toBe("persona");
    expect(expiryOf(expiring)).toEqual({ at: "handoff", key: "explorer:c1:1" });
  });

  it("keeps a tool message's call id and name", () => {
    const m = withMetadata(smoltalk.toolMessage("ok", { tool_call_id: "c1", name: "lookup" }), {
      label: "result",
    }) as smoltalk.ToolMessage;
    expect(m.tool_call_id).toBe("c1");
    expect(m.name).toBe("lookup");
    expect(labelOf(m)).toBe("result");
  });

  it("drops the metadata key when nothing is left in it", () => {
    const m = withMetadata(withMetadata(smoltalk.userMessage("hi"), { label: "x" }), {
      label: null,
    });
    expect(m.metadata).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain("metadata");
  });
});

describe("mayExpire", () => {
  it("is true for system and user messages only", () => {
    expect(mayExpire(smoltalk.systemMessage("s"))).toBe(true);
    expect(mayExpire(smoltalk.userMessage("u"))).toBe(true);
    expect(mayExpire(smoltalk.assistantMessage("a"))).toBe(false);
    expect(mayExpire(smoltalk.developerMessage("d"))).toBe(false);
    expect(mayExpire(smoltalk.toolMessage("t", { tool_call_id: "c", name: "n" }))).toBe(false);
  });
});
