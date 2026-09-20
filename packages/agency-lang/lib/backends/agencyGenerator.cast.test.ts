import { describe, expect, it } from "vitest";
import { AgencyGenerator } from "./agencyGenerator.js";
import type { AgencyProgram, CastExpression } from "../types.js";

const xVariable = { type: "variableName", value: "x" } as const;
const person = { type: "typeAliasVariable", aliasName: "Person" } as const;

function print(value: unknown): string {
  const program = {
    type: "agencyProgram",
    nodes: [{ type: "assignment", declKind: "const", variableName: "p", value }],
  } as unknown as AgencyProgram;
  return new AgencyGenerator().generate(program).output.trim();
}

describe("formatting a cast", () => {
  it("prints an unchecked cast", () => {
    const cast: CastExpression = {
      type: "castExpression",
      expression: xVariable,
      targetType: person,
      checked: false,
    };
    expect(print(cast)).toBe("const p = x as Person");
  });

  it("prints a checked cast with a bang", () => {
    const cast: CastExpression = {
      type: "castExpression",
      expression: xVariable,
      targetType: person,
      checked: true,
    };
    expect(print(cast)).toBe("const p = x as Person!");
  });

  it("parenthesizes a binary expression inside a cast", () => {
    const sum = { type: "binOpExpression", operator: "+", left: xVariable, right: xVariable };
    const cast = { type: "castExpression", expression: sum, targetType: person, checked: false };
    expect(print(cast)).toBe("const p = (x + x) as Person");
  });

  it("parenthesizes a cast on the right of a tight operator", () => {
    const cast = {
      type: "castExpression",
      expression: xVariable,
      targetType: person,
      checked: false,
    };
    const sum = { type: "binOpExpression", operator: "+", left: xVariable, right: cast };
    expect(print(sum)).toBe("const p = x + (x as Person)");
  });

  it("leaves a cast on the right of a loose operator bare", () => {
    const cast = {
      type: "castExpression",
      expression: xVariable,
      targetType: person,
      checked: false,
    };
    const eq = { type: "binOpExpression", operator: "==", left: xVariable, right: cast };
    expect(print(eq)).toBe("const p = x == x as Person");
  });
});
