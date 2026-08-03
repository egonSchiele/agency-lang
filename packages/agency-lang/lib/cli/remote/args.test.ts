import { describe, it, expect } from "vitest";
import { buildArgs } from "./args.js";

describe("buildArgs", () => {
  it("JSON-coerces --arg values, keeping non-JSON as strings", () => {
    expect(buildArgs({ arg: ["count=3", "flag=true", "msg=hi"] })).toEqual({
      count: 3,
      flag: true,
      msg: "hi",
    });
  });

  it("keeps a value with an = sign intact (splits on the first =)", () => {
    expect(buildArgs({ arg: ["expr=a=b"] })).toEqual({ expr: "a=b" });
  });

  it("layers --arg over a --data base object", () => {
    expect(buildArgs({ data: '{"a":1,"b":2}', arg: ["a=9"] })).toEqual({ a: 9, b: 2 });
  });

  it("returns an empty object with no flags", () => {
    expect(buildArgs({})).toEqual({});
  });

  it("throws on a malformed --arg (no =)", () => {
    expect(() => buildArgs({ arg: ["noequals"] })).toThrow();
  });

  it("throws when --data is not a JSON object", () => {
    expect(() => buildArgs({ data: "[1,2]" })).toThrow();
    expect(() => buildArgs({ data: "not json" })).toThrow();
  });
});
