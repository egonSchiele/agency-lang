import { describe, expect, it } from "vitest";
import { parseAgency } from "../parser.js";
import type { AgencyProgram, DecoratorCallField } from "../types.js";
import { typeCheck } from "../typeChecker/index.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { TypescriptPreprocessor } from "../preprocessors/typescriptPreprocessor.js";
import { expressionSlots, isRegisteredExpressionKind } from "../utils/expressionSlots.js";
import { bodySlots } from "../utils/bodySlots.js";
import { identifierSlots } from "../utils/identifierSlots.js";
import { isLegalAtTopLevel } from "../utils/topLevel.js";
import { walkNodesArray } from "../utils/node.js";
import { AgencyGenerator } from "./agencyGenerator.js";
import { generateTypeScript } from "./typescriptGenerator.js";

function metadataFields(): DecoratorCallField[] {
  return [
    { type: "decoratorCallField", field: "id", functionName: "f" },
    { type: "decoratorCallField", field: "inToolCall" },
  ];
}

function programWithRecord(returnType: string): AgencyProgram {
  const parsed = parseAgency(`
def f(f: number): ${returnType} {
  return { id: "placeholder", inToolCall: false }
}
`);
  if (!parsed.success) {
    throw new Error(parsed.message);
  }
  const definition = parsed.result.nodes.find((node) => node.type === "function");
  const returned = definition?.body.find((node) => node.type === "returnStatement");
  if (!returned) {
    throw new Error("Expected a function returning a record.");
  }
  returned.value = {
    type: "agencyObject",
    entries: metadataFields().map((value) => ({ key: value.field, value })),
  };
  return parsed.result;
}

describe("decorator call metadata", () => {
  it("infers the record's string and boolean fields", () => {
    const program = programWithRecord("{ id: string, inToolCall: boolean }");
    expect(typeCheck(program).errors).toEqual([]);
  });

  it("rejects using either metadata field as a number", () => {
    const idErrors = typeCheck(programWithRecord("{ id: number, inToolCall: boolean }")).errors;
    const contextErrors = typeCheck(programWithRecord("{ id: string, inToolCall: number }")).errors;
    expect(idErrors.some((error) => /string/.test(error.message))).toBe(true);
    expect(contextErrors.some((error) => /boolean/.test(error.message))).toBe(true);
  });

  it("emits the supplied module identity and a tool-context presence check", () => {
    const program = programWithRecord("{ id: string, inToolCall: boolean }");
    const output = generateTypeScript(
      program,
      {},
      buildCompilationUnit(program),
      "nested/tools.agency",
      "/elsewhere/built/tools.js",
    );
    expect(output).toContain('"id": "nested/tools.agency:f"');
    expect(output).toContain('"inToolCall": __run.toolInvocationStack !== undefined');
  });

  it("preserves metadata leaves through preprocessing and JSON output", () => {
    const program = programWithRecord("{ id: string, inToolCall: boolean }");
    const preprocessed = new TypescriptPreprocessor(
      program,
      {},
      buildCompilationUnit(program),
    ).preprocess();
    const fields = walkNodesArray(preprocessed.nodes)
      .map(({ node }) => node)
      .filter((node) => node.type === "decoratorCallField");
    expect(fields).toEqual(metadataFields());
    expect(JSON.parse(JSON.stringify(fields))).toEqual(metadataFields());
  });

  it.each([
    ["local", 'def _callRecord(): string { return "user helper" }'],
    ["imported", 'import { _callRecord } from "./custom.js"'],
  ])("ignores a %s binding named _callRecord", (_kind, declaration) => {
    const parsed = parseAgency(`
${declaration}
decorator def recorded(call, block) {
  return block(call.args)
}
@recorded
def f(): number {
  return 1
}
`);
    if (!parsed.success) {
      throw new Error(parsed.message);
    }
    const output = generateTypeScript(parsed.result, {}, undefined, "tools.agency");
    expect(output).toContain('"id": "tools.agency:f"');
    expect(output).toContain('"inToolCall": __run.toolInvocationStack !== undefined');
    expect(output).not.toMatch(/__call\(_callRecord[,)]/);
  });

  it("registers metadata as leaves with no identifier references or source statement form", () => {
    for (const field of metadataFields()) {
      expect(isRegisteredExpressionKind(field.type)).toBe(true);
      expect(expressionSlots(field)).toEqual([]);
      expect(bodySlots(field)).toEqual([]);
      expect(identifierSlots(field)).toEqual([]);
      expect(isLegalAtTopLevel(field)).toBe(false);
      expect(() => new AgencyGenerator().processNode(field)).toThrow(
        "Decorator call metadata has no Agency source form.",
      );
    }
  });
});
