import { describe, it, expect } from "vitest";
import { agencyArrayParser, agencyObjectParser } from "./parsers.js";

/** Whole-input parse helpers: success means the parser consumed the
 *  entire literal, matching how these parsers are driven in tests
 *  elsewhere in this directory. */
const arrayOk = (src: string) => {
  const r = agencyArrayParser(src);
  return r.success && r.rest === "";
};
const objectOk = (src: string) => {
  const r = agencyObjectParser(src);
  return r.success && r.rest === "";
};

describe("literal items require commas between them", () => {
  it("parses ordinary comma-separated arrays and objects", () => {
    expect(arrayOk("[1, 2, 3]")).toBe(true);
    expect(arrayOk("[]")).toBe(true);
    expect(objectOk(`{ "a": 1, "b": 2 }`)).toBe(true);
    expect(objectOk("{}")).toBe(true);
  });

  it("keeps trailing commas", () => {
    expect(arrayOk("[1, 2, 3,]")).toBe(true);
    expect(objectOk(`{ "a": 1, "b": 2, }`)).toBe(true);
  });

  it("keeps multi-line literals with commas", () => {
    expect(arrayOk("[\n  1,\n  2,\n  3\n]")).toBe(true);
    expect(objectOk(`{\n  "a": 1,\n  "b": 2\n}`)).toBe(true);
  });

  it("keeps splats", () => {
    expect(arrayOk("[...xs, 1]")).toBe(true);
  });

  // The 2026-07-04 comments-between-entries rewrite made the comma
  // optional EVERYWHERE, so any whitespace separated items and
  // `[x for x in]` parsed as a four-item array of variable names
  // (#602). These pin the restoration of the required comma.
  it("rejects whitespace-separated array items", () => {
    expect(arrayOk("[1 2 3]")).toBe(false);
    expect(arrayOk("[x for x in]")).toBe(false);
    expect(arrayOk("[\n  1\n  2\n]")).toBe(false);
  });

  it("rejects whitespace-separated object entries", () => {
    expect(objectOk(`{ "a": 1 "b": 2 }`)).toBe(false);
  });

  it("rejects a comment interposed between comma-less items", () => {
    // the trailing-position lookahead only accepts trivia followed by
    // the CLOSER - a comment cannot smuggle in a missing comma
    expect(arrayOk("[1 // note\n 2]")).toBe(false);
  });

  // The comment placements the rewrite legitimately added, all pinned
  // in dataStructures.test.ts too - re-asserted here beside the
  // rejections so the whole delimiter contract reads in one place.
  it("keeps comments after a comma", () => {
    expect(arrayOk("[\n  1,\n  // keep me\n  2\n]")).toBe(true);
    expect(objectOk(`{\n  "a": 1,\n  // keep me\n  "b": 2\n}`)).toBe(true);
  });

  it("keeps trailing comments without a trailing comma", () => {
    expect(objectOk(`{\n  // lead\n  "a": 1\n  // trail\n}`)).toBe(true);
    expect(arrayOk("[\n  1\n  // trail\n]")).toBe(true);
  });
});
