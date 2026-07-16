import { describe, it, expect } from "vitest";
import { finalizeBlockParser, bodyParser } from "./parsers.js";
import { normalizeCode } from "@/index.js";

describe("finalizeBlockParser", () => {
  it("parses a finalize block with a return", () => {
    const result = finalizeBlockParser(normalizeCode(`finalize {\n  return "a"\n}`));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.type).toBe("finalizeBlock");
      expect(result.result.body).toHaveLength(1);
    }
  });

  it("parses inside a def body, landing a finalizeBlock node in the body", () => {
    const result = bodyParser(
      normalizeCode(`saveDraft("d")\nfinalize {\n  return "a"\n}`),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const kinds = result.result.map((n) => n.type);
      expect(kinds).toContain("finalizeBlock");
    }
  });

  it("does not match `finalize` as a prefix of an identifier like `finalizer`", () => {
    const result = bodyParser(normalizeCode("finalizer(data)\n"));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.map((n) => n.type)).toContain("functionCall");
    }
  });

  it("parses a multi-statement body, an empty finalize, and finalize-not-last", () => {
    expect(
      finalizeBlockParser(
        normalizeCode(`finalize {\n  const a = 1\n  return a\n}`),
      ).success,
    ).toBe(true);
    expect(finalizeBlockParser(normalizeCode(`finalize {\n}`)).success).toBe(
      true,
    );
    const notLast = bodyParser(
      normalizeCode(`finalize {\n  return "a"\n}\nsaveDraft("d")`),
    );
    expect(notLast.success).toBe(true);
    if (notLast.success) {
      expect(notLast.result.map((n) => n.type)).toContain("finalizeBlock");
    }
  });
});
