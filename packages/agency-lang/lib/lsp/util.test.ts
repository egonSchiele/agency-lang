import { describe, it, expect } from "vitest";
import { findAllOccurrences, escapeRegExp } from "./util.js";

describe("findAllOccurrences", () => {
  it("finds all whole-word matches", () => {
    const source = "let foo = 1\nprint(foo)\nlet foobar = foo";
    const result = findAllOccurrences(source, "foo");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ line: 0, character: 4, length: 3 });
    expect(result[1]).toEqual({ line: 1, character: 6, length: 3 });
    expect(result[2]).toEqual({ line: 2, character: 13, length: 3 });
  });

  it("does not match partial words", () => {
    const source = "let foobar = 1";
    const result = findAllOccurrences(source, "foo");
    expect(result).toHaveLength(0);
  });
});

describe("escapeRegExp", () => {
  it("escapes special characters", () => {
    expect(escapeRegExp("foo.bar")).toBe("foo\\.bar");
  });
});
