import {
  ADLComment,
  ADLNode,
  ADLProgram,
  Assignment,
  Literal,
  PromptLiteral,
  TypeAlias,
  TypeHint,
  TypeHintMap,
  VariableType,
} from "@/types";

import {
  AccessExpression,
  DotFunctionCall,
  DotProperty,
  IndexAccess,
} from "@/types/access";
import { ADLArray, ADLObject } from "@/types/dataStructures";
import { FunctionCall, FunctionDefinition } from "@/types/function";
import { MatchBlock } from "@/types/matchBlock";
import * as renderImports from "@/templates/backends/graphGenerator/imports";
import * as renderNode from "@/templates/backends/graphGenerator/node";
import * as renderEdge from "@/templates/backends/graphGenerator/edge";
import * as renderStartNode from "@/templates/backends/graphGenerator/startNode";
import { TypeScriptGenerator } from "./typescriptGenerator";
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
  /* 
  protected processPromptLiteral(
    variableName: string,
    node: PromptLiteral
  ): string {
    return "processPromptLiteral not implemented";
  }

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
