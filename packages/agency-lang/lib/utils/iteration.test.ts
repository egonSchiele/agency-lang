import { describe, it, expect } from "vitest";
import { classifyIterable } from "./iteration.js";

describe("classifyIterable", () => {
  it("classifies arrays", () => {
    expect(classifyIterable(["a", "b"])).toEqual({ kind: "array" });
    expect(classifyIterable([])).toEqual({ kind: "array" });
  });

  it("classifies objects and returns their keys", () => {
    expect(classifyIterable({ h: "1", p: "2" })).toEqual({
      kind: "record",
      keys: ["h", "p"],
    });
    expect(classifyIterable({})).toEqual({ kind: "record", keys: [] });
  });

  it.each([[null], [undefined], [42], ["abc"], [true]])(
    "classifies %p as not iterable",
    (input) => {
      expect(classifyIterable(input)).toEqual({ kind: "none" });
    },
  );

  it("does not copy the array it classifies", () => {
    // the classifier must not snapshot - Runner.loop depends on holding
    // the caller's array by reference so appends mid-loop are seen
    const xs = [1, 2];
    const shape = classifyIterable(xs);
    expect(shape).toEqual({ kind: "array" });
    expect(Object.keys(shape)).toEqual(["kind"]);
  });
});
