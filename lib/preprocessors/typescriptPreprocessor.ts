import { AgencyConfig, BUILTIN_FUNCTIONS } from "@/config.js";
import type { ProgramInfo } from "@/programInfo.js";
import {
  AgencyNode,
  AgencyProgram,
  Assignment,
  FunctionCall,
  FunctionDefinition,
  getImportedNames,
  IfElse,
  RawCode,
  ScopeType,
  WhileLoop,
} from "@/types.js";
import { MessageThread } from "@/types/messageThread.js";
// import { Skill } from "@/types/skill.js"; // Unused after llm() refactor
import {
  expressionToString,
  getAllVariablesInBodyArray,
  walkNodesArray,
} from "@/utils/node.js";

/** Check if a node is an llm() function call */
function isLlmCall(node: AgencyNode): node is FunctionCall {
  return node.type === "functionCall" && node.functionName === "llm";
}

/** Extract the llm() FunctionCall from a node, if present (handles assignments, returns, etc.) */
function getLlmCall(node: AgencyNode): FunctionCall | null {
  if (isLlmCall(node)) return node;
  if (node.type === "assignment" && isLlmCall(node.value)) return node.value;
  if (node.type === "returnStatement" && isLlmCall(node.value)) return node.value;
  return null;
}

/** Get a short string representation of an llm() call for comments */
function llmCallToString(call: FunctionCall): string {
  const firstArg = call.arguments[0];
  if (!firstArg) return "llm()";
  if (firstArg.type === "string" || firstArg.type === "multiLineString") {
    const str = firstArg.segments
      .map((seg) =>
        seg.type === "text"
          ? seg.value
          : `{${expressionToString(seg.expression)}}`,
      )
      .join("");
    return str;
  }
  if (firstArg.type === "variableName") return `\${${firstArg.value}}`;
  return "llm(...)";
}

export class TypescriptPreprocessor {
  public program: AgencyProgram;
  protected config: AgencyConfig;
  protected functionNameToAsync: Record<string, boolean> = {};
  protected functionNameToUsesInterrupt: Record<string, boolean> = {};
  protected functionDefinitions: Record<string, FunctionDefinition> = {};
  protected graphNodeDefinitions: Record<string, AgencyNode> = {};
  protected importedTools: string[] = [];
  constructor(
    program: AgencyProgram,
    config: AgencyConfig = {},
    info?: ProgramInfo,
  ) {
    this.program = program;
    this.config = config;
    if (info) {
      this.functionDefinitions = { ...info.functionDefinitions };
      this.graphNodeDefinitions = Object.fromEntries(
        info.graphNodes.map((n) => [n.nodeName, n]),
      );
      this.importedTools = info.importedTools.flatMap((s) => s.importedTools);
    }
  }

  preprocess(): AgencyProgram {
    if (Object.keys(this.functionDefinitions).length === 0) {
      this.getFunctionDefinitions();
    }
    if (Object.keys(this.graphNodeDefinitions).length === 0) {
      this.getGraphNodeDefinitions();
    }
    if (this.importedTools.length === 0) {
      this.getImportedTools();
    }
    this.collectTools();
    this.collectSkills();
    /*
    Skipping these for now. The issue is that these functions could be modifying global state.
    Here's an example:

    ```agency
    globalVar = 0
      
    def increment() {
      globalVar = globalVar + 1
    }
      
    def getGlobal() {
      return globalVar
    }
      
    node main() {
      increment()
      increment()
      val = getGlobal()
      print(val)
    }
    ```
      
    In the current code to mark functions async,
    all three of these function calls run concurrently...
    so `val` could be 0, 1, or 2, depending on how many of the increment() calls run!
    */
    // this.markFunctionsAsync();
    // this.markFunctionCallsAsync();
    this.removeUnusedLlmCalls();
    this.addAwaitPendingCalls();
    this.filterExcludedNodeTypes();
    this.filterExcludedBuiltinFunctions();
    this.validateFetchDomains();
    this.validateNoAsyncInLoops();
    this.resolveVariableScopes();
    return this.program;
  }

  protected removeUnusedLlmCalls(): void {
    for (const node of this.program.nodes) {
      if (node.type === "function" || node.type === "graphNode") {
        node.body = this._removeUnusedLlmCalls(node.body);
      }
    }
  }

  // TODO: Update _removeUnusedLlmCalls to work with llm() as FunctionCall.
  // Currently disabled because we can't introspect the config object to check
  // for sync tools. Need to update this to check for tools in the llm() config arg.
  protected _removeUnusedLlmCalls(body: AgencyNode[]): AgencyNode[] {
    return body;
    /* Original implementation (used PromptLiteral nodes, needs rewrite for FunctionCall):
    const newBody: AgencyNode[] = [];
    for (const node of body) {
      if (node.type === "prompt") {
        const hasSyncTools = node.tools
          ? node.tools.toolNames.some(
              (t) => this.functionNameToAsync[t] === false,
            )
          : false;
        if (!hasSyncTools) {
          newBody.push({
            type: "comment",
            content: `Removed unused LLM call: "${this.promptLiteralToString(node)}"`,
          });
          continue;
        }
      }

      if (node.type === "assignment" && node.value.type === "prompt") {
        const hasSyncTools = node.value.tools
          ? node.value.tools.toolNames.some(
              (t) => this.functionNameToAsync[t] === false,
            )
          : false;
        if (hasSyncTools) {
          newBody.push(node);
        } else {
          const isUsed = this.isVarUsedInBody(node.variableName, node, body);
          if (isUsed) {
            newBody.push(node);
          } else {
            newBody.push({
              type: "comment",
              content: `Removed unused LLM call, was assigned to variable '${node.variableName}' but variable was never used.`,
            });
            continue;
          }
        }
      } else if (
        node.type === "returnStatement" &&
        node.value.type === "prompt"
      ) {
        newBody.push(node);
      } else {
        newBody.push(node);
      }
    }
    return newBody;
    */
  }

  protected isVarUsedInBody(
    variableName: string,
    nodeToExclude: AgencyNode,
    body: AgencyNode[],
  ): boolean {
    for (const { name, node } of getAllVariablesInBodyArray(body)) {
      if (node === nodeToExclude) {
        continue; // skip the variable declaration/assignment itself
      }
      if (name === variableName) {
        return true;
      }
    }
    return false;
  }

  protected getFunctionDefinitions() {
    for (const node of this.program.nodes) {
      if (node.type === "function") {
        this.functionDefinitions[node.functionName] = node;
      }
    }
  }

  protected getGraphNodeDefinitions() {
    for (const node of this.program.nodes) {
      if (node.type === "graphNode") {
        this.graphNodeDefinitions[node.nodeName] = node;
      }
    }
  }

  protected getImportedTools() {
    for (const node of this.program.nodes) {
      if (node.type === "importToolStatement") {
        this.importedTools.push(...node.importedTools);
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
    for (const { node } of walkNodesArray(body)) {
      if (node.type === "usesTool") {
        toolsUsed.push(...node.toolNames);
      } else if (node.type === "functionCall" && node.functionName === "llm" && !node.tools) {
        node.tools = { type: "usesTool", toolNames: toolsUsed };
        toolsUsed = [];
      } else if (
        node.type === "assignment" &&
        node.value.type === "functionCall" &&
        node.value.functionName === "llm" &&
        !node.value.tools
      ) {
        node.value.tools = { type: "usesTool", toolNames: [...toolsUsed] };
        toolsUsed = [];
      }
    }
  }

  protected collectSkills(): void {
    for (const node of this.program.nodes) {
      if (node.type === "function" || node.type === "graphNode") {
        this.collectSkillsInFunction(node.body);
        node.body = node.body.filter((n) => n.type !== "skill");
      }
    }
  }

  // TODO: Update collectSkillsInFunction to work with llm() as FunctionCall.
  // Skills are now passed in the config object (2nd arg to llm()), but skill
  // statements still need to be collected and merged with config skills.
  protected collectSkillsInFunction(body: AgencyNode[]): void {
    /* Original implementation (used PromptLiteral nodes, needs rewrite for FunctionCall):
    let skillsUsed: Skill[] = [];

    const setSkillsForPrompt = (promptNode: PromptLiteral) => {
      promptNode.skills = skillsUsed;

      if (skillsUsed.length > 0) {
        const hasReadSkillTool = promptNode.tools?.toolNames.some(
          (t) => t === "readSkill",
        );
        if (!hasReadSkillTool) {
          promptNode.tools = promptNode.tools || {
            type: "usesTool",
            toolNames: [],
          };
          promptNode.tools.toolNames.push("readSkill");
        }
      }

      skillsUsed = [];
    };

    for (const { node } of walkNodesArray(body)) {
      if (node.type === "skill") {
        skillsUsed.push(node);
      } else if (node.type === "prompt") {
        setSkillsForPrompt(node);
      } else if (node.type === "assignment" && node.value.type === "prompt") {
        setSkillsForPrompt(node.value);
      }
    }
    */
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

  protected findChildren(body: AgencyNode[], type: string): AgencyNode[] {
    const children: AgencyNode[] = [];
    for (const { node } of walkNodesArray(body)) {
      if (node.type === type) {
        children.push(node);
      }
    }
    return children;
  }

  protected isBuiltinFunction(functionName: string): boolean {
    return BUILTIN_FUNCTIONS[functionName] !== undefined;
  }

  protected markFunctionCallsAsync(): void {
    if (this.program === null) {
      throw new Error("Program is not set in generator.");
    }
    for (const { node, ancestors } of walkNodesArray(this.program.nodes)) {
      const closestMessageThread = [...ancestors]
        .reverse()
        .find((a) => a.type === "messageThread") as MessageThread | undefined;
      const isInMessageThread = !!closestMessageThread;
      const isInParallelThread =
        closestMessageThread?.threadType === "parallel";
      const isInReturnStatement = ancestors.some(
        (a) => a.type === "returnStatement",
      );

      if (node.type === "functionCall") {
        if (node.functionName === "llm") {
          // llm() calls: sync by default when they have a config arg (2nd argument),
          // unless explicitly marked async by the user.
          // llm() calls without config follow the same rules as before.
          if (node.async !== undefined) {
            continue; // already marked as async or sync by user
          }

          const hasConfig = node.arguments.length > 1;
          if (hasConfig) {
            // LLM calls with config are always sync unless explicitly async
            node.async = false;
            continue;
          }

          // prompts in message threads are sync to preserve message order
          // (unless in a parallel block where they run concurrently)
          if (isInMessageThread && !isInParallelThread) {
            node.async = false;
            continue;
          }

          // if in return, this is the last line of execution,
          // so we need to wait for it to finish
          if (isInReturnStatement) {
            node.async = false;
            continue;
          }

          // Default: async (no tools to worry about in the no-config case)
          node.async = true;
        } else {
          // Non-llm function calls: run sync unless specifically marked async
          node.async = node.async ?? false;
        }
        continue;
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

    // Default to true (has interrupt) before recursing. This breaks infinite
    // loops from mutual recursion: if A calls B and B calls A, when we recurse
    // into B and it tries to check A again, it will hit this cached value and
    // return true instead of recursing forever. We err on the side of caution
    // (true = has interrupt = not async) since marking a function as sync when
    // it should be async is safer than the reverse.
    this.functionNameToUsesInterrupt[node.functionName] = true;

    for (const { node: subnode, ancestors } of walkNodesArray(node.body)) {
      if (subnode.type === "functionCall") {
        if (subnode.functionName === "interrupt") {
          return true;
        }
        // Skip method calls on objects (e.g. planner.updateActions()) —
        // these are nested inside a valueAccess node and should not be
        // resolved against top-level function definitions.
        const isPartOfValueAccess = ancestors.some(
          (a) => a.type === "valueAccess",
        );
        if (isPartOfValueAccess) {
          continue;
        }
        const func = this.functionDefinitions[subnode.functionName];
        if (func && this.containsInterrupt(func)) {
          return true;
        }
      } else if (subnode.type === "usesTool") {
        for (const toolName of subnode.toolNames) {
          const func = this.functionDefinitions[toolName];
          if (func && this.containsInterrupt(func)) {
            return true;
          }
        }
      }
    }

    this.functionNameToUsesInterrupt[node.functionName] = false;
    return false;
  }

  private prettifyName(call: FunctionCall): string {
    if (call.functionName === "llm") {
      return `"llm(${llmCallToString(call).substring(0, 20)})"`;
    }
    return call.functionName;
  }

  public renderMermaid(): string[] {
    // "graph TD"
    const lines: string[] = [];
    const labelLines: string[] = [];
    let nodeCounter = 0;
    const nextId = () => `n${nodeCounter++}`;

    const addToolsLabel = (
      call: FunctionCall,
      callId: string,
    ) => {
      // TODO: Update to extract tools from llm() config object
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
  ): FunctionCall[] {
    const calls: FunctionCall[] = [];
    for (const { node } of walkNodesArray(body)) {
      if (node.type === "functionCall") {
        calls.push(node);
      }
    }
    return calls;
  }

  protected groupCallsByAsync(
    calls: FunctionCall[],
  ): { type: "sync" | "async"; calls: FunctionCall[] }[] {
    const groups: {
      type: "sync" | "async";
      calls: FunctionCall[];
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

  protected addAwaitPendingCalls(): void {
    for (const node of this.program.nodes) {
      if (node.type === "function" || node.type === "graphNode") {
        node.body = this._addAwaitPendingCalls(node.body);
      }
    }
  }

  protected _addAwaitPendingCalls(body: AgencyNode[]): AgencyNode[] {
    /*     // First, recursively process nested function/node bodies
    // (functions and nodes create their own scope, so process them separately)
    for (const node of body) {
      if (node.type === "function" || node.type === "graphNode") {
        node.body = this._addAwaitPendingCalls(node.body);
      } else if (node.type === "ifElse") {
        node.thenBody = this._addAwaitPendingCalls(node.thenBody);
        if (node.elseBody) {
          node.elseBody = this._addAwaitPendingCalls(node.elseBody);
        }
      }
    }
 */
    // Pass 1: Collect all async variables defined in this body and nested non-function bodies
    // Variables in MessageThread, WhileLoop, IfElse are scoped to the containing function/node
    const asyncVarToAssignment: Record<string, AgencyNode> = {};
    this._collectAsyncVariablesInScope(body, asyncVarToAssignment);

    const asyncVars = Object.keys(asyncVarToAssignment);
    if (asyncVars.length === 0) {
      return body;
    }

    // Pass 2: Find the first usage of each async variable across all bodies in this scope
    const varToFirstUsageLocation: Record<
      string,
      { bodyPath: number[]; indexInBody: number }
    > = {};

    for (const varName of asyncVars) {
      const location = this._findFirstUsageInScope(
        body,
        varName,
        asyncVarToAssignment[varName],
      );
      if (location) {
        varToFirstUsageLocation[varName] = location;
      }
    }

    // Group variables by their first usage location
    const locationToVars: Record<string, string[]> = {};

    for (const varName of Object.keys(varToFirstUsageLocation)) {
      const location = varToFirstUsageLocation[varName];
      const locationKey =
        location.bodyPath.join(",") + ":" + location.indexInBody;
      if (!locationToVars[locationKey]) {
        locationToVars[locationKey] = [];
      }
      locationToVars[locationKey].push(varName);
    }

    // Insert awaitPending calls before first usage
    return this._insertAwaitPendingCalls(body, locationToVars);
  }

  /**
   * Recursively collect all async variables defined in this body and nested non-function bodies.
   * Does not descend into function or graphNode bodies as they have their own scope.
   */
  protected _collectAsyncVariablesInScope(
    body: AgencyNode[],
    asyncVarToAssignment: Record<string, AgencyNode>,
  ): void {
    for (const node of body) {
      // Don't descend into functions or graph nodes - they have their own scope
      if (node.type === "function" || node.type === "graphNode") {
        continue;
      }

      // Process assignments in this body
      if (node.type === "assignment") {
        const isAsyncCall =
          node.value.type === "functionCall" && node.value.async;

        if (isAsyncCall) {
          asyncVarToAssignment[node.variableName] = node;
        }
      }

      // Recursively collect from nested bodies that share the same scope
      if (node.type === "messageThread") {
        this._collectAsyncVariablesInScope(node.body, asyncVarToAssignment);
      } else if (node.type === "whileLoop") {
        this._collectAsyncVariablesInScope(node.body, asyncVarToAssignment);
      } else if (node.type === "ifElse") {
        this._collectAsyncVariablesInScope(node.thenBody, asyncVarToAssignment);
        if (node.elseBody) {
          this._collectAsyncVariablesInScope(
            node.elseBody,
            asyncVarToAssignment,
          );
        }
      }
    }
  }

  /**
   * Find the first usage of a variable in this scope (across all bodies).
   * Returns the path to the body and the index within that body.
   */
  protected _findFirstUsageInScope(
    body: AgencyNode[],
    varName: string,
    assignmentNode: AgencyNode,
    bodyPath: number[] = [],
  ): { bodyPath: number[]; indexInBody: number } | null {
    for (let i = 0; i < body.length; i++) {
      const node = body[i];

      // Don't descend into functions or graph nodes - they have their own scope
      if (node.type === "function" || node.type === "graphNode") {
        continue;
      }

      // Skip the assignment itself
      if (node === assignmentNode) {
        continue;
      }

      // Check if this node uses the variable (excluding nested bodies)
      if (this._nodeUsesVariableDirectly(node, varName)) {
        return { bodyPath, indexInBody: i };
      }

      // Check nested bodies
      if (node.type === "messageThread") {
        const found = this._findFirstUsageInScope(
          node.body,
          varName,
          assignmentNode,
          [...bodyPath, i],
        );
        if (found) return found;
      } else if (node.type === "whileLoop") {
        const found = this._findFirstUsageInScope(
          node.body,
          varName,
          assignmentNode,
          [...bodyPath, i],
        );
        if (found) return found;
      } else if (node.type === "ifElse") {
        const foundInThen = this._findFirstUsageInScope(
          node.thenBody,
          varName,
          assignmentNode,
          [...bodyPath, i, 0],
        );
        if (foundInThen) return foundInThen;
        if (node.elseBody) {
          const foundInElse = this._findFirstUsageInScope(
            node.elseBody,
            varName,
            assignmentNode,
            [...bodyPath, i, 1],
          );
          if (foundInElse) return foundInElse;
        }
      }
    }

    return null;
  }

  /**
   * Check if a node uses a variable directly (not in nested bodies).
   */
  protected _nodeUsesVariableDirectly(
    node: AgencyNode,
    varName: string,
  ): boolean {
    // For nodes with bodies, we don't check inside the body here
    // (that's done separately in _findFirstUsageInScope)
    if (
      node.type === "messageThread" ||
      node.type === "whileLoop" ||
      node.type === "function" ||
      node.type === "graphNode"
    ) {
      return false;
    }

    // For ifElse, check the condition but not the bodies
    if (node.type === "ifElse") {
      return this._nodeUsesVariable(node.condition, varName);
    }

    // For all other nodes, use the full check
    return this._nodeUsesVariable(node, varName);
  }

  /**
   * Insert awaitPending calls at the appropriate locations in the body.
   */
  protected _insertAwaitPendingCalls(
    body: AgencyNode[],
    locationToVars: Record<string, string[]>,
    currentPath: number[] = [],
  ): AgencyNode[] {
    const newBody: AgencyNode[] = [];

    for (let i = 0; i < body.length; i++) {
      const node = body[i];
      const locationKey = currentPath.join(",") + ":" + i;

      // Check if we need to insert awaitPending before this node
      if (locationToVars[locationKey]) {
        const vars = locationToVars[locationKey];
        const keyArray = vars.map((v) => `__self.__pendingKey_${v}`).join(", ");
        const awaitPendingCode: RawCode = {
          type: "rawCode",
          value: `await __ctx.pendingPromises.awaitPending([${keyArray}]);`,
        };
        newBody.push(awaitPendingCode);
      }

      // Recursively process nested bodies
      if (node.type === "messageThread") {
        node.body = this._insertAwaitPendingCalls(node.body, locationToVars, [
          ...currentPath,
          i,
        ]);

        // For parallel blocks, append an awaitPending for all async vars defined within
        if (node.threadType === "parallel") {
          const parallelAsyncVars = node.body
            .filter(
              (n): n is Assignment =>
                n.type === "assignment" &&
                n.value.type === "functionCall" && !!n.value.async,
            )
            .map((n) => n.variableName);

          if (parallelAsyncVars.length > 0) {
            const keyArray = parallelAsyncVars
              .map((v) => `__self.__pendingKey_${v}`)
              .join(", ");
            node.body.push({
              type: "rawCode",
              value: `await __ctx.pendingPromises.awaitPending([${keyArray}]);`,
            });
          }
        }
      } else if (node.type === "whileLoop") {
        node.body = this._insertAwaitPendingCalls(node.body, locationToVars, [
          ...currentPath,
          i,
        ]);
      } else if (node.type === "ifElse") {
        node.thenBody = this._insertAwaitPendingCalls(
          node.thenBody,
          locationToVars,
          [...currentPath, i, 0],
        );
        if (node.elseBody) {
          node.elseBody = this._insertAwaitPendingCalls(
            node.elseBody,
            locationToVars,
            [...currentPath, i, 1],
          );
        }
      }

      newBody.push(node);
    }

    return newBody;
  }

  protected nodeHasBody(
    node: AgencyNode,
  ): node is
    | FunctionDefinition
    | AgencyNode
    | IfElse
    | WhileLoop
    | MessageThread {
    return (
      node.type === "function" ||
      node.type === "graphNode" ||
      node.type === "ifElse" ||
      node.type === "whileLoop" ||
      node.type === "messageThread"
    );
  }

  protected _nodeUsesVariable(node: AgencyNode, varName: string): boolean {
    // Check if the node or any of its children use the variable
    for (const { name } of getAllVariablesInBodyArray([node])) {
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
      } else if (node.type === "messageThread") {
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
      } else if (node.type === "messageThread") {
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
    for (const { node } of walkNodesArray(this.program.nodes)) {
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

  /**
   * Validate that no async function calls appear inside loops.
   * Async calls inside loops can't be properly serialized for interrupt
   * resumption because multiple iterations share the same step block,
   * causing branch key collisions.
   */
  protected validateNoAsyncInLoops(): void {
    const loopTypes = ["forLoop", "whileLoop"];
    for (const { node, ancestors } of walkNodesArray(this.program.nodes)) {
      if (node.type === "functionCall" && node.async) {
        const insideLoop = ancestors.some((a) => loopTypes.includes(a.type));
        if (insideLoop) {
          throw new Error(
            `Async function call "${node.functionName}()" is not allowed inside a loop. ` +
              `Move the async call into a separate function, or remove the "async" keyword.`,
          );
        }
      }
    }
  }

  /**
   * Resolve variable scopes by annotating AST nodes with their scope.
   * After this pass, every VariableNameLiteral, InterpolationSegment, and Assignment
   * will have a `scope` property indicating whether the variable is global, local, or args.
   */
  protected resolveVariableScopes(): void {
    const globalVars = new Set<string>();
    const sharedVars = new Set<string>();
    const importedVars = new Set<string>();
    const funcArgs: Record<string, string[]> = {};
    const localVarsInFunction: Record<string, Set<string>> = {};

    // First, we collect all global and shared variables
    for (const { node, scopes } of walkNodesArray(this.program.nodes)) {
      if (scopes.length === 0) {
        throw new Error(
          `Top-level nodes should have at least the global scope in their scopes array. Node: ${JSON.stringify({ node })}, scopes: ${JSON.stringify({ scopes })}`,
        );
      }
      if (scopes.at(-1)?.type !== "global") continue;
      if (node.type === "assignment") {
        if (node.shared) {
          sharedVars.add(node.variableName);
        } else {
          globalVars.add(node.variableName);
        }
        /*       } else if (node.type === "variableName") {
        globalVars.add(node.value);
 */
      } else if (node.type === "importStatement") {
        const importedNames = node.importedNames.map(getImportedNames).flat();
        importedNames.forEach((n) => {
          importedVars.add(n);
        });
      } else if (node.type === "importNodeStatement") {
        node.importedNodes.forEach((n) => {
          importedVars.add(n);
        });
      } else if (node.type === "importToolStatement") {
        node.importedTools.forEach((t) => {
          importedVars.add(t);
        });
      }
    }

    const lookupScope = (
      funcName: string,
      varName: string,
    ): ScopeType | null => {
      // imported takes precedence over global
      if (importedVars.has(varName)) {
        return "imported";
      }
      if (sharedVars.has(varName)) {
        return "shared";
      }
      if (globalVars.has(varName)) {
        return "global";
      }
      if (funcArgs[funcName] && funcArgs[funcName].includes(varName)) {
        return "args";
      }
      if (
        localVarsInFunction[funcName] &&
        localVarsInFunction[funcName].has(varName)
      ) {
        return "local";
      }
      return null;
    };

    // second, make sure all args are scoped correctly,
    // and all vars defined within a function or graph node are scoped to that function or graph node.
    for (const { node, scopes } of walkNodesArray(this.program.nodes)) {
      if (scopes.length === 0) {
        throw new Error(
          `Top-level nodes should have at least the global scope in their scopes array. Node: ${JSON.stringify({ node })}, scopes: ${JSON.stringify({ scopes })}`,
        );
      }
      if (node.type === "function" || node.type === "graphNode") {
        const nodeName =
          node.type === "function" ? node.functionName : node.nodeName;
        // Parameters are in the function's scope
        funcArgs[nodeName] = [...node.parameters.map((p) => p.name)];
        localVarsInFunction[nodeName] = new Set();

        // Then, whenever we see a variable being referenced,
        // we try to look up its scope and set it on that variable.
        // Note: segment expressions are now walked by walkNodes/getAllVariablesInBody,
        // so the base VariableNameLiteral inside interpolation segments gets its scope
        // set via the node.type === "variableName" branch below.
        const varsDefinedInFunction = getAllVariablesInBodyArray(node.body);
        for (const { node: varNode } of varsDefinedInFunction) {
          if (varNode.type === "assignment") {
            let scope = lookupScope(nodeName, varNode.variableName);
            if (scope === null) {
              scope = "local"; // Local var, first time being assigned
              localVarsInFunction[nodeName].add(varNode.variableName);
            }
            varNode.scope = scope;
          } else if (varNode.type === "variableName") {
            // a var is being referenced, we don't know
            // what it is, so assume it is either imported or a JS global, like `Promise`.
            varNode.scope = lookupScope(nodeName, varNode.value) || "imported";
          }
        }
      }
    }

    // imported scope for everything else
    for (const { node } of getAllVariablesInBodyArray(this.program.nodes)) {
      if (node.type === "variableName" || node.type === "assignment") {
        if (!node.scope) {
          const name =
            node.type === "variableName" ? node.value : node.variableName;
          const scope = lookupScope("", name);
          node.scope = scope || "imported";
        }
      }
    }
  }
}
