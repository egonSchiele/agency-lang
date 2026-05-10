import { describe, it, expect } from "vitest";
import { typeCheck } from "./index.js";
import { AgencyProgram, UnitLiteral, TimeUnitLiteral, CostUnitLiteral, ByteUnitLiteral } from "../types.js";
import { Operator } from "../types/binop.js";

function timeLit(value: string, unit: TimeUnitLiteral["unit"], canonicalValue: number): TimeUnitLiteral {
  return { type: "unitLiteral", value, unit, canonicalValue, dimension: "time" };
}

function costLit(value: string, canonicalValue: number): CostUnitLiteral {
  return { type: "unitLiteral", value, unit: "$", canonicalValue, dimension: "cost" };
}

function bytesLit(value: string, unit: ByteUnitLiteral["unit"], canonicalValue: number): ByteUnitLiteral {
  return { type: "unitLiteral", value, unit, canonicalValue, dimension: "bytes" };
}

function programWithBinOp(op: Operator, left: any, right: any): AgencyProgram {
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
    const program = programWithBinOp("+", timeLit("1", "s", 1000), timeLit("500", "ms", 500));
    const { errors } = typeCheck(program);
    expect(errors).toHaveLength(0);
  });

  it("errors on time + cost", () => {
    const program = programWithBinOp("+", timeLit("1", "s", 1000), costLit("5.00", 5));
    const { errors } = typeCheck(program);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("dimensions");
  });

  it("errors on time > cost", () => {
    const program = programWithBinOp(">", timeLit("30", "s", 30000), costLit("2.00", 2));
    const { errors } = typeCheck(program);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("allows time * plain number (no check)", () => {
    const program = programWithBinOp("*", timeLit("30", "s", 30000), { type: "number", value: "2" });
    const { errors } = typeCheck(program);
    expect(errors).toHaveLength(0);
  });

  it("allows time + plain number (no check)", () => {
    const program = programWithBinOp("+", timeLit("1", "s", 1000), { type: "number", value: "42" });
    const { errors } = typeCheck(program);
    expect(errors).toHaveLength(0);
  });

  it("allows same-dimension comparisons across units", () => {
    const program = programWithBinOp("==", timeLit("1", "h", 3600000), timeLit("60", "m", 3600000));
    const { errors } = typeCheck(program);
    expect(errors).toHaveLength(0);
  });

  describe("bytes dimension", () => {
    it("allows same-dimension byte operations", () => {
      const program = programWithBinOp("+", bytesLit("1", "mb", 1048576), bytesLit("100", "kb", 102400));
      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });

    it("errors on bytes + time", () => {
      const program = programWithBinOp("+", bytesLit("1", "mb", 1048576), timeLit("1", "s", 1000));
      const { errors } = typeCheck(program);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain("dimensions");
    });

    it("errors on bytes + cost", () => {
      const program = programWithBinOp("+", bytesLit("1", "mb", 1048576), costLit("5.00", 5));
      const { errors } = typeCheck(program);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("allows bytes * plain number (no check)", () => {
      const program = programWithBinOp("*", bytesLit("1", "mb", 1048576), { type: "number", value: "2" });
      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });
  });
});
