import { SpecialVar } from "@/types/specialVar.js";

import {
  AgencyComment,
  AgencyNode,
  AgencyProgram,
  Assignment,
  Literal,
  NewLine,
  PromptLiteral,
  TypeAlias,
  TypeHint,
  TypeHintMap,
  VariableType,
} from "../types.js";

import {
  AccessExpression,
  DotFunctionCall,
  DotProperty,
  IndexAccess,
} from "../types/access.js";
import { AgencyArray, AgencyObject } from "../types/dataStructures.js";
import { FunctionCall, FunctionDefinition } from "../types/function.js";
import { GraphNodeDefinition } from "../types/graphNode.js";
import {
  ImportNodeStatement,
  ImportStatement,
  ImportToolStatement,
} from "../types/importStatement.js";
import { MatchBlock } from "../types/matchBlock.js";
import { ReturnStatement } from "../types/returnStatement.js";
import { UsesTool } from "../types/tools.js";
import { WhileLoop } from "../types/whileLoop.js";
import { IfElse } from "../types/ifElse.js";
import { TimeBlock } from "@/types/timeBlock.js";
import { AwaitStatement } from "@/types/await.js";
import { variableTypeToString } from "./typescriptGenerator/typeToString.js";

export class BaseGenerator {
  protected typeHints: TypeHintMap = {};
  protected graphNodes: GraphNodeDefinition[] = [];
  protected generatedStatements: string[] = [];
  protected generatedTypeAliases: string[] = [];
  protected functionScopedVariables: string[] = [];
  protected globalScopedVariables: string[] = [];

  // collect tools for a prompt
  protected toolsUsed: string[] = [];
  protected typeAliases: Record<string, VariableType> = {};

  // collect functions used to see what builtin helpers to include
  protected functionsUsed: Set<string> = new Set();

  protected importStatements: string[] = [];
  protected importedNodes: ImportNodeStatement[] = [];
  protected importedTools: ImportToolStatement[] = [];

  // collect function signatures so we can implement named args
  // TODO also save return types, check if used as a tool, return type cannot be null/void/undefined
  protected functionDefinitions: Record<string, FunctionDefinition> = {};

  generate(program: AgencyProgram): {
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

    // Pass 4: Collect all node and tool imports
    for (const node of program.nodes) {
      if (node.type === "importNodeStatement") {
        this.importedNodes.push(node);
      } else if (node.type === "importToolStatement") {
        this.importedTools.push(node);
      }
    }

    // Pass 5: Generate code for tools
    for (const node of program.nodes) {
      if (node.type === "function") {
        this.generatedStatements.push(this.processTool(node));
        this.collectFunctionSignature(node);
      }
    }

    // Pass 6: Collect global scoped variables
    for (const node of program.nodes) {
      if (node.type === "assignment") {
        this.globalScopedVariables.push(node.variableName);
      }
    }

    // Pass 7: Process all nodes and generate code
    for (const node of program.nodes) {
      const result = this.processNode(node);
      this.generatedStatements.push(result);
    }

    const output: string[] = [];

    this.addIfNonEmpty(this.preprocess(), output);
    this.addIfNonEmpty(this.importStatements.join("\n"), output);
    this.addIfNonEmpty(this.generateImports(), output);
    this.addIfNonEmpty(this.generateBuiltins(), output);
    output.push(...this.generatedTypeAliases);
    output.push(this.generatedStatements.join(""));
    this.addIfNonEmpty(this.postprocess(), output);
    return {
      output: output.join("\n"), //filter((line) => line.trim() !== "").join("\n"),
    };
  }

  addIfNonEmpty(str: string, lines: string[]): void {
    if (str.trim() !== "") {
      lines.push(str);
    }
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

  protected collectFunctionSignature(node: FunctionDefinition): void {
    this.functionDefinitions[node.functionName] = node;
  }

  protected processGraphNodeName(node: GraphNodeDefinition): void {}

  protected processNode(node: AgencyNode): string {
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
      case "multiLineString":
      case "string":
      case "variableName":
      case "prompt":
        // Standalone literals at top level
        return this.generateLiteral(node);
      case "returnStatement":
        return this.processReturnStatement(node);
      case "agencyArray":
        return this.processAgencyArray(node);
      case "agencyObject":
        return this.processAgencyObject(node);
      case "graphNode":
        return this.processGraphNode(node);
      case "usesTool":
        return this.processUsesTool(node);
      case "importStatement":
        this.importStatements.push(this.processImportStatement(node));
        return "";
      case "importNodeStatement":
        this.importStatements.push(this.processImportNodeStatement(node));
        return "";
      case "importToolStatement":
        this.importStatements.push(this.processImportToolStatement(node));
        return "";
      case "whileLoop":
        return this.processWhileLoop(node);
      case "ifElse":
        return this.processIfElse(node);
      case "specialVar":
        return this.processSpecialVar(node);
      case "indexAccess":
        return this.processIndexAccess(node);
      case "timeBlock":
        throw new Error(
          `Time block needs to be assigned to a variable: ${JSON.stringify(node as any)}`,
        );
      case "awaitStatement":
        return this.processAwaitStatement(node);
      case "newLine":
        return this.processNewLine(node);
      default:
        throw new Error(`Unhandled Agency node type: ${(node as any).type}`);
    }
  }

  protected processNewLine(_node: NewLine): string {
    return "";
  }

  protected processAwaitStatement(node: AwaitStatement): string {
    return "processAwaitStatement not implemented";
  }

  protected processTimeBlock(node: TimeBlock, timingVarName: string): string {
    return "processTimeBlock not implemented";
  }

  protected processSpecialVar(node: SpecialVar): string {
    return "processSpecialVar not implemented";
  }

  protected processWhileLoop(node: WhileLoop): string {
    return "processWhileLoop not implemented";
  }

  protected processIfElse(node: IfElse): string {
    return "processIfElse not implemented";
  }

  protected processImportStatement(node: ImportStatement): string {
    return "processImportStatement not implemented";
  }

  protected processImportNodeStatement(node: ImportNodeStatement): string {
    return "processImportNodeStatement not implemented";
  }

  protected processImportToolStatement(node: ImportToolStatement): string {
    return "processImportToolStatement not implemented";
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

  protected processAgencyObject(node: AgencyObject): string {
    return "<processAgencyObject not implemented>";
  }

  protected processAgencyArray(node: AgencyArray): string {
    return "<processAgencyArray not implemented>";
  }

  protected processComment(node: AgencyComment): string {
    return "processComment not implemented";
  }

  protected processReturnStatement(node: ReturnStatement): string {
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
    typeHint: VariableType | undefined,
    node: PromptLiteral,
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
