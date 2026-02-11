import {
  AgencyNode,
  AgencyProgram,
  FunctionCall,
  FunctionDefinition,
  PromptLiteral,
} from "@/types.js";
import { renderMermaidAscii } from "beautiful-mermaid";

export class TypescriptPreprocessor {
  public program: AgencyProgram;
  protected functionNameToAsync: Record<string, boolean> = {};
  protected functionNameToUsesInterrupt: Record<string, boolean> = {};
  protected functionDefinitions: Record<string, FunctionDefinition> = {};
  constructor(program: AgencyProgram) {
    this.program = structuredClone(program);
  }

  preprocess(): AgencyProgram {
    this.getFunctionDefinitions();
    this.collectTools();
    this.markFunctionsAsync();
    this.markFunctionCallsAsync();
    const mermaid = this.renderMermaid();
    console.log("Program Mermaid Diagram:\n");
    mermaid.forEach((subgraph) => {
      const ascii = renderMermaidAscii(subgraph);
      console.log(ascii);
    });
    return this.program;
  }

  protected getFunctionDefinitions() {
    for (const node of this.program.nodes) {
      if (node.type === "function") {
        this.functionDefinitions[node.functionName] = node;
      }
    }
  }

  protected collectTools(): void {
    for (const node of this.program.nodes) {
      if (node.type === "function" || node.type === "graphNode") {
        this.collectToolsInFunction(node.body);
        node.body = node.body.filter((n) => n.type !== "usesTool");
      }
    }
  }

  protected collectToolsInFunction(body: AgencyNode[]): void {
    let toolsUsed: string[] = [];
    body.forEach((node) => {
      if (node.type === "usesTool") {
        toolsUsed.push(...node.toolNames);
      } else if (node.type === "prompt") {
        node.tools = { type: "usesTool", toolNames: toolsUsed };
        toolsUsed = [];
      }
    });
  }

  protected markFunctionsAsync(): void {
    if (this.program === null) {
      throw new Error("Program is not set in generator.");
    }
    const sortedFunctions = this.topologicalSortFunctions();
    for (const node of sortedFunctions) {
      this._markFunctionAsAsync(node);
    }
  }

  protected markFunctionCallsAsync(): void {
    if (this.program === null) {
      throw new Error("Program is not set in generator.");
    }
    for (const node of this.walkNodes(this.program.nodes)) {
      if (node.type === "functionCall") {
        const isAsync = this.functionNameToAsync[node.functionName];
        if (isAsync) {
          node.async = true;
        }
      } else if (node.type === "prompt") {
        if (node.async !== undefined) {
          continue; // already marked as async or sync
        }
        // streaming prompts are always async for now.
        // later we'll make them async but with a lock around the stream callback.
        if (node.isStreaming) {
          continue;
        }
        // check if any of its tools will throw an interrupt
        node.async =
          node.tools?.toolNames.some((toolName) => {
            const usesInterrupt =
              this.functionNameToUsesInterrupt[toolName] ?? false;
            return usesInterrupt;
          }) || true;
      }
    }
  }

  protected _markFunctionAsAsync(node: FunctionDefinition): void {
    if (this.functionNameToAsync[node.functionName] !== undefined) {
      return; // already processed
    }
    if (node.async !== undefined) {
      this.functionNameToAsync[node.functionName] = node.async;
      return; // user has already marked this sync or async
    }
    let isAsync = true;
    if (this.containsInterrupt(node)) {
      isAsync = false;
    }
    this.functionNameToAsync[node.functionName] = isAsync;
    node.async = isAsync;
  }

  protected containsInterrupt(node: FunctionDefinition): boolean {
    if (this.functionNameToUsesInterrupt[node.functionName] !== undefined) {
      return this.functionNameToUsesInterrupt[node.functionName];
    }

    for (const subnode of this.walkNodes(node.body)) {
      if (subnode.type === "functionCall") {
        if (subnode.functionName === "interrupt") {
          this.functionNameToUsesInterrupt[node.functionName] = true;
          return true;
        }
        const func = this.functionDefinitions[subnode.functionName];
        if (func && this.containsInterrupt(func)) {
          this.functionNameToUsesInterrupt[node.functionName] = true;
          return true;
        }
      } else if (subnode.type === "usesTool") {
        for (const toolName of subnode.toolNames) {
          const func = this.functionDefinitions[toolName];
          if (func && this.containsInterrupt(func)) {
            this.functionNameToUsesInterrupt[node.functionName] = true;
            return true;
          }
        }
      }
    }

    return false;
  }

  protected *walkNodes(nodes: AgencyNode[]): Generator<AgencyNode> {
    for (const node of nodes) {
      yield node;
      if (node.type === "function") {
        yield* this.walkNodes(node.body);
      } else if (node.type === "graphNode") {
        yield* this.walkNodes(node.body);
      } else if (node.type === "ifElse") {
        yield* this.walkNodes(node.thenBody);
        if (node.elseBody) {
          yield* this.walkNodes(node.elseBody);
        }
      } else if (node.type === "whileLoop") {
        yield* this.walkNodes(node.body);
      } else if (node.type === "timeBlock") {
        yield* this.walkNodes(node.body);
      } else if (node.type === "returnStatement") {
        yield* this.walkNodes([node.value]);
      } else if (node.type === "assignment") {
        yield* this.walkNodes([node.value]);
      } else if (node.type === "functionCall") {
        yield* this.walkNodes(node.arguments);
      } else if (node.type === "matchBlock") {
        for (const caseItem of node.cases) {
          if (caseItem.type === "comment") continue;
          if (caseItem.caseValue !== "_") {
            yield* this.walkNodes([caseItem.caseValue]);
          }
          yield* this.walkNodes([caseItem.body]);
        }
      } else if (node.type === "accessExpression") {
        const expr = node.expression;
        if (expr.type === "dotProperty") {
          yield* this.walkNodes([expr.object]);
        } else if (expr.type === "indexAccess") {
          yield* this.walkNodes([expr.array]);
          yield* this.walkNodes([expr.index]);
        } else if (expr.type === "dotFunctionCall") {
          yield* this.walkNodes([expr.object]);
          yield* this.walkNodes([expr.functionCall]);
        }
      } else if (node.type === "dotProperty") {
        yield* this.walkNodes([node.object]);
      } else if (node.type === "indexAccess") {
        yield* this.walkNodes([node.array]);
        yield* this.walkNodes([node.index]);
      } else if (node.type === "agencyArray") {
        yield* this.walkNodes(node.items);
      } else if (node.type === "agencyObject") {
        yield* this.walkNodes(node.entries.map((e) => e.value));
      } else if (node.type === "awaitStatement") {
        yield* this.walkNodes([node.expression]);
      } else if (node.type === "specialVar") {
        yield* this.walkNodes([node.value]);
      }
    }
  }

  private prettifyName(call: FunctionCall | PromptLiteral): string {
    if (call.type === "functionCall") {
      return call.functionName;
    } else if (call.type === "prompt") {
      const stringified = call.segments
        .map((seg) =>
          seg.type === "text" ? seg.value : `{${seg.variableName}}`,
        )
        .join("__")
        .substring(0, 20);
      return `"llm(${stringified})"`;
    }
    return "unknown";
  }

  public renderMermaid(): string[] {
    // "graph TD"
    const lines: string[] = [];
    const labelLines: string[] = [];
    let nodeCounter = 0;
    const nextId = () => `n${nodeCounter++}`;

    const addToolsLabel = (
      call: FunctionCall | PromptLiteral,
      callId: string,
    ) => {
      if (call.type === "prompt" && call.tools?.toolNames.length) {
        const labelId = nextId();
        const toolsList = call.tools.toolNames.join(", ");
        labelLines.push(`  ${labelId}([tools: ${toolsList}]):::toolLabel`);
        labelLines.push(`  ${callId} -.- ${labelId}`);
      }
    };

    for (const node of this.program.nodes) {
      if (node.type !== "function" && node.type !== "graphNode") continue;
      const sublines: string[] = ["graph LR"];
      const name = node.type === "function" ? node.functionName : node.nodeName;
      const isGraphNode = node.type === "graphNode";

      const functionCalls = this.extractFunctionCalls(node.body);
      // if (functionCalls.length === 0) continue;

      sublines.push(`  subgraph ${name}`);

      // Start node: circles for graph nodes, squares for functions
      const startId = nextId();
      if (isGraphNode) {
        sublines.push(`    ${startId}((${name}))`);
      } else {
        sublines.push(`    ${startId}[${name}]`);
      }

      // Group consecutive calls by async/sync
      const groups = this.groupCallsByAsync(functionCalls);
      let previousEnds: string[] = [startId];

      for (const group of groups) {
        if (group.type === "sync") {
          // Sync calls are consecutive: chain one after another
          for (const call of group.calls) {
            const callId = nextId();
            sublines.push(`    ${callId}[${this.prettifyName(call)}]`);
            for (const prev of previousEnds) {
              sublines.push(`    ${prev} --> ${callId}`);
            }
            addToolsLabel(call, callId);
            previousEnds = [callId];
          }
        } else {
          // Async calls are parallel: fork from previous, converge to next
          const parallelIds: string[] = [];
          for (const call of group.calls) {
            const callId = nextId();
            sublines.push(`    ${callId}[${this.prettifyName(call)}]`);
            for (const prev of previousEnds) {
              sublines.push(`    ${prev} --> ${callId}`);
            }
            addToolsLabel(call, callId);
            parallelIds.push(callId);
          }
          previousEnds = parallelIds;
        }
      }

      sublines.push(`  end`);
      lines.push(sublines.join("\n"));
    }

    const endlines: string[] = [];

    endlines.push(`  classDef toolLabel fill:#333333,stroke-dasharray:5 5`);
    endlines.push(...labelLines);
    //lines.push(endlines.join("\n"));
    return lines;
  }

  protected extractFunctionCalls(
    body: AgencyNode[],
  ): (FunctionCall | PromptLiteral)[] {
    const calls: (FunctionCall | PromptLiteral)[] = [];
    for (const node of this.walkNodes(body)) {
      if (node.type === "functionCall") {
        calls.push(node);
      } else if (node.type === "prompt") {
        calls.push(node);
        /*         const stringified = node.segments
          .map((seg) =>
            seg.type === "text" ? seg.value : `{${seg.variableName}}`,
          )
          .join("__")
          .substring(0, 20);
        calls.push(`llm(${stringified})`);
 */
      }
    }
    return calls;
  }

  protected groupCallsByAsync(
    calls: (FunctionCall | PromptLiteral)[],
  ): { type: "sync" | "async"; calls: (FunctionCall | PromptLiteral)[] }[] {
    const groups: {
      type: "sync" | "async";
      calls: (FunctionCall | PromptLiteral)[];
    }[] = [];
    for (const call of calls) {
      const callType = call.async ? "async" : "sync";
      const lastGroup = groups[groups.length - 1];
      if (lastGroup && lastGroup.type === callType) {
        lastGroup.calls.push(call);
      } else {
        groups.push({ type: callType, calls: [call] });
      }
    }
    return groups;
  }

  protected topologicalSortFunctions(): FunctionDefinition[] {
    const visited: Set<string> = new Set();
    const sorted: FunctionDefinition[] = [];

    const visit = (funcName: string) => {
      if (visited.has(funcName)) {
        return;
      }
      visited.add(funcName);

      const funcDef = this.functionDefinitions[funcName];
      if (funcDef) {
        for (const stmt of funcDef.body) {
          if (stmt.type === "functionCall") {
            visit(stmt.functionName);
          }
        }
        sorted.push(funcDef);
      }
    };
    for (const funcName of Object.keys(this.functionDefinitions)) {
      visit(funcName);
    }
    return sorted.reverse();
  }
}
