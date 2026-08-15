import { describe, expect, it } from "vitest";

import { checkEligibility, decodeUtf8Strict, describeIngestSkip } from "./eligibility.js";

describe("checkEligibility", () => {
  const limit = { maxBytes: 20 };

  it("accepts ordinary text", () => {
    expect(checkEligibility("a summary", limit)).toBeUndefined();
  });

  it("rejects an empty value", () => {
    expect(checkEligibility("", limit)).toBe("empty");
  });

  it("rejects a whitespace-only value, which has nothing to judge", () => {
    expect(checkEligibility("   \n\t ", limit)).toBe("empty");
  });

  it("rejects a value over the byte cap", () => {
    expect(checkEligibility("x".repeat(21), limit)).toBe("too-large");
  });

  it("measures BYTES, not characters, so multi-byte text is capped honestly", () => {
    // 8 emoji at 4 bytes each is 32 bytes but only 8 code points.
    expect(checkEligibility("🙂".repeat(8), limit)).toBe("too-large");
  });

  it("accepts a value exactly at the cap", () => {
    expect(checkEligibility("x".repeat(20), limit)).toBeUndefined();
  });
});

describe("decodeUtf8Strict", () => {
  it("decodes valid UTF-8", () => {
    expect(decodeUtf8Strict(Buffer.from("héllo", "utf8"))).toBe("héllo");
  });

  it("returns undefined for invalid bytes rather than substituting U+FFFD", () => {
    // Node's default decoder yields "�", which hashes to a stable but
    // meaningless id — a corrupted file would become a labelable record.
    expect(decodeUtf8Strict(Buffer.from([0xff, 0xfe, 0xfd]))).toBeUndefined();
  });

  it("decodes an empty buffer as the empty string", () => {
    expect(decodeUtf8Strict(Buffer.alloc(0))).toBe("");
  });
});

describe("describeIngestSkip", () => {
  it("names the item and explains the reason", () => {
    const line = describeIngestSkip({ item: "a.txt", reason: "empty" });
    expect(line).toContain("a.txt");
    expect(line).toContain("nothing to judge");
  });

  it("has a description for every reason, so no skip prints as undefined", () => {
    const reasons = [
      "empty",
      "too-large",
      "not-utf8",
      "symlink",
      "run-failed",
      "record-unreadable",
      "legacy-record",
      "missing-trace-id",
      "invalid-task",
      "no-output",
      "truncated-output",
    ] as const;
    for (const reason of reasons) {
      expect(describeIngestSkip({ item: "x", reason })).not.toContain("undefined");
    }
  });
});
