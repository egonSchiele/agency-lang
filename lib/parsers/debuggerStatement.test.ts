import { describe, it, expect } from "vitest";
import { debuggerParser } from "./debuggerStatement.js";
import { parseAgency } from "../parser.js";

describe("debuggerParser", () => {
  it("parses debugger with label", () => {
    const result = debuggerParser('debugger("checking mood")');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.result).toEqualWithoutLoc({
      type: "debuggerStatement",
      label: "checking mood",
    });
  });

  it("parses debugger with single-quoted label", () => {
    const result = debuggerParser("debugger('my label')");
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.result).toEqualWithoutLoc({
      type: "debuggerStatement",
      label: "my label",
    });
  });

  it("does not parse debuggerFoo as debugger", () => {
    const result = debuggerParser("debuggerFoo");
    expect(result.success).toBe(false);
  });

  it("parses debugger in a node body", () => {
    const code = `node main() {\n  debugger()\n  debugger("label")\n  return 1\n}`;
    const result = parseAgency(code, {}, false);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    const nodeBody = (result.result.nodes[0] as any).body;
    const debuggerNodes = nodeBody.filter(
      (n: any) => n.type === "debuggerStatement",
    );
    expect(debuggerNodes.length).toBe(2);
    expect(debuggerNodes[0].type).toBe("debuggerStatement");
    expect(debuggerNodes[0].label).toBeUndefined();
    expect(debuggerNodes[1].type).toBe("debuggerStatement");
    expect(debuggerNodes[1].label).toBe("label");
  });
});
