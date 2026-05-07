import { describe, it, expect } from "vitest";
import { typeCheck } from "./index.js";
import { AgencyProgram, UnitLiteral } from "../types.js";

function unitLit(value: string, unit: UnitLiteral["unit"], canonicalValue: number, dimension: "time" | "cost"): UnitLiteral {
  return { type: "unitLiteral", value, unit, canonicalValue, dimension };
}

function programWithBinOp(op: string, left: any, right: any): AgencyProgram {
  return {
    type: "agencyProgram",
    nodes: [
      {
        type: "assignment",
        variableName: "x",
        value: {
          type: "binOpExpression",
          operator: op,
          left,
          right,
        },
      },
    ],
  };
}

describe("dimension mismatch detection", () => {
  it("allows same-dimension time operations", () => {
    const program = programWithBinOp("+", unitLit("1", "s", 1000, "time"), unitLit("500", "ms", 500, "time"));
    const { errors } = typeCheck(program);
    expect(errors).toHaveLength(0);
  });

  it("errors on time + cost", () => {
    const program = programWithBinOp("+", unitLit("1", "s", 1000, "time"), unitLit("5.00", "$", 5, "cost"));
    const { errors } = typeCheck(program);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("dimensions");
  });

  it("errors on time > cost", () => {
    const program = programWithBinOp(">", unitLit("30", "s", 30000, "time"), unitLit("2.00", "$", 2, "cost"));
    const { errors } = typeCheck(program);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("allows time * plain number (no check)", () => {
    const program = programWithBinOp("*", unitLit("30", "s", 30000, "time"), { type: "number", value: "2" });
    const { errors } = typeCheck(program);
    expect(errors).toHaveLength(0);
  });

  it("allows time + plain number (no check)", () => {
    const program = programWithBinOp("+", unitLit("1", "s", 1000, "time"), { type: "number", value: "42" });
    const { errors } = typeCheck(program);
    expect(errors).toHaveLength(0);
  });

  it("allows same-dimension comparisons across units", () => {
    const program = programWithBinOp("==", unitLit("1", "h", 3600000, "time"), unitLit("60", "m", 3600000, "time"));
    const { errors } = typeCheck(program);
    expect(errors).toHaveLength(0);
  });
});
