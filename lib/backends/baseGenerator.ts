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

export class BaseGenerator {
  protected typeHints: TypeHintMap = {};
  protected generatedStatements: string[] = [];
  protected generatedTypeAliases: string[] = [];
  protected variablesInScope: Set<string> = new Set();
  protected typeAliases: Record<string, VariableType> = {};
  protected functionsUsed: Set<string> = new Set();
  constructor() {}
  /**
   * Generate TypeScript code from an ADL program
   */
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

    // Pass 3: Process all nodes and generate code
    for (const node of program.nodes) {
      const result = this.processNode(node);
      this.generatedStatements.push(result);
    }

    const output: string[] = [];

    output.push(this.generateImports() + "\n");
    output.push(this.generateBuiltins() + "\n");
    output.push("\n");

    output.push(...this.generatedTypeAliases);

    /* output.push(...this.generatedFunctions); */

    output.push(this.generatedStatements.join(""));

    return {
      output: output.filter(Boolean).join("\n"),
    };
  }

  protected generateBuiltins(): string {
    return "";
  }

  protected processTypeAlias(node: TypeAlias): void {
    // subclasses implement this
  }

  protected processTypeHint(node: TypeHint): void {
    // subclasses implement this
  }

  /**
   * Process any ADL node
   */
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

  /**
   * Process a function definition node
   */
  protected processFunctionDefinition(node: FunctionDefinition): string {
    return "processFunctionDefinition not implemented";
  }

  /**
   * Process a function call node
   */
  protected processFunctionCall(node: FunctionCall): string {
    return "processFunctionCall not implemented";
  }

  /**
   * Generates TypeScript expression for a function call (without semicolon)
   */
  protected generateFunctionCallExpression(node: FunctionCall): string {
    return "generateFunctionCallExpression not implemented";
  }

  protected generateLiteral(literal: Literal): string {
    return "generateLiteral not implemented";
  }

  generateImports(): string {
    return "generateImports not implemented";
  }
}
