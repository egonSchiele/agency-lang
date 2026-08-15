import { describe, it, expect } from "vitest";
import { redactValues } from "./redact.js";

describe("redactValues", () => {
  it("replaces a single occurrence", () => {
    expect(redactValues("key=sk-123 sent", ["sk-123"])).toBe("key=[redacted] sent");
  });

  it("replaces every occurrence of every value", () => {
    expect(redactValues("a=X b=Y a=X", ["X", "Y"])).toBe("a=[redacted] b=[redacted] a=[redacted]");
  });

  it("skips empty values (they would match everywhere)", () => {
    expect(redactValues("untouched", [""])).toBe("untouched");
  });

  it("treats regex metacharacters as literal text", () => {
    expect(redactValues("token .*+?[]() end", [".*+?[]()"])).toBe("token [redacted] end");
  });

  it("is identity for an empty values array", () => {
    expect(redactValues("as-is", [])).toBe("as-is");
  });

  it("replaces longer values before their prefixes so no suffix leaks", () => {
    const long = "prefix-SENSITIVE-SUFFIX";
    const short = "prefix";
    expect(redactValues(`echo ${long} end`, [short, long])).toBe("echo [redacted] end");
    expect(redactValues(`echo ${long} end`, [short, long])).not.toContain("SENSITIVE");
  });
});
