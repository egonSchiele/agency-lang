import { describe, it, expect } from "vitest";
import { interruptStatementParser, interruptExprParser } from "./parsers.js";

describe("interruptStatementParser", () => {
  it("parses interrupt with namespace kind and two arguments", () => {
    const input = 'interrupt std::read("Are you sure?", { filename: "foo" })';
    const result = interruptStatementParser(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.type).toBe("interruptStatement");
    expect(result.result.kind).toBe("std::read");
    expect(result.result.arguments).toHaveLength(2);
  });

  it("parses interrupt with namespace kind and one argument", () => {
    const input = 'interrupt std::read("msg")';
    const result = interruptStatementParser(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.kind).toBe("std::read");
    expect(result.result.arguments).toHaveLength(1);
  });

  it("parses user-defined namespace", () => {
    const input = 'interrupt myapp::deploy("msg", { env: "prod" })';
    const result = interruptStatementParser(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.kind).toBe("myapp::deploy");
    expect(result.result.arguments).toHaveLength(2);
  });

  it("parses multi-level namespace", () => {
    const input = 'interrupt std::http::fetch("msg")';
    const result = interruptStatementParser(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.kind).toBe("std::http::fetch");
    expect(result.result.arguments).toHaveLength(1);
  });

  it("does NOT match bare interrupt (no namespace)", () => {
    const input = 'interrupt("msg")';
    const result = interruptStatementParser(input);
    expect(result.success).toBe(false);
  });
});

describe("interruptExprParser", () => {
  it("parses interrupt expression without consuming trailing content", () => {
    const input = 'interrupt std::read("msg")';
    const result = interruptExprParser(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.type).toBe("interruptStatement");
    expect(result.result.kind).toBe("std::read");
  });
});
