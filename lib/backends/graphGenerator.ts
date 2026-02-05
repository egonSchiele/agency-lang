import {
  AgencyProgram,
  FunctionCall,
  TypeHintMap,
  VariableType,
} from "../types.js";

import * as builtinTools from "../templates/backends/graphGenerator/builtinTools.js";
import * as renderConditionalEdge from "../templates/backends/graphGenerator/conditionalEdge.js";
import * as goToNode from "../templates/backends/graphGenerator/goToNode.js";
import * as renderGraphNode from "../templates/backends/graphGenerator/graphNode.js";
import * as renderImports from "../templates/backends/graphGenerator/imports.js";
import * as renderStartNode from "../templates/backends/graphGenerator/startNode.js";
import * as renderRunNodeFunction from "../templates/backends/graphGenerator/runNodeFunction.js";
import { GraphNodeDefinition } from "../types/graphNode.js";
import { ReturnStatement } from "../types/returnStatement.js";
import { TypeScriptGenerator } from "./typescriptGenerator.js";
import { mapFunctionName } from "./typescriptGenerator/builtins.js";
import { variableTypeToString } from "./typescriptGenerator/typeToString.js";

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

  protected processReturnStatement(node: ReturnStatement): string {
    if (!this.isInsideGraphNode) {
      return super.processReturnStatement(node);
    } else {
      const returnCode = this.processNode(node.value);
      if (node.value.type === "functionCall") {
        const isGraphNode = this.graphNodes
          .map((n) => n.nodeName)
          .includes(node.value.functionName);
        const isImportedGraphNode = this.importedNodes
          .map((n) => n.importedNodes)
          .flat()
          .includes(node.value.functionName);
        if (isGraphNode || isImportedGraphNode) {
          // we're going to return a goToNode call, so just return that directly
          return `return ${returnCode}\n`;
        }
      }
      return `return { ...state, data: ${returnCode}}\n`;
    }
  }

  protected processGraphNodeName(node: GraphNodeDefinition): void {
    this.graphNodes.push(node);
  }

  protected processGraphNode(node: GraphNodeDefinition): string {
    const { nodeName, body, parameters } = node;
    /* if (parameters.length > 1) {
      throw new Error(
        `Graph node '${nodeName}' has more than one parameter. Only one parameter is supported for now.`,
      );
    } */
    this.adjacentNodes[nodeName] = [];
    this.currentAdjacentNodes = [];
    this.functionScopedVariables = [];
    this.isInsideGraphNode = true;
    for (const param of parameters) {
      this.functionScopedVariables.push(param.name);
    }

    const bodyCode: string[] = [];
    for (const stmt of body) {
      bodyCode.push(this.processNode(stmt));
    }
    this.functionScopedVariables = [];
    this.adjacentNodes[nodeName] = [...this.currentAdjacentNodes];
    this.isInsideGraphNode = false;

    const paramNames = "[" + parameters.map((p) => p.name).join(", ") + "]";

    return renderGraphNode.default({
      name: nodeName,
      /* returnType: node.returnType
        ? variableTypeToString(node.returnType, this.typeAliases)
        : "any", */
      body: bodyCode.join("\n"),
      hasParam: parameters.length > 0,
      paramNames,
    });
  }

  protected processFunctionCall(node: FunctionCall): string {
    const isGraphNode = this.graphNodes
      .map((n) => n.nodeName)
      .includes(node.functionName);
    const isImportedGraphNode = this.importedNodes
      .map((n) => n.importedNodes)
      .flat()
      .includes(node.functionName);

    if (isGraphNode || isImportedGraphNode) {
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
        /*       } else if (arg.type === "accessExpression") {
        return this.processAccessExpression(arg);
      } else if (arg.type === "indexAccess") {
        return this.processIndexAccess(arg);
 */
      } else {
        return this.processNode(arg);
        //        return this.generateLiteral(arg);
      }
    });
    /* const argNames =
      this.graphNodes
        .find((n) => n.nodeName === node.functionName)
        ?.parameters.map((p) => p.name) || [];
    const pairedArgs = argNames.map((name, index) => {
      return `${name}: ${parts[index]}`;
    });
    const argsString = "{" + pairedArgs.join(", ") + "}"; */
    const argsString = "[" + parts.join(", ") + "]";
    return goToNode.default({
      nodeName: functionName,
      hasData: parts.length > 0,
      data: argsString,
    });
  } /* 

  protected generateLiteral(literal: Literal): string {
    return "generateLiteral not implemented";
  } */

  protected generateImports(): string {
    let arr = [
      renderImports.default({
        nodes: JSON.stringify(this.graphNodes.map((n) => n.nodeName)),
      }),
    ];
    arr.push(builtinTools.default({}));
    return arr.join("\n");
  }

  protected preprocess(): string {
    const lines: string[] = [];
    lines.push("// @ts-nocheck\n");
    this.importedNodes.forEach((importNode) => {
      const defaultImportName = this.agencyFileToDefaultImportName(
        importNode.agencyFile,
      );
      lines.push(
        `import ${defaultImportName} from "${importNode.agencyFile.replace(".agency", ".ts")}";`,
      );
    });

    return lines.join("\n");
  }

  private agencyFileToDefaultImportName(agencyFile: string): string {
    return `__graph_${agencyFile.replace(".agency", "").replace(/[^a-zA-Z0-9_]/g, "_")}`;
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
        }),
      );
    });

    this.importedNodes.forEach((importNode) => {
      const defaultImportName = this.agencyFileToDefaultImportName(
        importNode.agencyFile,
      );
      lines.push(`graph.merge(${defaultImportName});`);
    });

    if (this.graphNodes.map((n) => n.nodeName).includes("main")) {
      lines.push(
        renderStartNode.default({
          startNode: "main",
        }),
      );
    }

    for (const node of this.graphNodes) {
      const args = node.parameters;
      const argsStr = args.map((arg) => arg.name).join(", ");
      lines.push(
        renderRunNodeFunction.default({
          nodeName: node.nodeName,
          // argsStr,
          returnType: node.returnType
            ? variableTypeToString(node.returnType, this.typeAliases)
            : "any",
        }),
      );
    }

    lines.push("export default graph;");

    return lines.join("\n");
  }
}

export function generateGraph(program: AgencyProgram): string {
  const generator = new GraphGenerator();
  return generator.generate(program).output;
}
