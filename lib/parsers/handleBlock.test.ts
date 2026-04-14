import { describe, it, expect } from "vitest";
import { handleBlockParser } from "./parsers.js";
import { normalizeCode } from "@/index.js";

describe("handleBlockParser", () => {
  it("should parse inline handler", () => {
    const input = 'handle {\n  foo()\n} with (data) {\n  return approve()\n}';
    const result = handleBlockParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.type).toBe("handleBlock");
      expect(result.result.handler.kind).toBe("inline");
      if (result.result.handler.kind === "inline") {
        expect(result.result.handler.param.name).toBe("data");
      }
    }
  });

  it("should parse inline handler with typed param", () => {
    const input = 'handle {\n  foo()\n} with (data: string) {\n  return approve()\n}';
    const result = handleBlockParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.handler.kind).toBe("inline");
      if (result.result.handler.kind === "inline") {
        expect(result.result.handler.param.name).toBe("data");
        expect(result.result.handler.param.typeHint).toEqualWithoutLoc({
          type: "primitiveType",
          value: "string",
        });
      }
    }
  });

  it("should parse function ref handler", () => {
    const input = "handle {\n  foo()\n} with myPolicy";
    const result = handleBlockParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.type).toBe("handleBlock");
      expect(result.result.handler.kind).toBe("functionRef");
      if (result.result.handler.kind === "functionRef") {
        expect(result.result.handler.functionName).toBe("myPolicy");
      }
    }
  });

  it("should parse handle block body", () => {
    const input = 'handle {\n  x = 1\n  foo()\n} with (data) {\n  return approve()\n}';
    const result = handleBlockParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success) {
      const bodyTypes = result.result.body.map((n) => n.type);
      expect(bodyTypes).toContain("assignment");
      expect(bodyTypes).toContain("functionCall");
    }
  });

  it("should parse approve with value", () => {
    const input = 'handle {\n  foo()\n} with (data) {\n  return approve("yes")\n}';
    const result = handleBlockParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.handler.kind).toBe("inline");
      if (result.result.handler.kind === "inline") {
        // handler body should contain a return statement
        const returns = result.result.handler.body.filter((n) => n.type === "returnStatement");
        expect(returns.length).toBe(1);
      }
    }
  });

  it("should parse reject with message", () => {
    const input = 'handle {\n  foo()\n} with (data) {\n  return reject("not allowed")\n}';
    const result = handleBlockParser(normalizeCode(input));
    expect(result.success).toBe(true);
  });

  it("should fail without with clause", () => {
    const input = "handle {\n  foo()\n}";
    const result = handleBlockParser(normalizeCode(input));
    expect(result.success).toBe(false);
  });

  it("should fail on empty input", () => {
    const result = handleBlockParser(normalizeCode(""));
    expect(result.success).toBe(false);
  });
});
