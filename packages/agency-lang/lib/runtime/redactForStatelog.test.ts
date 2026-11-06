import { describe, it, expect } from "vitest";
import { GlobalStore } from "./state/globalStore.js";
import {
  BINARY_OMIT_MIN_LENGTH,
  makeScrubReplacer,
  omitBinaryRule,
  omitCheckpointRule,
  redactRule,
  statelogScrubRules,
  stringifyStatelogEvent,
  urlSecretRule,
  type ScrubRule,
} from "./redactForStatelog.js";
import { DEFAULT_MAX_VALUE_CHARS } from "./trimStatelogEvent.js";

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
    expect(stringifyStatelogEvent(event, [omitBinaryRule], DEFAULT_MAX_VALUE_CHARS)).toBe(
      JSON.stringify(event),
    );
  });

  it("applies the rules inside data but never to envelope fields", () => {
    const gs = new GlobalStore();
    gs.markRedacted("trace");
    const text = stringifyStatelogEvent(
      envelope({ type: "toolCall", note: "trace" }),
      [redactRule(gs)],
      DEFAULT_MAX_VALUE_CHARS,
    );
    expect(JSON.parse(text)).toMatchObject({
      trace_id: "trace",
      data: { note: "[REDACTED]" },
    });
  });

  it("omits picture bytes inside data", () => {
    const picture = Buffer.alloc(6000, 7).toString("base64");
    const text = stringifyStatelogEvent(
      envelope({ type: "agentStart", args: { picture } }),
      [omitBinaryRule],
      DEFAULT_MAX_VALUE_CHARS,
    );
    expect(text).not.toContain(picture);
    expect(JSON.parse(text).data.args.picture).toBe("[base64: 6000 bytes omitted]");
  });

  it("redacts a secret in a URL query with or without a tag store", () => {
    const event = envelope({
      type: "handlerDecision",
      interrupt: { data: { path: "s?api_key=SENTINEL" } },
    });
    for (const rules of [statelogScrubRules(new GlobalStore()), statelogScrubRules(undefined)]) {
      const text = stringifyStatelogEvent(event, rules, DEFAULT_MAX_VALUE_CHARS);
      expect(text).not.toContain("SENTINEL");
      expect(JSON.parse(text).data.interrupt.data.path).toBe("s?api_key=[REDACTED]");
    }
  });
});

describe("urlSecretRule", () => {
  const scrub = (body: unknown): unknown =>
    JSON.parse(JSON.stringify(body, makeScrubReplacer([urlSecretRule])));

  it("redacts a secret parameter in a path and keeps the other parameters", () => {
    const interrupt = {
      effect: "std::http::fetchJSON",
      data: {
        baseUrl: "https://api.stlouisfed.org/fred",
        path: "series?series_id=GDP&api_key=SENTINEL&file_type=json",
      },
    };
    expect(scrub(interrupt)).toEqual({
      effect: "std::http::fetchJSON",
      data: {
        baseUrl: "https://api.stlouisfed.org/fred",
        path: "series?series_id=GDP&api_key=[REDACTED]&file_type=json",
      },
    });
  });

  it.each(["api_key", "apikey", "access_token", "token", "key", "client_secret", "signature"])(
    "redacts %s as the first parameter of a whole URL",
    (name) => {
      expect(scrub(`https://example.com/data?${name}=SENTINEL#top`)).toBe(
        `https://example.com/data?${name}=[REDACTED]#top`,
      );
    },
  );

  it("redacts every secret parameter in one string, whatever its case", () => {
    expect(scrub("see https://a.com/x?API_KEY=one&n=2 and https://b.com/y?n=1&Token=two")).toBe(
      "see https://a.com/x?API_KEY=[REDACTED]&n=2 and https://b.com/y?n=1&Token=[REDACTED]",
    );
  });

  it("leaves a parameter whose name only ends with a secret name", () => {
    const url = "https://example.com/search?monkey=banana&sort_key=name&page=2";
    expect(scrub(url)).toBe(url);
  });

  it("leaves text with no query parameter", () => {
    expect(scrub({ note: "key=value", n: 1 })).toEqual({ note: "key=value", n: 1 });
  });
});

describe("stringifyStatelogEvent size cap", () => {
  const CAP = 1000;
  const envelope = (data: Record<string, unknown>) => ({
    format_version: 1,
    trace_id: "trace",
    project_id: "project",
    span_id: null,
    parent_span_id: null,
    data,
  });
  const logged = (data: Record<string, unknown>, rules: ScrubRule[] = [], cap = CAP) =>
    JSON.parse(stringifyStatelogEvent(envelope(data), rules, cap));

  it("cuts a string over the cap and reports the count removed", () => {
    const original = "x".repeat(CAP + 1234);
    const output: string = logged({ type: "toolCall", output: original }).data.output;
    const [, kept, removed] = output.match(/^(x+)…\[truncated ([\d,]+) chars\]$/) ?? [];
    expect(output.length).toBeLessThanOrEqual(CAP);
    expect(kept.length + Number(removed.replace(",", ""))).toBe(original.length);
  });

  it("cuts a long string that holds a redacted secret, and keeps the secret out", () => {
    const gs = new GlobalStore();
    gs.markRedacted("sk-secret");
    const output = `sk-secret ${"x".repeat(CAP * 2)}`;
    const data = logged({ type: "toolCall", output }, [redactRule(gs)]);
    expect(data.data.output.startsWith("[REDACTED] x")).toBe(true);
    expect(data.data.output).toContain("…[truncated");
    expect(JSON.stringify(data)).not.toContain("sk-secret");
  });

  it("cuts a long string that came from a toJSON method", () => {
    const value = { toJSON: () => "y".repeat(CAP * 2) };
    const data = logged({ type: "toolCall", output: value });
    expect(data.data.output).toMatch(/…\[truncated [\d,]+ chars\]$/);
    expect(data.data.output.length).toBeLessThanOrEqual(CAP);
  });

  it("writes an event under the cap byte-for-byte as before", () => {
    const event = envelope({ type: "toolCall", args: { city: "Mumbai" }, when: new Date(0) });
    expect(stringifyStatelogEvent(event, [], CAP)).toBe(JSON.stringify(event));
  });

  it("writes an event over the cap with no field over it byte-for-byte as before", () => {
    // JSON.parse puts integer-like keys first, so a needless rewrite would
    // move "10" ahead of "b".
    const fields = { b: "z".repeat(600), "10": "z".repeat(600) };
    const event = envelope({ type: "toolCall", ...fields });
    expect(stringifyStatelogEvent(event, [], CAP)).toBe(JSON.stringify(event));
  });

  it("trims one oversized field and keeps the others whole", () => {
    const rows = Array.from({ length: 500 }, (_unused, index) => ({ index }));
    const data = logged({ type: "agentEnd", entryNode: "main", result: rows, timeTaken: 5 });
    expect(data.data.entryNode).toBe("main");
    expect(data.data.timeTaken).toBe(5);
    expect(data.data.result.at(-1)).toMatch(/^\[truncated: \d+ more items\]$/);
    expect(data.data.truncated).toBe(true);
  });

  it("keeps a redacted value redacted inside an oversized field", () => {
    const gs = new GlobalStore();
    const creds = { user: "a", pass: "b" };
    gs.markRedacted(creds);
    const rows = [creds, ...Array.from({ length: 500 }, (_unused, index) => index)];
    const data = logged({ type: "agentEnd", result: rows }, [redactRule(gs)]);
    expect(data.data.result[0]).toBe("[REDACTED]");
    expect(data.data.truncated).toBe(true);
  });

  it("turns both caps off with 0", () => {
    const output = "x".repeat(CAP * 3);
    const rows = Array.from({ length: 2000 }, (_unused, index) => index);
    const event = envelope({ type: "agentEnd", output, result: rows });
    expect(stringifyStatelogEvent(event, [], 0)).toBe(JSON.stringify(event));
  });

  it("logs a 40,000-character return value whole under the default cap", () => {
    const result = "w".repeat(40_000);
    const data = logged({ type: "agentEnd", result }, [], DEFAULT_MAX_VALUE_CHARS);
    expect(data.data.result).toBe(result);
    expect(data.data).not.toHaveProperty("truncated");
  });

  it("logs a promptCompletion's messages whole, with each long string cut", () => {
    const messages = Array.from({ length: 50 }, (_unused, index) => ({
      role: "user",
      content: `${index} ${"m".repeat(CAP * 2)}`,
    }));
    const data = logged({ type: "promptCompletion", messages, usage: { totalTokens: 9 } });
    expect(data.data.messages).toHaveLength(50);
    expect(data.data.messages[49].content.startsWith("49 m")).toBe(true);
    expect(data.data.messages[49].content).toContain("…[truncated");
    expect(data.data.usage).toEqual({ totalTokens: 9 });
  });
});

describe("omitCheckpointRule", () => {
  const scrub = (body: unknown) =>
    JSON.parse(JSON.stringify(body, makeScrubReplacer([omitCheckpointRule])));
  const checkpoint = { id: 7, stack: { frames: [{ args: { tools: ["a", "b"] } }] } };

  it("logs an interrupt's checkpoint as its id", () => {
    const interrupt = { type: "interrupt", effect: "std::read", checkpointId: 3, checkpoint };
    expect(scrub({ data: [interrupt] })).toEqual({
      data: [
        { type: "interrupt", effect: "std::read", checkpointId: 3, checkpoint: "[checkpoint 3]" },
      ],
    });
  });

  it("logs a failure result's checkpoint by the checkpoint's own id", () => {
    const failure = { __type: "resultType", success: false, error: "boom", checkpoint };
    expect(scrub({ result: failure }).result.checkpoint).toBe("[checkpoint 7]");
  });

  it("writes a bare marker when there is no id", () => {
    const interrupt = { type: "interrupt", checkpoint: { stack: {} } };
    expect(scrub(interrupt).checkpoint).toBe("[checkpoint]");
  });

  it("logs a failure result with no checkpoint as it is", () => {
    const failure = { __type: "resultType", success: false, error: "boom", checkpoint: null };
    expect(scrub(failure)).toEqual(failure);
  });

  it("logs a checkpoint key on any other object whole", () => {
    const success = { __type: "resultType", success: true, checkpoint };
    const other = { kind: "note", checkpoint };
    expect(scrub(success).checkpoint).toEqual(checkpoint);
    expect(scrub(other).checkpoint).toEqual(checkpoint);
  });

  it("leaves the interrupt itself holding its checkpoint", () => {
    const interrupt = { type: "interrupt", checkpointId: 3, checkpoint };
    scrub(interrupt);
    expect(interrupt.checkpoint).toBe(checkpoint);
  });
});
