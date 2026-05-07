import { describe, it, expect } from "vitest";
import { unitLiteralParser } from "./parsers.js";
import { UnitLiteral } from "../types.js";
import { ParserResult } from "tarsec";

function parsed(input: string) {
  const result = unitLiteralParser(input);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error("unreachable");
  return result;
}

describe("unitLiteralParser", () => {
  describe("time units", () => {
    it("parses milliseconds", () => {
      const r = parsed("500ms");
      expect(r.result.type).toBe("unitLiteral");
      expect(r.result.unit).toBe("ms");
      expect(r.result.value).toBe("500");
      expect(r.result.canonicalValue).toBe(500);
      expect(r.result.dimension).toBe("time");
    });

    it("parses seconds", () => {
      const r = parsed("30s");
      expect(r.result.unit).toBe("s");
      expect(r.result.canonicalValue).toBe(30000);
    });

    it("parses minutes", () => {
      const r = parsed("5m");
      expect(r.result.unit).toBe("m");
      expect(r.result.canonicalValue).toBe(300000);
    });

    it("parses hours", () => {
      const r = parsed("2h");
      expect(r.result.unit).toBe("h");
      expect(r.result.canonicalValue).toBe(7200000);
    });

    it("parses days", () => {
      const r = parsed("7d");
      expect(r.result.unit).toBe("d");
      expect(r.result.canonicalValue).toBe(604800000);
    });

    it("parses weeks", () => {
      const r = parsed("1w");
      expect(r.result.unit).toBe("w");
      expect(r.result.canonicalValue).toBe(604800000);
    });

    it("parses decimal time values", () => {
      const r = parsed("0.5s");
      expect(r.result.canonicalValue).toBe(500);
    });

    it("leaves remaining input unconsumed", () => {
      const r = parsed("30s + 5");
      expect(r.result.canonicalValue).toBe(30000);
      expect(r.rest).toBe(" + 5");
    });
  });

  describe("cost units", () => {
    it("parses dollar cost", () => {
      const r = parsed("$5.00");
      expect(r.result.unit).toBe("$");
      expect(r.result.value).toBe("5.00");
      expect(r.result.canonicalValue).toBe(5.00);
      expect(r.result.dimension).toBe("cost");
    });

    it("parses dollar cost without decimals", () => {
      const r = parsed("$10");
      expect(r.result.canonicalValue).toBe(10);
    });
  });

  describe("negative cases", () => {
    it("does not parse plain numbers", () => {
      expect(unitLiteralParser("42").success).toBe(false);
    });

    it("does not parse bare identifiers", () => {
      expect(unitLiteralParser("seconds").success).toBe(false);
    });

    it("does not parse bare unit suffixes without a number", () => {
      expect(unitLiteralParser("m").success).toBe(false);
      expect(unitLiteralParser("ms").success).toBe(false);
      expect(unitLiteralParser("s").success).toBe(false);
      expect(unitLiteralParser("h").success).toBe(false);
    });

    it("does not conflict with string interpolation", () => {
      expect(unitLiteralParser("${foo}").success).toBe(false);
    });

    it("does not parse negative numbers (unary minus is separate)", () => {
      expect(unitLiteralParser("-5s").success).toBe(false);
    });
  });
});
