import { describe, expect, it } from "vitest";
import { compileGrepQuery, type GrepQuery } from "./grepQuery.js";

const query = (overrides: Partial<GrepQuery>): GrepQuery => ({
  pattern: "hello",
  flags: "",
  ignoreCase: false,
  wholeWord: false,
  filesOnly: false,
  invert: false,
  ...overrides,
});

describe("compileGrepQuery", () => {
  it("passes JavaScript regex flags through", () => {
    expect(compileGrepQuery(query({ flags: "im" })).regex.flags).toBe("im");
  });

  it("drops the grep letters the tool already satisfies", () => {
    expect(compileGrepQuery(query({ flags: "n" })).regex.flags).toBe("");
    expect(compileGrepQuery(query({ flags: "rn" })).regex.flags).toBe("");
    expect(compileGrepQuery(query({ flags: "gni" })).regex.flags).toBe("i");
  });

  it("ignores a repeated letter", () => {
    expect(compileGrepQuery(query({ flags: "ii" })).regex.flags).toBe("i");
  });

  it("points a grep letter with a named parameter at that parameter", () => {
    expect(() => compileGrepQuery(query({ flags: "l" }))).toThrow(
      'grep does not take the flag "l". Pass filesOnly: true instead.',
    );
    expect(() => compileGrepQuery(query({ flags: "nw" }))).toThrow("Pass wholeWord: true instead.");
    expect(() => compileGrepQuery(query({ flags: "v" }))).toThrow("Pass invert: true instead.");
  });

  it("names the accepted letters when the flag is unknown", () => {
    expect(() => compileGrepQuery(query({ flags: "x" }))).toThrow(
      'grep does not take the flag "x". flags holds JavaScript regex flags (i, m, s, u)',
    );
  });

  it("ignoreCase adds i once, whether or not the flag was also given", () => {
    expect(compileGrepQuery(query({ ignoreCase: true })).regex.flags).toBe("i");
    expect(compileGrepQuery(query({ ignoreCase: true, flags: "i" })).regex.flags).toBe("i");
  });

  it("wholeWord wraps the pattern in word boundaries", () => {
    const plan = compileGrepQuery(query({ pattern: "cat|dog", wholeWord: true }));
    expect(plan.regex.test("a dog here")).toBe(true);
    expect(plan.regex.test("category")).toBe(false);
  });

  it("carries the output switches through", () => {
    const plan = compileGrepQuery(query({ filesOnly: true, invert: true }));
    expect(plan.filesOnly).toBe(true);
    expect(plan.invert).toBe(true);
  });

  it("still rejects a bad pattern", () => {
    expect(() => compileGrepQuery(query({ pattern: "(" }))).toThrow("Invalid regular expression");
  });
});
