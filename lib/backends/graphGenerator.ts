import {
  ADLNode,
  ADLProgram,
  Assignment,
  FunctionCall,
  FunctionDefinition,
  InterpolationSegment,
  PromptLiteral,
  TypeHintMap,
  VariableType,
} from "@/types";

import * as renderEdge from "@/templates/backends/graphGenerator/edge";
import * as renderConditionalEdge from "@/templates/backends/graphGenerator/conditionalEdge";
import * as renderImports from "@/templates/backends/graphGenerator/imports";
import * as renderNode from "@/templates/backends/graphGenerator/node";
import * as renderStartNode from "@/templates/backends/graphGenerator/startNode";
import * as promptFunction from "@/templates/backends/typescriptGenerator/promptFunction";
import * as promptNode from "@/templates/backends/graphGenerator/promptNode";
import * as graphNode from "@/templates/backends/graphGenerator/graphNode";
import * as builtinTools from "@/templates/backends/graphGenerator/builtinTools";
import * as goToNode from "@/templates/backends/graphGenerator/goToNode";
import { TypeScriptGenerator } from "./typescriptGenerator";
import { variableTypeToString } from "./typescriptGenerator/typeToString";
import { mapTypeToZodSchema } from "./typescriptGenerator/typeToZodSchema";
import { wrapInReturn } from "./utils";
import { mapFunctionName } from "./typescriptGenerator/builtins";
import { GraphNodeDefinition } from "@/types/graphNode";
import { ReturnStatement } from "@/types/returnStatement";

export class GraphGenerator extends TypeScriptGenerator {
  protected typeHints: TypeHintMap = {};
  protected generatedStatements: string[] = [];
  protected generatedTypeAliases: string[] = [];
  protected typeAliases: Record<string, VariableType> = {};
  protected functionsUsed: Set<string> = new Set();
  protected adjacentNodes: Record<string, string[]> = {};
  protected currentAdjacentNodes: string[] = [];
  protected isInsideGraphNode: boolean = false;
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

  /*   protected processAssignment(node: Assignment): string {
    switch (node.value.type) {
      case "prompt":
        return this.processPromptLiteral(node.variableName, node.value);
      default:
        return this.createNode(
          node.variableName,
          this.processNode(wrapInReturn(node.value))
        );
    }
  }

  protected createNode(name: string, body: string): string {
    this.graphNodes.push(name);
    return renderNode.default({
      name,
      body,
    });
  }

  protected processPromptLiteral(
    variableName: string,
    node: PromptLiteral
  ): string {
    this.graphNodes.push(variableName);

    // Validate all interpolated variables are in scope
    const interpolatedVars = node.segments
      .filter((s) => s.type === "interpolation")
      .map((s) => (s as InterpolationSegment).variableName);

    for (const varName of interpolatedVars) {
      if (!this.graphNodes.includes(varName)) {
        throw new Error(
          `Variable '${varName}' used in prompt interpolation but not defined. ` +
            `Referenced in assignment to '${variableName}'.`
        );
      }
    }

    const promptFunction = this.generatePromptFunction({
      variableName,
      functionArgs: interpolatedVars,
      prompt: node,
    });
    const argsStr = interpolatedVars.join(", ");

    return promptNode.default({
      name: variableName,
      promptFunction,
      argsStr,
    });
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
 */

  protected processReturnStatement(node: ReturnStatement): string {
    if (!this.isInsideGraphNode) {
      return super.processReturnStatement(node);
    } else {
      const returnCode = this.processNode(node.value);
      return `return { ...state, data: ${returnCode}}\n`;
    }
  }

  protected processGraphNodeName(node: GraphNodeDefinition): void {
    this.graphNodes.push(node.nodeName);
  }

  protected processGraphNode(node: GraphNodeDefinition): string {
    const { nodeName, body, parameters } = node;
    if (parameters.length > 1) {
      throw new Error(
        `Graph node '${nodeName}' has more than one parameter. Only one parameter is supported for now.`
      );
    }
    this.adjacentNodes[nodeName] = [];
    this.currentAdjacentNodes = [];
    this.functionScopedVariables = [];
    this.isInsideGraphNode = true;
    if (parameters.length > 0) {
      this.functionScopedVariables.push(parameters[0]);
    }

    const bodyCode: string[] = [];
    for (const stmt of body) {
      bodyCode.push(this.processNode(stmt));
    }
    this.functionScopedVariables = [];
    this.adjacentNodes[nodeName] = [...this.currentAdjacentNodes];
    this.isInsideGraphNode = false;
    return graphNode.default({
      name: nodeName,
      body: bodyCode.join("\n"),
      hasParam: parameters.length > 0,
      paramName: parameters[0] || "input",
    });
  }

  protected processFunctionCall(node: FunctionCall): string {
    if (this.graphNodes.includes(node.functionName)) {
      this.currentAdjacentNodes.push(node.functionName);
      this.functionsUsed.add(node.functionName);
      const functionCallCode = this.generateNodeCallExpression(node);

      return functionCallCode;
    } else {
      return super.processFunctionCall(node);
    }
  }

  protected generateNodeCallExpression(node: FunctionCall): string {
    const functionName = mapFunctionName(node.functionName);
    const args = node.arguments;
    const parts = args.map((arg) => {
      if (arg.type === "functionCall") {
        this.functionsUsed.add(arg.functionName);
        return this.generateFunctionCallExpression(arg);
      } else if (arg.type === "accessExpression") {
        return this.processAccessExpression(arg);
      } else {
        return this.generateLiteral(arg);
      }
    });
    const argsString = parts.join(", ");
    return goToNode.default({
      nodeName: functionName,
      data: argsString,
    });
  } /* 

  protected generateLiteral(literal: Literal): string {
    return "generateLiteral not implemented";
  } */

  protected generateImports(): string {
    let arr = [
      renderImports.default({ nodes: JSON.stringify(this.graphNodes) }),
    ];
    arr.push(builtinTools.default({}));
    return arr.join("\n");
  }
  protected postprocess(): string {
    const lines: string[] = [];
    Object.keys(this.adjacentNodes).forEach((node) => {
      const adjacent = this.adjacentNodes[node];
      if (adjacent.length === 0) {
        return;
      }
      lines.push(
        renderConditionalEdge.default({
          fromNode: node,
          toNodes: JSON.stringify(adjacent),
        })
      );
    });

    if (!this.graphNodes.includes("main")) {
      throw new Error(
        "No entrypoint found for agent: missing 'main' node. Please create a node named 'main'."
      );
    }

    lines.push(
      renderStartNode.default({
        startNode: "main",
      })
    );

    return lines.join("\n");
  }
}

export function generateGraph(program: ADLProgram): string {
  const generator = new GraphGenerator();
  return generator.generate(program).output;
}
