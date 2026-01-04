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
import { GraphNodeDefinition } from "@/types/graphNode";
import { MatchBlock } from "@/types/matchBlock";
import { ReturnStatement } from "@/types/returnStatement";
import { UsesTool } from "@/types/tools";

export class BaseGenerator {
  protected typeHints: TypeHintMap = {};
  protected graphNodes: string[] = [];
  protected generatedStatements: string[] = [];
  protected generatedTypeAliases: string[] = [];
  protected functionScopedVariables: string[] = [];
  protected toolsUsed: string[] = [];
  protected typeAliases: Record<string, VariableType> = {};
  protected functionsUsed: Set<string> = new Set();
  constructor() { }

  generate(program: ADLProgram): {
    output: string;
  } {
    // Pass 1: Collect all type aliases
    for (const node of program.nodes) {
      if (node.type === "typeAlias") {
        this.processTypeAlias(node);
      }
    }

    // Pass 2: Collect all type hints
    for (const node of program.nodes) {
      if (node.type === "typeHint") {
        this.processTypeHint(node);
      }
    }

    // Pass 3: Collect all node names
    for (const node of program.nodes) {
      if (node.type === "graphNode") {
        this.processGraphNodeName(node);
      }
    }

    // Pass 4: Generate code for tools
    for (const node of program.nodes) {
      if (node.type === "function") {
        this.generatedStatements.push(this.processTool(node));
      }
    }

    // Pass 5: Process all nodes and generate code
    for (const node of program.nodes) {
      const result = this.processNode(node);
      this.generatedStatements.push(result);
    }

    const output: string[] = [];

    output.push(this.preprocess() + "\n");
    output.push(this.generateImports() + "\n");
    output.push(this.generateBuiltins() + "\n");
    output.push("\n");

    output.push(...this.generatedTypeAliases);

    output.push(this.generatedStatements.join(""));
    output.push(this.postprocess() + "\n");

    return {
      output: output.filter(Boolean).join("\n"),
    };
  }

  protected generateBuiltins(): string {
    return "";
  }

  protected processTypeAlias(node: TypeAlias): string {
    // subclasses implement this
    return "";
  }

  protected processTypeHint(node: TypeHint): string {
    // subclasses implement this
    return "";
  }

  protected processGraphNodeName(node: GraphNodeDefinition): void { }

  protected processNode(node: ADLNode): string {
    switch (node.type) {
      case "typeHint":
        return this.processTypeHint(node);
      case "typeAlias":
        return this.processTypeAlias(node);
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
      case "graphNode":
        return this.processGraphNode(node);
      case "usesTool":
        return this.processUsesTool(node);
      default:
        throw new Error(`Unhandled ADL node type: ${(node as any).type}`);
    }
  }

  protected processTool(node: FunctionDefinition): string {
    return "processTool not implemented";
  }

  protected processUsesTool(node: UsesTool): string {
    return "processUsesTool not implemented";
  }

  protected processGraphNode(node: GraphNodeDefinition): string {
    return "processGraphNode not implemented";
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
  }

  protected processAssignment(node: Assignment): string {
    return "processAssignment not implemented";
  }

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
  }

  protected generateImports(): string {
    return "generateImports not implemented";
  }

  protected preprocess(): string {
    return "";
  }

  protected postprocess(): string {
    return "";
  }
}
