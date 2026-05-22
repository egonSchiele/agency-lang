import { describe, it, expect } from "vitest";
import { injectSchemaArgsInProgram } from "./injectSchemaArgs.js";
import type { AgencyProgram, FunctionDefinition } from "../types.js";
import type { FunctionParameter } from "../types/function.js";

/**
 * Helper: builds a `def parseValue(input: string, s: Schema<any>): any` shape.
 * The default returnType is `any`; pass a different one to test return-position
 * scenarios where the function declares a more specific return type.
 */
function buildParseValueDef(): FunctionDefinition {
  const params: FunctionParameter[] = [
    {
      type: "functionParameter",
      name: "input",
      typeHint: { type: "primitiveType", value: "string" },
    },
    {
      type: "functionParameter",
      name: "s",
      typeHint: {
        type: "genericType",
        name: "Schema",
        typeArgs: [{ type: "primitiveType", value: "any" }],
      },
    },
  ];
  return {
    type: "function",
    functionName: "parseValue",
    parameters: params,
    returnType: { type: "primitiveType", value: "any" },
    body: [],
  };
}

describe("injectSchemaArgsInProgram", () => {
  it("injects a schema arg from an assignment's LHS type", () => {
    // const xs: number[] = parseValue("[1,2,3]")
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "assignment",
          declKind: "const",
          target: "xs",
          typeHint: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          value: {
            type: "functionCall",
            functionName: "parseValue",
            arguments: [
              {
                type: "string",
                segments: [{ type: "text", value: "[1,2,3]" }],
              },
            ],
          },
        } as any,
      ],
    };

    injectSchemaArgsInProgram(
      program,
      { parseValue: buildParseValueDef() },
      {},
    );

    const call = (program.nodes[0] as any).value;
    expect(call.arguments).toHaveLength(2);
    expect(call.arguments[1].type).toBe("namedArgument");
    expect(call.arguments[1].name).toBe("s");
    expect(call.arguments[1].value.type).toBe("schemaExpression");
    expect(call.arguments[1].value.typeArg).toEqual({
      type: "arrayType",
      elementType: { type: "primitiveType", value: "number" },
    });
  });

  it("does not inject when the schema arg is supplied explicitly (positional)", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "assignment",
          declKind: "const",
          target: "xs",
          typeHint: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          value: {
            type: "functionCall",
            functionName: "parseValue",
            arguments: [
              {
                type: "string",
                segments: [{ type: "text", value: "[1,2,3]" }],
              },
              {
                type: "schemaExpression",
                typeArg: { type: "primitiveType", value: "string" },
              },
            ],
          },
        } as any,
      ],
    };

    injectSchemaArgsInProgram(
      program,
      { parseValue: buildParseValueDef() },
      {},
    );

    const call = (program.nodes[0] as any).value;
    expect(call.arguments).toHaveLength(2);
    // The user-supplied schema (string) is preserved.
    expect(call.arguments[1].type).toBe("schemaExpression");
    expect(call.arguments[1].typeArg).toEqual({
      type: "primitiveType",
      value: "string",
    });
  });

  it("does not inject when the schema arg is supplied by name", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "assignment",
          declKind: "const",
          target: "xs",
          typeHint: { type: "primitiveType", value: "any" },
          value: {
            type: "functionCall",
            functionName: "parseValue",
            arguments: [
              {
                type: "string",
                segments: [{ type: "text", value: "[1,2,3]" }],
              },
              {
                type: "namedArgument",
                name: "s",
                value: {
                  type: "schemaExpression",
                  typeArg: { type: "primitiveType", value: "number" },
                },
              },
            ],
          },
        } as any,
      ],
    };

    injectSchemaArgsInProgram(
      program,
      { parseValue: buildParseValueDef() },
      {},
    );

    const call = (program.nodes[0] as any).value;
    expect(call.arguments).toHaveLength(2);
    expect(call.arguments[1].value.typeArg).toEqual({
      type: "primitiveType",
      value: "number",
    });
  });

  it("does not inject when there is no LHS annotation", () => {
    // const xs = parseValue("[1,2,3]")   // no `: T` annotation
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "assignment",
          declKind: "const",
          target: "xs",
          // intentionally no typeHint
          value: {
            type: "functionCall",
            functionName: "parseValue",
            arguments: [
              {
                type: "string",
                segments: [{ type: "text", value: "[1,2,3]" }],
              },
            ],
          },
        } as any,
      ],
    };

    injectSchemaArgsInProgram(
      program,
      { parseValue: buildParseValueDef() },
      {},
    );

    const call = (program.nodes[0] as any).value;
    expect(call.arguments).toHaveLength(1);
  });

  it("injects from return-position when the enclosing function's return type is known", () => {
    // def wrapper(): number[] { return parseValue("[1,2,3]") }
    const wrapper: FunctionDefinition = {
      type: "function",
      functionName: "wrapper",
      parameters: [],
      returnType: {
        type: "arrayType",
        elementType: { type: "primitiveType", value: "number" },
      },
      body: [
        {
          type: "returnStatement",
          value: {
            type: "functionCall",
            functionName: "parseValue",
            arguments: [
              {
                type: "string",
                segments: [{ type: "text", value: "[1,2,3]" }],
              },
            ],
          },
        } as any,
      ],
    };
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [wrapper],
    };

    injectSchemaArgsInProgram(
      program,
      { parseValue: buildParseValueDef(), wrapper },
      {},
    );

    const ret = wrapper.body[0] as any;
    const call = ret.value;
    expect(call.arguments).toHaveLength(2);
    expect(call.arguments[1].value.typeArg).toEqual({
      type: "arrayType",
      elementType: { type: "primitiveType", value: "number" },
    });
  });

  it("throws when a function declares more than one Schema parameter", () => {
    const twoSchemas: FunctionDefinition = {
      type: "function",
      functionName: "doubled",
      parameters: [
        {
          type: "functionParameter",
          name: "a",
          typeHint: {
            type: "genericType",
            name: "Schema",
            typeArgs: [{ type: "primitiveType", value: "any" }],
          },
        },
        {
          type: "functionParameter",
          name: "b",
          typeHint: {
            type: "genericType",
            name: "Schema",
            typeArgs: [{ type: "primitiveType", value: "any" }],
          },
        },
      ],
      returnType: { type: "primitiveType", value: "any" },
      body: [],
    };
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "assignment",
          declKind: "const",
          target: "x",
          typeHint: { type: "primitiveType", value: "string" },
          value: {
            type: "functionCall",
            functionName: "doubled",
            arguments: [],
          },
        } as any,
      ],
    };

    expect(() =>
      injectSchemaArgsInProgram(
        program,
        { doubled: twoSchemas },
        {},
      ),
    ).toThrowError(/more than one Schema parameter/);
  });

  it("leaves calls to unknown functions alone (e.g. JS / builtins)", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "assignment",
          declKind: "const",
          target: "xs",
          typeHint: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          value: {
            type: "functionCall",
            functionName: "unknownFn",
            arguments: [],
          },
        } as any,
      ],
    };

    injectSchemaArgsInProgram(program, {}, {});

    const call = (program.nodes[0] as any).value;
    expect(call.arguments).toHaveLength(0);
  });
});
