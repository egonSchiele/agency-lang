import {
  AgencyProgram,
  FunctionCall,
  TypeHintMap,
  VariableType,
} from "../types.js";

import { AgencyConfig } from "@/config.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import * as builtinTools from "../templates/backends/graphGenerator/builtinTools.js";
import * as renderConditionalEdge from "../templates/backends/graphGenerator/conditionalEdge.js";
import * as goToNode from "../templates/backends/graphGenerator/goToNode.js";
import * as renderGraphNode from "../templates/backends/graphGenerator/graphNode.js";
import * as renderImports from "../templates/backends/graphGenerator/imports.js";
import * as renderInitializeMessageThread from "../templates/backends/graphGenerator/initializeMessageThread.js";
import * as renderRunNodeFunction from "../templates/backends/graphGenerator/runNodeFunction.js";
import * as renderStartNode from "../templates/backends/graphGenerator/startNode.js";
import { GraphNodeDefinition } from "../types/graphNode.js";
import { ReturnStatement } from "../types/returnStatement.js";
import { TypeScriptGenerator } from "./typescriptGenerator.js";
import { mapFunctionName } from "./typescriptGenerator/builtins.js";

export class GraphGenerator extends TypeScriptGenerator {
  protected typeHints: TypeHintMap = {};
  protected generatedStatements: string[] = [];
  protected generatedTypeAliases: string[] = [];
  protected typeAliases: Record<string, VariableType> = {};
  protected functionsUsed: Set<string> = new Set();
  protected adjacentNodes: Record<string, string[]> = {};
  protected currentAdjacentNodes: string[] = [];
  protected isInsideGraphNode: boolean = false;
  constructor(args: { config?: AgencyConfig } = {}) {
    super(args);
  }

  configDefaults(): Partial<AgencyConfig> {
    return {
      log: {
        host: "https://agency-lang.com",
      },
      client: {
        logLevel: "warn",
        defaultModel: "gpt-4o-mini",
      },
    };
  }

  protected processReturnStatement(node: ReturnStatement): string {
    if (!this.isInsideGraphNode) {
      return super.processReturnStatement(node);
    } else {
      const returnCode = this.processNode(node.value);
      if (node.value.type === "functionCall") {
        if (this.isGraphNode(node.value.functionName)) {
          // we're going to return a goToNode call, so just return that directly
          return `return ${returnCode}\n`;
        }
      }
      return `return { messages: __stack.messages, data: ${returnCode}}\n`;
    }
  }

  protected processGraphNodeName(node: GraphNodeDefinition): void {
    this.graphNodes.push(node);
  }

  protected processGraphNode(node: GraphNodeDefinition): string {
    this.startScope({ type: "node", nodeName: node.nodeName });
    const { nodeName, body, parameters } = node;
    /* if (parameters.length > 1) {
      throw new Error(
        `Graph node '${nodeName}' has more than one parameter. Only one parameter is supported for now.`,
      );
    } */
    this.adjacentNodes[nodeName] = [];
    this.currentAdjacentNodes = [];
    this.isInsideGraphNode = true;

    for (const stmt of body) {
      if (stmt.type === "functionCall" && this.isGraphNode(stmt.functionName)) {
        throw new Error(
          `Call to graph node '${stmt.functionName}' inside graph node '${nodeName}' was not returned. All calls to graph nodes must be returned, eg (return ${stmt.functionName}(...)).`,
        );
      }
    }

    const bodyCode = this.processBodyAsParts(body);

    this.adjacentNodes[nodeName] = [...this.currentAdjacentNodes];
    this.isInsideGraphNode = false;
    this.endScope();
    const paramNames =
      "[" + parameters.map((p) => `"${p.name}"`).join(", ") + "]";

    return renderGraphNode.default({
      name: nodeName,
      /* returnType: node.returnType
        ? variableTypeToString(node.returnType, this.typeAliases)
        : "any", */
      body: bodyCode.join("\n"),
      hasParam: parameters.length > 0,
      paramNames,
      initializeMessageThreads: this.initializeMessageThreads(
        node.threadIds || [],
      ),
    });
  }

  protected initializeMessageThreads(threadIds: string[]): string {
    const lines = threadIds.map((threadId, index) => {
      return renderInitializeMessageThread.default({ index: threadId });
    });
    return lines.join("\n");
  }

  private isGraphNode(functionName: string): boolean {
    return (
      this.graphNodes.map((n) => n.nodeName).includes(functionName) ||
      this.importedNodes
        .map((n) => n.importedNodes)
        .flat()
        .includes(functionName)
    );
  }

  protected processFunctionCall(node: FunctionCall): string {
    if (this.isGraphNode(node.functionName)) {
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
    /* if (this.agencyConfig.verbose) {
      console.log("Generating imports with config:", this.agencyConfig);
    } */
    const args = {
      logHost: this.agencyConfig.log?.host || "",
      logProjectId: this.agencyConfig.log?.projectId || "",
      hasApiKey: !!this.agencyConfig.log?.apiKey,
      logApiKey: this.agencyConfig.log?.apiKey || undefined,
      logDebugMode: this.agencyConfig.log?.debugMode || false,
      clientLogLevel: this.agencyConfig.client?.logLevel || "warn",
      clientDefaultModel:
        this.agencyConfig.client?.defaultModel || "gpt-4o-mini",
      hasOpenAiApiKey: !!this.agencyConfig.client?.openAiApiKey,
      clientOpenAiApiKey: this.agencyConfig.client?.openAiApiKey || undefined,
      hasGoogleApiKey: !!this.agencyConfig.client?.googleApiKey,
      clientGoogleApiKey: this.agencyConfig.client?.googleApiKey || undefined,
    };

    const arr = [renderImports.default(args)];
    arr.push(builtinTools.default({}));
    return arr.join("\n");
  }

  protected preprocess(): string {
    const lines: string[] = [];
    this.importedNodes.forEach((importNode) => {
      const defaultImportName = this.agencyFileToDefaultImportName(
        importNode.agencyFile,
      );
      lines.push(
        `import ${defaultImportName} from "${importNode.agencyFile.replace(".agency", ".js")}";`,
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

    for (const node of this.graphNodes) {
      const args = node.parameters;
      const argsStr = args.map((arg) => arg.name).join(", ");
      lines.push(
        renderRunNodeFunction.default({
          nodeName: node.nodeName,
          hasArgs: args.length > 0,
          argsStr,
        }),
      );
    }

    if (this.graphNodes.map((n) => n.nodeName).includes("main")) {
      lines.push(
        renderStartNode.default({
          startNode: "main",
        }),
      );
    }

    lines.push("export default graph;");

    return lines.join("\n");
  }
}

export function generateGraph(
  program: AgencyProgram,
  config?: AgencyConfig,
): string {
  const preprocessor = new TypescriptPreprocessor(program, config);
  const preprocessedProgram = preprocessor.preprocess();

  const generator = new GraphGenerator({ config });
  return generator.generate(preprocessedProgram).output;
}
