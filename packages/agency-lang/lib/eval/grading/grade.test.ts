import { describe, expect, it } from "vitest";
import { binary, scalar } from "./grade.js";

describe("grade constructors", () => {
  it("scalar builds a scalar grade, with optional feedback", () => {
    expect(scalar(0.7)).toEqual({ score: { kind: "scalar", value: 0.7 } });
    expect(scalar(0.7, "close")).toEqual({ score: { kind: "scalar", value: 0.7 }, feedback: "close" });
  });

  it("binary builds a binary grade, with optional feedback", () => {
    expect(binary(true)).toEqual({ score: { kind: "binary", pass: true } });
    expect(binary(false, "no match")).toEqual({ score: { kind: "binary", pass: false }, feedback: "no match" });
  });

  it("omits feedback entirely when not provided (not feedback: undefined)", () => {
    expect("feedback" in scalar(1)).toBe(false);
  });
});
