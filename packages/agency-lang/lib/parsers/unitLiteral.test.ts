import { describe, it, expect } from "vitest";
import { unitLiteralParser } from "./parsers.js";

describe("unitLiteralParser", () => {
  describe("time units", () => {
    it("parses milliseconds", () => {
      const result = unitLiteralParser("500ms");
      expect(result.success).toBe(true);
      expect(result.result.type).toBe("unitLiteral");
      expect(result.result.unit).toBe("ms");
      expect(result.result.value).toBe("500");
      expect(result.result.canonicalValue).toBe(500);
      expect(result.result.dimension).toBe("time");
    });

    it("parses seconds", () => {
      const result = unitLiteralParser("30s");
      expect(result.success).toBe(true);
      expect(result.result.unit).toBe("s");
      expect(result.result.canonicalValue).toBe(30000);
    });

    it("parses minutes", () => {
      const result = unitLiteralParser("5m");
      expect(result.success).toBe(true);
      expect(result.result.unit).toBe("m");
      expect(result.result.canonicalValue).toBe(300000);
    });

    it("parses hours", () => {
      const result = unitLiteralParser("2h");
      expect(result.success).toBe(true);
      expect(result.result.unit).toBe("h");
      expect(result.result.canonicalValue).toBe(7200000);
    });

    it("parses days", () => {
      const result = unitLiteralParser("7d");
      expect(result.success).toBe(true);
      expect(result.result.unit).toBe("d");
      expect(result.result.canonicalValue).toBe(604800000);
    });

    it("parses weeks", () => {
      const result = unitLiteralParser("1w");
      expect(result.success).toBe(true);
      expect(result.result.unit).toBe("w");
      expect(result.result.canonicalValue).toBe(604800000);
    });

    it("parses decimal time values", () => {
      const result = unitLiteralParser("0.5s");
      expect(result.success).toBe(true);
      expect(result.result.canonicalValue).toBe(500);
    });

    it("leaves remaining input unconsumed", () => {
      const result = unitLiteralParser("30s + 5");
      expect(result.success).toBe(true);
      expect(result.result.canonicalValue).toBe(30000);
      expect(result.rest).toBe(" + 5");
    });
  });

  describe("cost units", () => {
    it("parses dollar cost", () => {
      const result = unitLiteralParser("$5.00");
      expect(result.success).toBe(true);
      expect(result.result.unit).toBe("$");
      expect(result.result.value).toBe("5.00");
      expect(result.result.canonicalValue).toBe(5.00);
      expect(result.result.dimension).toBe("cost");
    });

    it("parses dollar cost without decimals", () => {
      const result = unitLiteralParser("$10");
      expect(result.success).toBe(true);
      expect(result.result.canonicalValue).toBe(10);
    });
  });

  describe("negative cases", () => {
    it("does not parse plain numbers", () => {
      const result = unitLiteralParser("42");
      expect(result.success).toBe(false);
    });

    it("does not parse bare identifiers", () => {
      const result = unitLiteralParser("seconds");
      expect(result.success).toBe(false);
    });

    it("does not parse bare unit suffixes without a number", () => {
      expect(unitLiteralParser("m").success).toBe(false);
      expect(unitLiteralParser("ms").success).toBe(false);
      expect(unitLiteralParser("s").success).toBe(false);
      expect(unitLiteralParser("h").success).toBe(false);
    });

    it("does not conflict with string interpolation", () => {
      const result = unitLiteralParser("${foo}");
      expect(result.success).toBe(false);
    });

    it("does not parse negative numbers (unary minus is separate)", () => {
      const result = unitLiteralParser("-5s");
      expect(result.success).toBe(false);
    });
  });
});
