import { describe, it, expect } from "vitest";
import { bodySlots } from "./bodySlots.js";

describe("bodySlots — guardBlock", () => {
  it("exposes its body slot and round-trips through write", () => {
    const body = [{ type: "returnStatement", value: null }];
    const node = {
      type: "guardBlock",
      arguments: [],
      body,
    } as any;
    const slots = bodySlots(node);
    expect(slots.map((s) => s.body)).toEqual([body]);
    const rewritten = slots[0].write(node, []) as any;
    expect(rewritten.body).toEqual([]);
    expect(rewritten.type).toBe("guardBlock");
  });
});
