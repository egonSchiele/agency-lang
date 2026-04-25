import { describe, it, expect } from "vitest";
import { gotoStatementParser } from "./parsers.js";

describe("gotoStatementParser", () => {
  it("should parse goto with a function call", () => {
    const result = gotoStatementParser("goto foo()");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toMatchObject({
        type: "gotoStatement",
        nodeCall: {
          type: "functionCall",
          functionName: "foo",
          arguments: [],
        },
      });
    }
  });

  it("should parse goto with arguments", () => {
    const result = gotoStatementParser("goto categorize(msg, 42)");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toMatchObject({
        type: "gotoStatement",
        nodeCall: {
          type: "functionCall",
          functionName: "categorize",
        },
      });
      expect(result.result.nodeCall.arguments).toHaveLength(2);
    }
  });

  it("should parse goto with optional semicolon", () => {
    const result = gotoStatementParser("goto foo();");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.type).toBe("gotoStatement");
    }
  });

  it("should fail on goto without a function call", () => {
    const result = gotoStatementParser("goto 5");
    expect(result.success).toBe(false);
  });

  it("should fail on goto with just a variable name", () => {
    const result = gotoStatementParser("goto myVar");
    expect(result.success).toBe(false);
  });

  it("should fail on bare goto", () => {
    const result = gotoStatementParser("goto");
    expect(result.success).toBe(false);
  });
});
