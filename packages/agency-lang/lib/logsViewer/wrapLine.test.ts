import { describe, it, expect } from "vitest";
import { wrapLine } from "./wrapLine.js";
describe("wrapLine", () => {
  it("returns the input unchanged when it fits", () => {
    expect(wrapLine("hello", 10)).toEqual(["hello"]);
  });

  it("breaks at the last space at or before width", () => {
    expect(wrapLine("one two three four", 10)).toEqual(["one two", "three four"]);
  });

  it("hard-breaks mid-word when no space is in range", () => {
    expect(wrapLine("supercalifragilistic", 6)).toEqual(["superc", "alifra", "gilist", "ic"]);
  });

  it("returns a single-element list for width <= 0", () => {
    expect(wrapLine("abc", 0)).toEqual(["abc"]);
  });
});
