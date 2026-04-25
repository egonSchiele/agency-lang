import { describe, it, expect } from "vitest";
import { getWordAtPosition, collectDefinitions, findDefinition } from "./definition.js";
import { parseAgency } from "../parser.js";

describe("getWordAtPosition", () => {
  const source = `node main() {
  result = greet("hello")
  return result
}`;

  it("extracts a word at cursor position", () => {
    // "result" starts at line 1, col 2
    expect(getWordAtPosition(source, 1, 2)).toBe("result");
  });

  it("extracts word when cursor is in the middle", () => {
    // "greet" is at line 1, col 11
    expect(getWordAtPosition(source, 1, 13)).toBe("greet");
  });

  it("returns null for whitespace", () => {
    expect(getWordAtPosition(source, 1, 0)).toBe(null);
  });

  it("returns null for special characters", () => {
    // "(" at line 0, col 9
    expect(getWordAtPosition(source, 0, 9)).toBe(null);
  });

  it("returns null for out of bounds line", () => {
    expect(getWordAtPosition(source, 99, 0)).toBe(null);
  });

  it("returns null for out of bounds column", () => {
    expect(getWordAtPosition(source, 0, 99)).toBe(null);
  });

  it("extracts word at the start of a line", () => {
    // "node" starts at line 0, col 0
    expect(getWordAtPosition(source, 0, 0)).toBe("node");
  });

  it("extracts word at the end of a line", () => {
    // "result" at line 2, col 9
    expect(getWordAtPosition(source, 2, 9)).toBe("result");
  });
});

describe("collectDefinitions", () => {
  it("collects node definitions", () => {
    const source = `node main() {
  return 1
}`;
    const result = parseAgency(source, {}, true);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const defs = collectDefinitions(result.result);
    expect(defs["main"]).toBeDefined();
    expect(defs["main"].line).toBeTypeOf("number");
  });

  it("collects function definitions", () => {
    const source = `def greet(name: string) {
  return name
}`;
    const result = parseAgency(source, {}, true);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const defs = collectDefinitions(result.result);
    expect(defs["greet"]).toBeDefined();
  });

  it("collects type alias definitions", () => {
    const source = `type Category = "a" | "b"`;
    const result = parseAgency(source, {}, true);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const defs = collectDefinitions(result.result);
    expect(defs["Category"]).toBeDefined();
  });

  it("returns empty map for no definitions", () => {
    const source = `x = 1`;
    const result = parseAgency(source, {}, true);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const defs = collectDefinitions(result.result);
    expect(Object.keys(defs).length).toBe(0);
  });
});

describe("findDefinition", () => {
  it("finds a node definition", () => {
    const source = `node greet() {
  return 1
}
node main() {
  return greet()
}`;
    // cursor on "greet" in "return greet()" — line 4, col 9
    const result = findDefinition(source, 4, 9, "test.agency");
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.file).toBe("test.agency");
    expect(result.line).toBeTypeOf("number");
  });

  it("finds a function definition", () => {
    const source = `def helper() {
  return 1
}
node main() {
  x = helper()
  return x
}`;
    // cursor on "helper" in "x = helper()" — line 4, col 6
    const result = findDefinition(source, 4, 6, "test.agency");
    expect(result).not.toBeNull();
  });

  it("finds a type alias definition", () => {
    const source = `type Status = "ok" | "error"
node main() {
  s: Status = "ok"
  return s
}`;
    // cursor on "Status" in "s: Status" — line 2, col 5
    const result = findDefinition(source, 2, 5, "test.agency");
    expect(result).not.toBeNull();
  });

  it("returns null for undefined symbol", () => {
    const source = `node main() {
  x = unknownFunc()
  return x
}`;
    // cursor on "unknownFunc" — line 1, col 6
    const result = findDefinition(source, 1, 6, "test.agency");
    expect(result).toBeNull();
  });

  it("returns null for whitespace", () => {
    const source = `node main() {
  return 1
}`;
    // cursor on whitespace — line 1, col 0
    const result = findDefinition(source, 1, 0, "test.agency");
    expect(result).toBeNull();
  });

  it("returns null for keywords", () => {
    const source = `node main() {
  return 1
}`;
    // cursor on "return" — line 1, col 2. "return" is not a definition.
    const result = findDefinition(source, 1, 2, "test.agency");
    expect(result).toBeNull();
  });
});
