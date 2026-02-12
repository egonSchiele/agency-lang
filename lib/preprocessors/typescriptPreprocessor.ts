import {
  AgencyNode,
  AgencyProgram,
  FunctionCall,
  FunctionDefinition,
  PromptLiteral,
  RawCode,
  IfElse,
  WhileLoop,
  TimeBlock,
} from "@/types.js";
import { AgencyConfig } from "@/config.js";

export class TypescriptPreprocessor {
  public program: AgencyProgram;
  protected config: AgencyConfig;
  protected functionNameToAsync: Record<string, boolean> = {};
  protected functionNameToUsesInterrupt: Record<string, boolean> = {};
  protected functionDefinitions: Record<string, FunctionDefinition> = {};
  constructor(program: AgencyProgram, config: AgencyConfig = {}) {
    this.program = structuredClone(program);
    this.config = config;
  }

  preprocess(): AgencyProgram {
    this.getFunctionDefinitions();
    this.collectTools();
    this.markFunctionsAsync();
    this.markFunctionCallsAsync();
    this.removeUnusedLlmCalls();
    this.addPromiseAllCalls();
    this.filterExcludedNodeTypes();
    this.filterExcludedBuiltinFunctions();
    this.validateFetchDomains();
    return this.program;
  }

  protected removeUnusedLlmCalls(): void {
    for (const node of this.program.nodes) {
      if (node.type === "function" || node.type === "graphNode") {
        node.body = this._removeUnusedLlmCalls(node.body);
      }
    }
  }

  protected promptLiteralToString(prompt: PromptLiteral): string {
    return prompt.segments
      .map((seg) => (seg.type === "text" ? seg.value : `{${seg.variableName}}`))
      .join("");
  }

  protected _removeUnusedLlmCalls(body: AgencyNode[]): AgencyNode[] {
    const newBody: AgencyNode[] = [];
    for (const node of body) {
      if (node.type === "prompt") {
        // console.log(JSON.stringify(node));
        // console.log(JSON.stringify(this.functionNameToAsync));
        const hasSyncTools = node.tools
          ? node.tools.toolNames.some(
              (t) => this.functionNameToAsync[t] === false,
            )
          : false;
        // console.log({ hasSyncTools });
        if (!hasSyncTools) {
          /* skip this LLM call since it isn't using any tools that have side effects,
          isn't being assigned to a variable, and isn't being returned. */
          newBody.push({
            type: "comment",
            content: `Removed unused LLM call: "${this.promptLiteralToString(node)}"`,
          });
          continue;
        }
      }

      // if it is being assigned to a variable, check if that variable is used anywhere else in the body.
      if (node.type === "assignment" && node.value.type === "prompt") {
        const hasSyncTools = node.value.tools
          ? node.value.tools.toolNames.some(
              (t) => this.functionNameToAsync[t] === false,
            )
          : false;
        if (hasSyncTools) {
          // has sync tools, which means they have a side effect,
          // so we need to keep this llm call.
          newBody.push(node);
        } else {
          const isUsed = this.isVarUsedInBody(node.variableName, node, body);
          if (isUsed) {
            newBody.push(node);
          } else {
            newBody.push({
              type: "comment",
              content: `Removed unused LLM call "${this.promptLiteralToString(node.value)}", was assigned to variable '${node.variableName}' but variable was never used.`,
            });
            continue;
          }
        }
      } else if (
        node.type === "returnStatement" &&
        node.value.type === "prompt"
      ) {
        // returning an llm call, keep it.
        // future improvement: check if the return value is used anywhere.
        newBody.push(node);
      } else {
        newBody.push(node);
      }
    }
    return newBody;
  }

  protected isVarUsedInBody(
    variableName: string,
    nodeToExclude: AgencyNode,
    body: AgencyNode[],
  ): boolean {
    for (const { name, node } of this.getAllVariablesInBody(body)) {
      if (node === nodeToExclude) {
        continue; // skip the variable declaration/assignment itself
      }
      if (name === variableName) {
        return true;
      }
    }
    return false;
  }

  protected *getAllVariablesInBody(
    body: AgencyNode[],
  ): Generator<{ name: string; node: AgencyNode }> {
    for (const node of this.walkNodes(body)) {
      if (node.type === "assignment") {
        yield { name: node.variableName, node };
        yield* this.getAllVariablesInBody([node.value as AgencyNode]);
      } else if (node.type === "function") {
        yield { name: node.functionName, node };
        for (const param of node.parameters) {
          yield { name: param.name, node };
        }
        yield* this.getAllVariablesInBody(node.body);
      } else if (node.type === "graphNode") {
        yield { name: node.nodeName, node };
        for (const param of node.parameters) {
          yield { name: param.name, node };
        }
        yield* this.getAllVariablesInBody(node.body);
      } else if (node.type === "ifElse") {
        yield* this.getAllVariablesInBody(node.thenBody);
        if (node.elseBody) {
          yield* this.getAllVariablesInBody(node.elseBody);
        }
      } else if (node.type === "functionCall") {
        for (const arg of node.arguments) {
          yield* this.getAllVariablesInBody([arg]);
        }
        yield { name: node.functionName, node };
      } else if (node.type === "specialVar") {
        yield { name: node.name, node };
      } else if (node.type === "importStatement") {
        yield { name: node.importedNames, node };
      } else if (node.type === "importNodeStatement") {
        for (const name of node.importedNodes) {
          yield { name, node };
        }
      } else if (node.type === "importToolStatement") {
        for (const name of node.importedTools) {
          yield { name, node };
        }
      } else if (node.type === "matchBlock") {
        for (const caseItem of node.cases) {
          if (caseItem.type === "comment") continue;
          if (caseItem.caseValue === "_") continue;
          yield* this.getAllVariablesInBody([caseItem.caseValue]);
        }
      } else if (node.type === "variableName") {
        yield { name: node.value, node };
      } else if (node.type === "indexAccess") {
        if (node.array.type === "variableName") {
          yield { name: node.array.value, node: node.array };
        }
        if (node.index.type === "variableName") {
          yield { name: node.index.value, node: node.index };
        }
      } else if (node.type === "dotProperty") {
        if (node.object.type === "variableName") {
          yield { name: node.object.value, node: node.object };
        }
      } else if (node.type === "accessExpression") {
        if (node.expression.type === "dotFunctionCall") {
          if (node.expression.object.type === "variableName") {
            yield {
              name: node.expression.object.value,
              node: node.expression.object,
            };
          }
        } else if (node.expression.type === "dotProperty") {
          yield* this.getAllVariablesInBody([node.expression.object]);
        }
      } else if (node.type === "agencyArray") {
        for (const item of node.items) {
          yield* this.getAllVariablesInBody([item]);
        }
      } else if (node.type === "agencyObject") {
        for (const entry of node.entries) {
          yield* this.getAllVariablesInBody([entry.value]);
        }
      } else if (
        node.type === "prompt" ||
        node.type === "string" ||
        node.type === "multiLineString"
      ) {
        for (const seg of node.segments) {
          if (seg.type === "interpolation") {
            yield { name: seg.variableName, node };
          }
        }
        if (node.type === "prompt") {
          for (const toolName of node.tools?.toolNames ?? []) {
            yield { name: toolName, node };
          }
        }
      } else if (node.type === "returnStatement") {
        yield* this.getAllVariablesInBody([node.value]);
      } else if (node.type === "whileLoop") {
        yield* this.getAllVariablesInBody(node.body);
      } else if (node.type === "timeBlock") {
        yield* this.getAllVariablesInBody(node.body);
      }
    }
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
        // if (node.isStreaming) {
        //   continue;
        // }
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

  protected addPromiseAllCalls(): void {
    for (const node of this.program.nodes) {
      if (node.type === "function" || node.type === "graphNode") {
        node.body = this._addPromiseAllCalls(node.body);
      }
    }
  }

  protected _addPromiseAllCalls(body: AgencyNode[]): AgencyNode[] {
    // Find all variables assigned to async function calls or LLM calls
    const asyncVarToAssignment: Record<string, AgencyNode> = {};

    for (const node of body) {
      if (this.nodeHasBody(node)) {
        // recursively process nested bodies first
        // @ts-ignore
        node.body = this._addPromiseAllCalls(node.body);
      }

      if (node.type === "assignment") {
        const isAsyncCall =
          (node.value.type === "functionCall" && node.value.async) ||
          (node.value.type === "prompt" && node.value.async);

        if (isAsyncCall) {
          asyncVarToAssignment[node.variableName] = node;
        }
      }
    }

    const asyncVars = Object.keys(asyncVarToAssignment);
    // Find the first usage of each async variable
    const varToFirstUsageIndex: Record<string, number> = {};

    for (const varName of asyncVars) {
      const assignmentNode = asyncVarToAssignment[varName];

      for (let i = 0; i < body.length; i++) {
        const node = body[i];

        // Skip the assignment itself
        if (node === assignmentNode) {
          continue;
        }

        // Check if this node uses the variable
        if (this._nodeUsesVariable(node, varName)) {
          varToFirstUsageIndex[varName] = i;
          break;
        }
      }
    }

    // Group variables by their first usage index
    const indexToVars: Record<number, string[]> = {};

    for (const varName of Object.keys(varToFirstUsageIndex)) {
      const index = varToFirstUsageIndex[varName];
      if (!indexToVars[index]) {
        indexToVars[index] = [];
      }
      indexToVars[index].push(varName);
    }

    // Insert Promise.all calls before first usage
    const newBody: AgencyNode[] = [];

    for (let i = 0; i < body.length; i++) {
      // Check if we need to insert Promise.all before this node
      if (indexToVars[i]) {
        const vars = indexToVars[i];

        const varArray = `[${vars.map((v) => `__self.${v}`).join(", ")}]`;
        const promiseAllCode: RawCode = {
          type: "rawCode",
          value: `${varArray} = await Promise.all(${varArray});`,
        };
        newBody.push(promiseAllCode);
      }

      newBody.push(body[i]);
    }

    return newBody;
  }

  protected nodeHasBody(
    node: AgencyNode,
  ): node is FunctionDefinition | AgencyNode | IfElse | WhileLoop | TimeBlock {
    return (
      node.type === "function" ||
      node.type === "graphNode" ||
      node.type === "ifElse" ||
      node.type === "whileLoop" ||
      node.type === "timeBlock"
    );
  }

  protected _nodeUsesVariable(node: AgencyNode, varName: string): boolean {
    // Check if the node or any of its children use the variable
    for (const { name } of this.getAllVariablesInBody([node])) {
      if (name === varName) {
        return true;
      }
    }
    return false;
  }

  /**
   * Filter out nodes based on excludeNodeTypes config
   */
  protected filterExcludedNodeTypes(): void {
    if (
      !this.config.excludeNodeTypes ||
      this.config.excludeNodeTypes.length === 0
    ) {
      return;
    }

    const excludeSet = new Set(this.config.excludeNodeTypes);
    this.program.nodes = this.filterNodesByType(this.program.nodes, excludeSet);
  }

  /**
   * Recursively filter nodes by type, handling all node structures
   */
  protected filterNodesByType(
    nodes: AgencyNode[],
    excludeSet: Set<string>,
  ): AgencyNode[] {
    const filteredNodes: AgencyNode[] = [];

    for (const node of nodes) {
      // Skip nodes of excluded types
      if (excludeSet.has(node.type)) {
        continue;
      }

      // Recursively filter child nodes
      if (node.type === "function" || node.type === "graphNode") {
        node.body = this.filterNodesByType(node.body, excludeSet);
      } else if (node.type === "ifElse") {
        node.thenBody = this.filterNodesByType(node.thenBody, excludeSet);
        if (node.elseBody) {
          node.elseBody = this.filterNodesByType(node.elseBody, excludeSet);
        }
      } else if (node.type === "whileLoop") {
        node.body = this.filterNodesByType(node.body, excludeSet);
      } else if (node.type === "timeBlock") {
        node.body = this.filterNodesByType(node.body, excludeSet);
      } else if (node.type === "matchBlock") {
        // Filter case bodies - Note: match block bodies are single nodes, not arrays
        // We don't filter them here as they're of a specific type
      } else if (node.type === "assignment") {
        node.value = (this.filterNodesByType(
          [node.value as AgencyNode],
          excludeSet,
        )[0] || node.value) as any;
      } else if (node.type === "functionCall") {
        node.arguments = this.filterNodesByType(
          node.arguments as AgencyNode[],
          excludeSet,
        ) as any[];
      } else if (node.type === "agencyArray") {
        node.items = this.filterNodesByType(
          node.items as AgencyNode[],
          excludeSet,
        ) as any[];
      } else if (node.type === "agencyObject") {
        node.entries = node.entries.map((entry) => ({
          ...entry,
          value: (this.filterNodesByType(
            [entry.value as AgencyNode],
            excludeSet,
          )[0] || entry.value) as any,
        }));
      }

      filteredNodes.push(node);
    }

    return filteredNodes;
  }

  /**
   * Filter out builtin function calls based on excludeBuiltinFunctions config
   */
  protected filterExcludedBuiltinFunctions(): void {
    if (
      !this.config.excludeBuiltinFunctions ||
      this.config.excludeBuiltinFunctions.length === 0
    ) {
      return;
    }

    const excludeSet = new Set(this.config.excludeBuiltinFunctions);
    this.program.nodes = this.filterBuiltinFunctionCalls(
      this.program.nodes,
      excludeSet,
    );
  }

  /**
   * Recursively filter builtin function calls
   */
  protected filterBuiltinFunctionCalls(
    nodes: AgencyNode[],
    excludeSet: Set<string>,
  ): AgencyNode[] {
    const filteredNodes: AgencyNode[] = [];

    for (const node of nodes) {
      // Skip excluded builtin function calls
      if (node.type === "functionCall" && excludeSet.has(node.functionName)) {
        continue;
      }

      // Skip assignments to excluded builtin function calls
      if (
        node.type === "assignment" &&
        node.value.type === "functionCall" &&
        excludeSet.has(node.value.functionName)
      ) {
        continue;
      }

      // Recursively filter child nodes
      if (node.type === "function" || node.type === "graphNode") {
        node.body = this.filterBuiltinFunctionCalls(node.body, excludeSet);
      } else if (node.type === "ifElse") {
        node.thenBody = this.filterBuiltinFunctionCalls(
          node.thenBody,
          excludeSet,
        );
        if (node.elseBody) {
          node.elseBody = this.filterBuiltinFunctionCalls(
            node.elseBody,
            excludeSet,
          );
        }
      } else if (node.type === "whileLoop") {
        node.body = this.filterBuiltinFunctionCalls(node.body, excludeSet);
      } else if (node.type === "timeBlock") {
        node.body = this.filterBuiltinFunctionCalls(node.body, excludeSet);
      } else if (node.type === "matchBlock") {
        node.cases = node.cases.map((caseItem) => {
          if (caseItem.type === "comment") {
            return caseItem;
          }
          return {
            ...caseItem,
            body: this.filterBuiltinFunctionCalls(
              [caseItem.body],
              excludeSet,
            )[0],
          } as any;
        });
      } else if (node.type === "functionCall") {
        // Filter arguments that are function calls
        node.arguments = this.filterBuiltinFunctionCalls(
          node.arguments as AgencyNode[],
          excludeSet,
        ) as any[];
      } else if (node.type === "agencyArray") {
        node.items = this.filterBuiltinFunctionCalls(
          node.items as AgencyNode[],
          excludeSet,
        ) as any[];
      } else if (node.type === "agencyObject") {
        node.entries = node.entries.map((entry) => {
          const filteredValues = this.filterBuiltinFunctionCalls(
            [entry.value as AgencyNode],
            excludeSet,
          );
          return {
            ...entry,
            value: filteredValues[0] || entry.value,
          } as any;
        });
      }

      filteredNodes.push(node);
    }

    return filteredNodes;
  }

  /**
   * Validate fetch calls against allowed/disallowed domains
   */
  protected validateFetchDomains(): void {
    const hasAllowed =
      this.config.allowedFetchDomains &&
      this.config.allowedFetchDomains.length > 0;
    const hasDisallowed =
      this.config.disallowedFetchDomains &&
      this.config.disallowedFetchDomains.length > 0;

    if (!hasAllowed && !hasDisallowed) {
      return; // No domain restrictions
    }

    // Compute the effective allowed domains
    let effectiveAllowed: Set<string> | null = null;

    if (hasAllowed) {
      effectiveAllowed = new Set(this.config.allowedFetchDomains);

      // If both allowed and disallowed are set, remove disallowed from allowed
      if (hasDisallowed) {
        for (const domain of this.config.disallowedFetchDomains!) {
          effectiveAllowed.delete(domain);
        }
      }
    }

    const disallowedSet = hasDisallowed
      ? new Set(this.config.disallowedFetchDomains)
      : new Set<string>();

    // Walk through all nodes and validate fetch calls
    for (const node of this.walkNodes(this.program.nodes)) {
      if (
        node.type === "functionCall" &&
        (node.functionName === "fetch" ||
          node.functionName === "fetchJSON" ||
          node.functionName === "fetchJson")
      ) {
        this._validateFetchCall(node, effectiveAllowed, disallowedSet);
      }
    }
  }

  /**
   * Validate a single fetch call's domain
   */
  protected _validateFetchCall(
    node: FunctionCall,
    effectiveAllowed: Set<string> | null,
    disallowedSet: Set<string>,
  ): void {
    // Get the URL argument (first argument to fetch)
    if (node.arguments.length === 0) {
      return; // No URL provided, let it fail at runtime
    }

    const urlArg = node.arguments[0];
    let url: string | null = null;

    // Extract URL if it's a string literal
    if (urlArg.type === "string") {
      // Reconstruct the URL from segments
      url = urlArg.segments
        .map((seg) => (seg.type === "text" ? seg.value : ""))
        .join("");
    }

    if (!url) {
      return; // Can't validate variable URLs at compile time
    }

    // Extract domain from URL
    const domain = this._extractDomain(url);
    if (!domain) {
      return; // Can't extract domain, skip validation
    }

    // Check if domain is allowed
    if (effectiveAllowed !== null && !effectiveAllowed.has(domain)) {
      throw new Error(
        `Fetch to domain "${domain}" is not allowed. Allowed domains: ${Array.from(effectiveAllowed).join(", ")}`,
      );
    }

    // Check if domain is disallowed
    if (disallowedSet.has(domain)) {
      throw new Error(`Fetch to domain "${domain}" is explicitly disallowed.`);
    }
  }

  /**
   * Extract domain from URL string
   */
  protected _extractDomain(url: string): string | null {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return null; // Invalid URL
    }
  }
}
