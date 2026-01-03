import {
  ADLProgram,
  Assignment,
  InterpolationSegment,
  PromptLiteral,
  TypeHintMap,
  VariableType
} from "@/types";

import * as renderEdge from "@/templates/backends/graphGenerator/edge";
import * as renderImports from "@/templates/backends/graphGenerator/imports";
import * as renderNode from "@/templates/backends/graphGenerator/node";
import * as renderStartNode from "@/templates/backends/graphGenerator/startNode";
import * as promptFunction from "@/templates/backends/typescriptGenerator/promptFunction";
import { TypeScriptGenerator } from "./typescriptGenerator";
import { variableTypeToString } from "./typescriptGenerator/typeToString";
import { mapTypeToZodSchema } from "./typescriptGenerator/typeToZodSchema";
import { wrapInReturn } from "./utils";

export class GraphGenerator extends TypeScriptGenerator {
  protected typeHints: TypeHintMap = {};
  protected generatedStatements: string[] = [];
  protected generatedTypeAliases: string[] = [];
  protected variablesInScope: Set<string> = new Set();
  protected typeAliases: Record<string, VariableType> = {};
  protected functionsUsed: Set<string> = new Set();
  protected graphNodes: string[] = [];
  constructor() {
    super();
  }

  /* 
  protected generateBuiltins(): string {
    return "";
  }

  protected processTypeAlias(node: TypeAlias): void {
    // subclasses implement this
  }

  protected processTypeHint(node: TypeHint): void {
    // subclasses implement this
  }

  protected processNode(node: ADLNode): string {
    switch (node.type) {
      case "typeHint":
      case "typeAlias":
        return "";
      case "assignment":
        return this.processAssignment(node);
      case "function":
        return this.processFunctionDefinition(node);
      case "functionCall":
        return this.processFunctionCall(node);
      case "accessExpression":
        return this.processAccessExpression(node);
      case "comment":
        return this.processComment(node);
      case "matchBlock":
        return this.processMatchBlock(node);
      case "number":
      case "string":
      case "variableName":
      case "prompt":
        // Standalone literals at top level
        return this.generateLiteral(node);
      case "returnStatement":
        return this.processReturnStatement(node);
      case "adlArray":
        return this.processADLArray(node);
      case "adlObject":
        return this.processADLObject(node);
    }
  }

  protected processADLObject(node: ADLObject): string {
    return "<processADLObject not implemented>";
  }

  protected processADLArray(node: ADLArray): string {
    return "<processADLArray not implemented>";
  }

  protected processComment(node: ADLComment): string {
    return "processComment not implemented";
  }

  protected processReturnStatement(node: ADLNode): string {
    return "processReturnStatement not implemented";
  }

  protected processAccessExpression(node: AccessExpression): string {
    switch (node.expression.type) {
      case "dotProperty":
        return this.processDotProperty(node.expression);
      case "indexAccess":
        return this.processIndexAccess(node.expression);
      case "dotFunctionCall":
        return this.processDotFunctionCall(node.expression);
    }
  }

  protected processMatchBlock(node: MatchBlock): string {
    return "processMatchBlock not implemented";
  }

  protected processDotProperty(node: DotProperty): string {
    return "processDotProperty not implemented";
  }

  protected processDotFunctionCall(node: DotFunctionCall): string {
    return "processDotFunctionCall not implemented";
  }

  protected processIndexAccess(node: IndexAccess): string {
    return "processIndexAccess not implemented";
  } */

  protected processAssignment(node: Assignment): string {
    const valueCode = this.processNode(wrapInReturn(node.value));
    this.graphNodes.push(node.variableName);
    return renderNode.default({
      name: node.variableName,
      body: valueCode,
    });
  }
  protected processPromptLiteral(
    variableName: string,
    node: PromptLiteral
  ): string {
    // Validate all interpolated variables are in scope
    const interpolatedVars = node.segments
      .filter((s) => s.type === "interpolation")
      .map((s) => (s as InterpolationSegment).variableName);

    for (const varName of interpolatedVars) {
      if (!this.variablesInScope.has(varName)) {
        throw new Error(
          `Variable '${varName}' used in prompt interpolation but not defined. ` +
          `Referenced in assignment to '${variableName}'.`
        );
      }
    }

    const functionCode = this.generatePromptFunction({
      variableName: "promptFunc",
      functionArgs: interpolatedVars,
      prompt: node,
    });
    const argsStr = interpolatedVars.join(", ");

    const lines = [functionCode + `(${argsStr});`];

    //lines.push(`const result = await _promptFunc();` + "\n");
    // Generate the function call
    return lines.join("\n");
  }

  generatePromptFunction({
    variableName,
    functionArgs = [],
    prompt,
  }: {
    variableName: string;
    functionArgs: string[];
    prompt: PromptLiteral;
  }): string {
    // Generate async function for prompt-based assignment
    const variableType = this.typeHints[variableName] || {
      type: "primitiveType" as const,
      value: "string",
    };

    const zodSchema = mapTypeToZodSchema(variableType, this.typeAliases);
    const typeString = variableTypeToString(variableType, this.typeAliases);

    // Build prompt construction code
    const promptCode = this.buildPromptString(prompt.segments, this.typeHints);
    const argsStr = functionArgs
      .map(
        (arg) =>
          `${arg}: ${variableTypeToString(
            this.typeHints[arg] || { type: "primitiveType", value: "string" },
            this.typeAliases
          )}`
      )
      .join(", ");
    return promptFunction.default({
      variableName,
      argsStr,
      typeString,
      promptCode,
      zodSchema,
    });
  }

  /* 

  protected processFunctionDefinition(node: FunctionDefinition): string {
    return "processFunctionDefinition not implemented";
  }

  protected processFunctionCall(node: FunctionCall): string {
    return "processFunctionCall not implemented";
  }

  protected generateFunctionCallExpression(node: FunctionCall): string {
    return "generateFunctionCallExpression not implemented";
  }

  protected generateLiteral(literal: Literal): string {
    return "generateLiteral not implemented";
  } */

  protected generateImports(): string {
    return renderImports.default({ nodes: JSON.stringify(this.graphNodes) });
  }
  protected postprocess(): string {
    const lines: string[] = [];
    this.graphNodes.forEach((node, index) => {
      const nextNode = this.graphNodes[index + 1];
      if (!nextNode) return;

      lines.push(
        renderEdge.default({
          fromNode: node,
          toNode: nextNode,
        })
      );
    });

    lines.push(
      renderStartNode.default({
        startNode: this.graphNodes[0],
      })
    );

    return lines.join("\n");
  }
}

export function generateGraph(program: ADLProgram): string {
  const generator = new GraphGenerator();
  return generator.generate(program).output;
}
