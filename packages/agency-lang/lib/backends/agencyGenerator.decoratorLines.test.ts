import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { AgencyGenerator } from "./agencyGenerator.js";
import { TypescriptPreprocessor } from "../preprocessors/typescriptPreprocessor.js";
import { decoratorLookup, desugarDecorators } from "../preprocessors/decoratorDesugar.js";
import type { AgencyProgram, FunctionDefinition } from "../types.js";

const SOURCE = `def budgeted(cost: number, block: () -> any): any {
  return block()
}

@hidden
@budgeted(cost: 1)
export def f(): string {
  return "x"
}
`;

function attached(): AgencyProgram {
  const parsed = parseAgency(SOURCE, {}, false);
  if (!parsed.success) throw new Error("parse failed");
  new TypescriptPreprocessor(parsed.result, {}).attachTags();
  return parsed.result;
}

function defF(program: AgencyProgram): FunctionDefinition {
  const def = program.nodes.find(
    (node): node is FunctionDefinition => node.type === "function" && node.functionName === "f",
  );
  if (def === undefined) throw new Error("no f");
  return def;
}

describe("AgencyGenerator.decoratorLines", () => {
  it("prints the decorator tags of an unlowered def, leaving reserved tags out", () => {
    const program = attached();
    expect(new AgencyGenerator({ debug: false }).decoratorLines(defF(program))).toEqual([
      "@budgeted(cost: 1)",
    ]);
  });

  it("prints the same tags once the lowering moved them to decorators", () => {
    const program = attached();
    const budgeted = program.nodes.find(
      (node): node is FunctionDefinition =>
        node.type === "function" && node.functionName === "budgeted",
    );
    desugarDecorators(program, decoratorLookup({ budgeted: budgeted! }, {}));
    const def = defF(program);
    expect(def.decorators).toHaveLength(1);
    expect(new AgencyGenerator({ debug: false }).decoratorLines(def)).toEqual([
      "@budgeted(cost: 1)",
    ]);
  });
});
