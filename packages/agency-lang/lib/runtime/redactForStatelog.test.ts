import { describe, it, expect } from "vitest";
import { GlobalStore } from "./state/globalStore.js";
import { makeRedactReplacer } from "./redactForStatelog.js";

// Serialize `body` the way StatelogClient.post does, then parse back so we
// can assert on structure.
function roundtrip(body: unknown, gs: GlobalStore): unknown {
  return JSON.parse(JSON.stringify(body, makeRedactReplacer(gs)));
}

describe("makeRedactReplacer", () => {
  it("redacts a tagged primitive leaf inside an object", () => {
    const gs = new GlobalStore();
    gs.markRedacted("sk-123");
    const body = { url: "https://api.com", apiKey: "sk-123", n: 5 };
    expect(roundtrip(body, gs)).toEqual({
      url: "https://api.com",
      apiKey: "[REDACTED]",
      n: 5,
    });
  });

  it("redacts a tagged object node without descending", () => {
    const gs = new GlobalStore();
    const creds = { user: "a", pass: "b" };
    gs.markRedacted(creds);
    expect(roundtrip({ creds, ok: true }, gs)).toEqual({
      creds: "[REDACTED]",
      ok: true,
    });
  });

  it("walks arrays", () => {
    const gs = new GlobalStore();
    gs.markRedacted("secret");
    expect(roundtrip({ items: ["a", "secret", "b"] }, gs)).toEqual({
      items: ["a", "[REDACTED]", "b"],
    });
  });

  it("preserves an untagged Date (native toJSON is not flattened)", () => {
    // The critical regression guard: a naive Object.entries deep-walk turns a
    // Date into {}. Install a replacer (via an unrelated tag so the path is
    // live) and confirm the Date still serializes to its ISO string.
    const gs = new GlobalStore();
    gs.markRedacted("unrelated");
    const when = new Date("2026-01-01T00:00:00.000Z");
    expect(roundtrip({ when }, gs)).toEqual({ when: "2026-01-01T00:00:00.000Z" });
  });

  it("preserves an untagged value's custom toJSON output", () => {
    const gs = new GlobalStore();
    gs.markRedacted("unrelated");
    const custom = { toJSON: () => "custom-serialized" };
    expect(roundtrip({ v: custom }, gs)).toEqual({ v: "custom-serialized" });
  });

  it("redacts a tagged Date node (reference tag on a non-plain object)", () => {
    const gs = new GlobalStore();
    const when = new Date("2026-01-01T00:00:00.000Z");
    gs.markRedacted(when);
    expect(roundtrip({ when }, gs)).toEqual({ when: "[REDACTED]" });
  });

  it("does not redact a tag whose redact value is not true", () => {
    const gs = new GlobalStore();
    gs.setTag("x", "redact", false);
    gs.setTag("y", "color", "blue");
    expect(roundtrip({ a: "x", b: "y" }, gs)).toEqual({ a: "x", b: "y" });
  });

  it("redacts whole values only — an embedded substring is NOT scrubbed (v1)", () => {
    const gs = new GlobalStore();
    gs.markRedacted("sk-secret");
    const body = { url: "https://api.com?key=sk-secret" };
    // Locks the documented v1 boundary; must be updated deliberately if
    // substring redaction is ever added.
    expect(roundtrip(body, gs)).toEqual(body);
  });

  it("redacts nothing when the store has no tags", () => {
    const gs = new GlobalStore();
    expect(roundtrip({ apiKey: "secret" }, gs)).toEqual({ apiKey: "secret" });
  });
});
