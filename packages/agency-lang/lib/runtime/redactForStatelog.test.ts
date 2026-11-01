import { describe, it, expect } from "vitest";
import { GlobalStore } from "./state/globalStore.js";
import {
  BINARY_OMIT_MIN_LENGTH,
  makeScrubReplacer,
  omitBinaryRule,
  redactRule,
  stringifyStatelogEvent,
} from "./redactForStatelog.js";

// Serialize `body` the way StatelogClient.post does, then parse back so we
// can assert on structure.
function roundtrip(body: unknown, gs: GlobalStore): unknown {
  return JSON.parse(JSON.stringify(body, makeScrubReplacer([redactRule(gs)])));
}

describe("redactRule", () => {
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

  it("redacts a tagged object whose toJSON returns an object (no leak)", () => {
    // Regression: JSON.stringify runs toJSON BEFORE the replacer, so the
    // replacer's `value` is the post-toJSON object, not the tagged one. The
    // tag lookup must use the original (this[key]) or the secret leaks.
    const gs = new GlobalStore();
    const secret = { toJSON: () => ({ leaked: "sensitive" }) };
    gs.markRedacted(secret);
    expect(roundtrip({ secret }, gs)).toEqual({ secret: "[REDACTED]" });
  });

  it("does not redact a tag whose redact value is not true", () => {
    const gs = new GlobalStore();
    gs.setTag("x", "redact", false);
    gs.setTag("y", "color", "blue");
    expect(roundtrip({ a: "x", b: "y" }, gs)).toEqual({ a: "x", b: "y" });
  });

  // The v1 whole-values-only boundary was deliberately widened: a redacted
  // string interpolated into a larger string (an email body carrying a
  // presigned URL) is scrubbed by containment.
  it("scrubs a redacted string embedded in a larger string", () => {
    const gs = new GlobalStore();
    gs.markRedacted("sk-secret");
    const body = { url: "https://api.com?key=sk-secret" };
    expect(roundtrip(body, gs)).toEqual({ url: "https://api.com?key=[REDACTED]" });
  });

  it("scrubs every occurrence, keeping the custom label", () => {
    const gs = new GlobalStore();
    gs.markRedacted("https://b.s3.amazonaws.com/k?X-Amz-Signature=abc", "[link redacted]");
    const body = {
      email:
        "Download: https://b.s3.amazonaws.com/k?X-Amz-Signature=abc " +
        "(again: https://b.s3.amazonaws.com/k?X-Amz-Signature=abc)",
    };
    expect(roundtrip(body, gs)).toEqual({
      email: "Download: [link redacted] (again: [link redacted])",
    });
  });

  it("scrubs a longer secret before a shorter one contained in it", () => {
    const gs = new GlobalStore();
    gs.markRedacted("token", "[short]");
    gs.markRedacted("token-extended", "[long]");
    expect(roundtrip({ note: "use token-extended here" }, gs)).toEqual({
      note: "use [long] here",
    });
  });

  it("redacts nothing when the store has no tags", () => {
    const gs = new GlobalStore();
    expect(roundtrip({ apiKey: "secret" }, gs)).toEqual({ apiKey: "secret" });
  });
});

describe("omitBinaryRule", () => {
  // 6,000 bytes encode to 8,000 base64 characters with no padding.
  const picture = Buffer.alloc(6000, 7).toString("base64");
  const omit = (body: unknown): unknown =>
    JSON.parse(JSON.stringify(body, makeScrubReplacer([omitBinaryRule])));

  it("replaces a long base64 string with its size", () => {
    expect(omit({ bytes: picture })).toEqual({ bytes: "[base64: 6000 bytes omitted]" });
  });

  it("takes the mime type from the object that holds the bytes", () => {
    const attachment = {
      type: "image",
      source: { kind: "base64", base64: picture, mimeType: "image/png" },
    };
    expect(omit({ attachment })).toEqual({
      attachment: {
        type: "image",
        source: {
          kind: "base64",
          base64: "[image/png: 6000 bytes omitted]",
          mimeType: "image/png",
        },
      },
    });
  });

  it("takes the mime type from a data: URI", () => {
    expect(omit({ url: `data:image/jpeg;base64,${picture}` })).toEqual({
      url: "[image/jpeg: 6000 bytes omitted]",
    });
  });

  it("counts padding when it sizes the bytes", () => {
    const padded = Buffer.alloc(6001, 7).toString("base64");
    expect(padded.endsWith("==")).toBe(true);
    expect(omit({ bytes: padded })).toEqual({ bytes: "[base64: 6001 bytes omitted]" });
  });

  it("matches URL-safe base64", () => {
    const everyByte = Array.from({ length: 6000 }, (_, index) => index % 256);
    const urlSafe = Buffer.from(everyByte).toString("base64url");
    expect(urlSafe).toMatch(/[-_]/);
    expect(omit({ bytes: urlSafe })).toEqual({ bytes: "[base64: 6000 bytes omitted]" });
  });

  it("keeps base64 at or under the length limit", () => {
    const short = "A".repeat(BINARY_OMIT_MIN_LENGTH);
    expect(omit({ bytes: short })).toEqual({ bytes: short });
  });

  it("keeps long prose and long JSON text", () => {
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(120);
    const json = JSON.stringify(Array.from({ length: 500 }, (_, index) => ({ index })));
    expect(prose.length).toBeGreaterThan(BINARY_OMIT_MIN_LENGTH);
    expect(json.length).toBeGreaterThan(BINARY_OMIT_MIN_LENGTH);
    expect(omit({ prose, json })).toEqual({ prose, json });
  });

  it("keeps long hex, long numbers, and one-letter filler", () => {
    const hex = Buffer.alloc(3000, 171).toString("hex");
    const digits = "1234567890".repeat(500);
    const filler = "x".repeat(5000);
    expect(omit({ hex, digits, filler })).toEqual({ hex, digits, filler });
  });

  it("keeps a long data: URI that is not base64", () => {
    const text = `data:text/plain,${"a".repeat(5000)}`;
    expect(omit({ text })).toEqual({ text });
  });
});

describe("stringifyStatelogEvent", () => {
  const envelope = (data: Record<string, unknown>) => ({
    format_version: 1,
    trace_id: "trace",
    project_id: "project",
    span_id: null,
    parent_span_id: null,
    data,
  });

  it("writes the same text as a plain stringify when no rule fires", () => {
    const event = envelope({ type: "toolCall", args: { city: "Mumbai" }, when: new Date(0) });
    expect(stringifyStatelogEvent(event, [omitBinaryRule])).toBe(JSON.stringify(event));
  });

  it("applies the rules inside data but never to envelope fields", () => {
    const gs = new GlobalStore();
    gs.markRedacted("trace");
    const text = stringifyStatelogEvent(envelope({ type: "toolCall", note: "trace" }), [
      redactRule(gs),
    ]);
    expect(JSON.parse(text)).toMatchObject({
      trace_id: "trace",
      data: { note: "[REDACTED]" },
    });
  });

  it("omits picture bytes inside data", () => {
    const picture = Buffer.alloc(6000, 7).toString("base64");
    const text = stringifyStatelogEvent(envelope({ type: "agentStart", args: { picture } }), [
      omitBinaryRule,
    ]);
    expect(text).not.toContain(picture);
    expect(JSON.parse(text).data.args.picture).toBe("[base64: 6000 bytes omitted]");
  });
});
