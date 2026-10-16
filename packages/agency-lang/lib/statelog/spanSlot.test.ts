import { describe, expect, it } from "vitest";
import { SPAN_SLOT_PREFIX, savedSpanIdFor, saveSpan, spanSlot } from "./spanSlot.js";

const key = `${SPAN_SLOT_PREFIX}llmCall`;

describe("savedSpanIdFor", () => {
  it("returns the id saved for the same trace", () => {
    const locals: Record<string, unknown> = {};
    saveSpan({ locals, key }, { traceId: "trace-A", spanId: "abcDEF123_-x" });
    expect(savedSpanIdFor({ locals, key }, "trace-A")).toBe("abcDEF123_-x");
  });

  it("ignores an id minted in another trace", () => {
    const locals: Record<string, unknown> = {};
    saveSpan({ locals, key }, { traceId: "trace-A", spanId: "abcDEF123_-x" });
    expect(savedSpanIdFor({ locals, key }, "trace-B")).toBeUndefined();
  });

  it("ignores an empty slot", () => {
    expect(savedSpanIdFor({ locals: {}, key }, "trace-A")).toBeUndefined();
  });

  it.each([
    ["too short", "abc"],
    ["too long", "abcDEF123_-xy"],
    ["outside the alphabet", "abcDEF123_-!"],
    ["not a string", 12],
  ])("ignores an id that is %s", (_name, spanId) => {
    const locals: Record<string, unknown> = { [key]: { traceId: "trace-A", spanId } };
    expect(savedSpanIdFor({ locals, key }, "trace-A")).toBeUndefined();
  });

  it("ignores a slot that is not a record", () => {
    const locals: Record<string, unknown> = { [key]: "abcDEF123_-x" };
    expect(savedSpanIdFor({ locals, key }, "trace-A")).toBeUndefined();
  });
});

describe("spanSlot", () => {
  it("puts the name under the span prefix", () => {
    const locals = {};
    expect(spanSlot(locals, "llmCall")).toEqual({ locals, key });
  });
});
