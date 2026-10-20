import { describe, it, expect } from "vitest";
import { SourceMapBuilder } from "./sourceMap.js";

describe("SourceMapBuilder", () => {
  it("records entries and builds correct structure", () => {
    const builder = new SourceMapBuilder();
    builder.enterScope("foo.agency", "main");
    builder.record([0], { line: 1, col: 2, start: 0, end: 10 });
    builder.record([1], { line: 3, col: 2, start: 20, end: 30 });

    const result = builder.build();
    expect(result).toEqual({
      "foo.agency:main": {
        "0": { line: 1, col: 2 },
        "1": { line: 3, col: 2 },
      },
    });
  });

  it("handles multiple scopes", () => {
    const builder = new SourceMapBuilder();
    builder.enterScope("foo.agency", "main");
    builder.record([0], { line: 1, col: 2, start: 0, end: 10 });
    builder.enterScope("foo.agency", "greet");
    builder.record([0], { line: 5, col: 2, start: 50, end: 60 });

    const result = builder.build();
    expect(result).toHaveProperty("foo.agency:main");
    expect(result).toHaveProperty("foo.agency:greet");
  });

  it("silently skips undefined loc", () => {
    const builder = new SourceMapBuilder();
    builder.enterScope("foo.agency", "main");
    builder.record([0], undefined);
    builder.record([1], { line: 3, col: 2, start: 20, end: 30 });

    const result = builder.build();
    expect(result["foo.agency:main"]).toEqual({
      "1": { line: 3, col: 2 },
    });
  });

  it("formats substep paths with dot separator", () => {
    const builder = new SourceMapBuilder();
    builder.enterScope("foo.agency", "main");
    builder.record([2, 0, 1], { line: 10, col: 4, start: 100, end: 120 });

    const result = builder.build();
    expect(result["foo.agency:main"]).toHaveProperty("2.0.1");
  });

  it("records a block's statements relative to the block, and returns to the scope around it", () => {
    const builder = new SourceMapBuilder();
    builder.enterScope("foo.agency", "main");
    builder.record([2], { line: 3, col: 2, start: 0, end: 10 });
    // The fork body at statement 2 runs under its own runner, so its
    // first statement is step 0 there, not 2.0.
    builder.enterBlockScope("foo.agency", "__block_0", 1);
    builder.record([2, 0], { line: 4, col: 4, start: 20, end: 30 });
    builder.record([2, 1, 0], { line: 5, col: 6, start: 40, end: 50 });
    builder.exitBlockScope();
    builder.record([3], { line: 8, col: 2, start: 60, end: 70 });

    const result = builder.build();
    expect(result["foo.agency:__block_0"]).toEqual({
      "0": { line: 4, col: 4 },
      "1.0": { line: 5, col: 6 },
    });
    expect(result["foo.agency:main"]).toEqual({
      "2": { line: 3, col: 2 },
      "3": { line: 8, col: 2 },
    });
  });

  it("returns empty object when nothing recorded", () => {
    const builder = new SourceMapBuilder();
    expect(builder.build()).toEqual({});
  });

  it("build returns a copy, not the internal reference", () => {
    const builder = new SourceMapBuilder();
    builder.enterScope("foo.agency", "main");
    builder.record([0], { line: 1, col: 2, start: 0, end: 10 });

    const result1 = builder.build();
    result1["foo.agency:main"]["0"].line = 999;

    const result2 = builder.build();
    expect(result2["foo.agency:main"]["0"].line).toBe(1);
  });
});
