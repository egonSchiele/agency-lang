import { describe, it, expect } from "vitest";
import { injectSchemaArgsInProgram } from "./injectSchemaArgs.js";
import type {
  AgencyProgram,
  Assignment,
  FunctionCall,
  FunctionDefinition,
} from "../types.js";
import type { FunctionParameter } from "../types/function.js";

/**
 * Helper: builds a `def parseValue(input: string, s: Schema<any>): any` shape.
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

/**
 * Helper: builds `const <name>: <typeHint> = <call>` as a real
 * Assignment AST node. Uses the real `variableName` field — earlier
 * versions of this test used a fictional `target` field, which
 * worked only because the calls were cast to `any`.
 */
function buildConstAssignment(
  name: string,
  typeHint: Assignment["typeHint"],
  call: FunctionCall,
): Assignment {
  return {
    type: "assignment",
    declKind: "const",
    variableName: name,
    typeHint,
    value: call,
  };
}

function buildCall(
  functionName: string,
  args: FunctionCall["arguments"] = [],
): FunctionCall {
  return {
    type: "functionCall",
    functionName,
    arguments: args,
  };
}

function buildStringLiteral(value: string) {
  return {
    type: "string" as const,
    segments: [{ type: "text" as const, value }],
  };
}

describe("injectSchemaArgsInProgram", () => {
  it("injects a schema arg from an assignment's LHS type", () => {
    // const xs: number[] = parseValue("[1,2,3]")
    const call = buildCall("parseValue", [buildStringLiteral("[1,2,3]")]);
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        buildConstAssignment(
          "xs",
          {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          call,
        ),
      ],
    };

    injectSchemaArgsInProgram(
      program,
      { parseValue: buildParseValueDef() },
      {},
    );

    expect(call.arguments).toHaveLength(2);
    expect(call.arguments[1].type).toBe("namedArgument");
    if (call.arguments[1].type !== "namedArgument") return;
    expect(call.arguments[1].name).toBe("s");
    expect(call.arguments[1].value.type).toBe("schemaExpression");
    if (call.arguments[1].value.type !== "schemaExpression") return;
    expect(call.arguments[1].value.typeArg).toEqual({
      type: "arrayType",
      elementType: { type: "primitiveType", value: "number" },
    });
  });

  it("does not inject when the schema arg is supplied explicitly (positional)", () => {
    const call = buildCall("parseValue", [
      buildStringLiteral("[1,2,3]"),
      {
        type: "schemaExpression",
        typeArg: { type: "primitiveType", value: "string" },
      },
    ]);
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        buildConstAssignment(
          "xs",
          {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          call,
        ),
      ],
    };

    injectSchemaArgsInProgram(
      program,
      { parseValue: buildParseValueDef() },
      {},
    );

    expect(call.arguments).toHaveLength(2);
    // The user-supplied schema (string) is preserved.
    expect(call.arguments[1].type).toBe("schemaExpression");
    if (call.arguments[1].type !== "schemaExpression") return;
    expect(call.arguments[1].typeArg).toEqual({
      type: "primitiveType",
      value: "string",
    });
  });

  it("does not inject when the schema arg is supplied by name", () => {
    const call = buildCall("parseValue", [
      buildStringLiteral("[1,2,3]"),
      {
        type: "namedArgument",
        name: "s",
        value: {
          type: "schemaExpression",
          typeArg: { type: "primitiveType", value: "number" },
        },
      },
    ]);
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        buildConstAssignment(
          "xs",
          { type: "primitiveType", value: "any" },
          call,
        ),
      ],
    };

    injectSchemaArgsInProgram(
      program,
      { parseValue: buildParseValueDef() },
      {},
    );

    expect(call.arguments).toHaveLength(2);
    expect(call.arguments[1].type).toBe("namedArgument");
    if (call.arguments[1].type !== "namedArgument") return;
    expect(call.arguments[1].value.type).toBe("schemaExpression");
    if (call.arguments[1].value.type !== "schemaExpression") return;
    expect(call.arguments[1].value.typeArg).toEqual({
      type: "primitiveType",
      value: "number",
    });
  });

  it("does not inject when there is no LHS annotation", () => {
    // const xs = parseValue("[1,2,3]")   // no `: T` annotation
    const call = buildCall("parseValue", [buildStringLiteral("[1,2,3]")]);
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        buildConstAssignment("xs", undefined, call),
      ],
    };

    injectSchemaArgsInProgram(
      program,
      { parseValue: buildParseValueDef() },
      {},
    );

    expect(call.arguments).toHaveLength(1);
  });

  it("injects from return-position when the enclosing function's return type is known", () => {
    // def wrapper(): number[] { return parseValue("[1,2,3]") }
    const call = buildCall("parseValue", [buildStringLiteral("[1,2,3]")]);
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
          value: call,
        },
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

    expect(call.arguments).toHaveLength(2);
    if (call.arguments[1].type !== "namedArgument") return;
    if (call.arguments[1].value.type !== "schemaExpression") return;
    expect(call.arguments[1].value.typeArg).toEqual({
      type: "arrayType",
      elementType: { type: "primitiveType", value: "number" },
    });
  });

  it("injects from return-position when an enclosing graph node's return type is known", () => {
    // node main(): number[] { return parseValue("[1,2,3]") }
    const call = buildCall("parseValue", [buildStringLiteral("[1,2,3]")]);
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "graphNode",
          nodeName: "main",
          parameters: [],
          returnType: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          body: [
            {
              type: "returnStatement",
              value: call,
            },
          ],
        },
      ],
    };

    injectSchemaArgsInProgram(
      program,
      { parseValue: buildParseValueDef() },
      {},
    );

    expect(call.arguments).toHaveLength(2);
    if (call.arguments[1].type !== "namedArgument") return;
    if (call.arguments[1].value.type !== "schemaExpression") return;
    expect(call.arguments[1].value.typeArg).toEqual({
      type: "arrayType",
      elementType: { type: "primitiveType", value: "number" },
    });
  });

  it("throws at declaration time when a function declares more than one Schema parameter", () => {
    // `doubled` is never called — the error should still fire because
    // the structural validation pass scans every function definition.
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
      nodes: [],
    };

    expect(() =>
      injectSchemaArgsInProgram(program, { doubled: twoSchemas }, {}),
    ).toThrowError(/more than one Schema parameter/);
  });

  it("leaves calls to unknown functions alone (e.g. JS / builtins)", () => {
    const call = buildCall("unknownFn");
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        buildConstAssignment(
          "xs",
          {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          call,
        ),
      ],
    };

    injectSchemaArgsInProgram(program, {}, {});

    expect(call.arguments).toHaveLength(0);
  });

  it("injects for `let` assignments the same as `const`", () => {
    // let xs: number[] = parseValue("[1,2,3]")
    const call = buildCall("parseValue", [buildStringLiteral("[1,2,3]")]);
    const assignment: Assignment = {
      type: "assignment",
      declKind: "let",
      variableName: "xs",
      typeHint: {
        type: "arrayType",
        elementType: { type: "primitiveType", value: "number" },
      },
      value: call,
    };
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [assignment],
    };

    injectSchemaArgsInProgram(
      program,
      { parseValue: buildParseValueDef() },
      {},
    );

    expect(call.arguments).toHaveLength(2);
    if (call.arguments[1].type !== "namedArgument") return;
    if (call.arguments[1].value.type !== "schemaExpression") return;
    expect(call.arguments[1].value.typeArg).toEqual({
      type: "arrayType",
      elementType: { type: "primitiveType", value: "number" },
    });
  });

  it("does not inject when a splat appears before the Schema slot", () => {
    // const xs: number[] = parseValue(...args)
    // We can't tell statically whether the splat fills the Schema slot,
    // so injection must be conservative and skip.
    const splat = {
      type: "splat",
      value: { type: "variableReference", name: "args" },
    } as unknown as FunctionCall["arguments"][number];
    const call = buildCall("parseValue", [splat]);
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        buildConstAssignment(
          "xs",
          {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          call,
        ),
      ],
    };

    injectSchemaArgsInProgram(
      program,
      { parseValue: buildParseValueDef() },
      {},
    );

    // Still just the splat — no synthetic Schema arg appended.
    expect(call.arguments).toHaveLength(1);
    expect(call.arguments[0].type).toBe("splat");
  });

  it("injects for calls to imported functions with a Schema parameter", () => {
    // Same shape as parseValue, but reached via `importedFunctions`
    // instead of `functionDefinitions`.
    const call = buildCall("parseValue", [buildStringLiteral("[1,2,3]")]);
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        buildConstAssignment(
          "xs",
          {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          call,
        ),
      ],
    };

    injectSchemaArgsInProgram(
      program,
      {},
      {
        parseValue: {
          parameters: buildParseValueDef().parameters,
          returnType: { type: "primitiveType", value: "any" },
        },
      },
    );

    expect(call.arguments).toHaveLength(2);
    if (call.arguments[1].type !== "namedArgument") return;
    expect(call.arguments[1].value.type).toBe("schemaExpression");
  });

  it("throws when an imported function declares more than one Schema parameter", () => {
    // Same multi-Schema declaration as the earlier test, but reached
    // through `importedFunctions`. Validates that the up-front
    // uniqueness check scans imports too.
    const params: FunctionParameter[] = [
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
    ];
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [],
    };

    expect(() =>
      injectSchemaArgsInProgram(
        program,
        {},
        {
          twoSchemas: {
            parameters: params,
            returnType: { type: "primitiveType", value: "any" },
          },
        },
      ),
    ).toThrowError(/more than one Schema parameter/);
  });

});
