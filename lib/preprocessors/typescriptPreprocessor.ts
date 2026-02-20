import {
  AgencyConfig,
  BUILTIN_FUNCTIONS,
  BUILTIN_FUNCTIONS_TO_ASYNC,
} from "@/config.js";
import {
  AgencyNode,
  AgencyProgram,
  Assignment,
  FunctionCall,
  FunctionDefinition,
  getImportedNames,
  globalScope,
  GraphNodeDefinition,
  IfElse,
  InterpolationSegment,
  PromptLiteral,
  RawCode,
  Scope,
  ScopeType,
  TimeBlock,
  VariableNameLiteral,
  WhileLoop,
} from "@/types.js";
import { MessageThread } from "@/types/messageThread.js";
import { Skill } from "@/types/skill.js";
import { uniq } from "@/utils.js";
import {
  getAllVariablesInBodyArray,
  setWalkNodeDebug,
  walkNodeDebug,
  walkNodesArray,
} from "@/utils/node.js";
import { color } from "termcolors";

const ROOT_THREAD_ID = "0";

export class TypescriptPreprocessor {
  public program: AgencyProgram;
  protected config: AgencyConfig;
  protected functionNameToAsync: Record<string, boolean> = {};
  protected functionNameToUsesInterrupt: Record<string, boolean> = {};
  protected functionDefinitions: Record<string, FunctionDefinition> = {};
  protected threadIdCounter: number = 0;
  protected importedTools: string[] = [];
  constructor(program: AgencyProgram, config: AgencyConfig = {}) {
    this.program = structuredClone(program);
    this.config = config;
  }

  preprocess(): AgencyProgram {
    this.getFunctionDefinitions();
    this.getImportedTools();
    this.collectTools();
    this.collectSkills();
    this.markFunctionsAsync();
    this.markFunctionCallsAsync();
    this.removeUnusedLlmCalls();
    this.addPromiseAllCalls();
    this.filterExcludedNodeTypes();
    this.filterExcludedBuiltinFunctions();
    this.validateFetchDomains();
    this.addNodeIDsToMessageThreads();
    this.addNodeIDsToPrompts();
    this.resolveVariableScopes();
    return this.program;
  }

  protected addNodeIDsToMessageThreads(): void {
    //setWalkNodeDebug(true);
    for (const node of this.program.nodes) {
      if (node.type === "function" || node.type === "graphNode") {
        /* console.log(
          color.cyan(
            "ADDING NODE IDS TO",
            node.type,
            node.type == "graphNode" ? node.nodeName : node.functionName,
          ),
        ); */
        node.threadIds = [];
        this._addNodeIDsToMessageThreads(node.body, node);
      }
    }
    // setWalkNodeDebug(false);
  }

  protected addNodeIDsToPrompts(): void {
    //setWalkNodeDebug(true);
    for (const node of this.program.nodes) {
      if (node.type === "function" || node.type === "graphNode") {
        /* console.log(
          color.cyan(
            "ADDING NODE IDS TO",
            node.type,
            node.type == "graphNode" ? node.nodeName : node.functionName,
          ),
        ); */
        this._addNodeIDsToPrompts(node.body, node);
        node.threadIds = uniq(node.threadIds || []);
      }
    }
    // setWalkNodeDebug(false);
  }

  // parallel llm calls also need their own message threads.
  protected _addNodeIDsToMessageThreads(
    body: AgencyNode[],
    functionOrGraphNode: FunctionDefinition | GraphNodeDefinition,
    parentId = "0",
    _ancestors: AgencyNode[] = [],
    _scopes: Scope[] = [],
  ): void {
    for (const { node, ancestors, scopes } of walkNodesArray(
      body,
      _ancestors,
      _scopes,
    )) {
      let messageThreadNode: MessageThread | null = null;

      if (node.type === "messageThread")
        messageThreadNode = node as MessageThread;

      if (node.type === "assignment" && node.value.type === "messageThread")
        messageThreadNode = node.value as MessageThread;
      if (messageThreadNode && !messageThreadNode.threadId) {
        /* console.log(
          color.green(
            "incrementing threadIdCounter for message thread, new value:",
            ),
            this.threadIdCounter,
            "thread content:",
            messageThreadNode.body,
            ); */
        messageThreadNode.threadId = this.threadIdCounter.toString();
        messageThreadNode.parentThreadId = parentId.toString();
        this.threadIdCounter++;
        functionOrGraphNode.threadIds?.push(messageThreadNode.threadId);
        this._addNodeIDsToMessageThreads(
          messageThreadNode.body,
          functionOrGraphNode,
          messageThreadNode.threadId,
          [...ancestors, node],
          scopes,
        );
        this._addNodeIDsToPromptsInThread(
          messageThreadNode.body,
          messageThreadNode.threadId,
        );
      }
    }
  }

  protected _addNodeIDsToPromptsInThread(
    body: AgencyNode[],
    parentId: string = ROOT_THREAD_ID,
  ): void {
    for (const { node, ancestors, scopes } of walkNodesArray(body)) {
      /* If llm calls or function calls are in a message thread,
      then they should be using their parent's thread ID so that they're all part of the same thread. */

      function setThreadId<T extends AgencyNode & { threadId?: string }>(
        node: AgencyNode,
        nodeType: string,
      ): void {
        let promptOrFuncNode: T | null = null;
        if (node.type === nodeType) promptOrFuncNode = node as T;
        if (node.type === "assignment" && node.value.type === nodeType)
          promptOrFuncNode = node.value as T;

        if (node.type === "returnStatement" && node.value.type === nodeType)
          promptOrFuncNode = node.value as T;

        if (promptOrFuncNode && !promptOrFuncNode.threadId) {
          /* console.log(
          color.magenta(
            "setting threadId for prompt, threadId:",
            parentId,
            "prompt content:",
            JSON.stringify(promptOrFuncNode),
          ),
        ); */
          promptOrFuncNode.threadId = parentId.toString();
        }
      }

      setThreadId<PromptLiteral>(node, "prompt");
      setThreadId<FunctionCall>(node, "functionCall");

      // TODO still unsure what to do about specialVars
      if (node.type === "specialVar") {
        node.threadId = parentId.toString();
      }
    }
  }

  // prompts not in a message thread
  protected _addNodeIDsToPrompts(
    body: AgencyNode[],
    functionOrGraphNode: FunctionDefinition | GraphNodeDefinition,
  ): void {
    for (const { node, ancestors, scopes } of walkNodesArray(body)) {
      /* Here's what's happening here. For any LLM calls that are not inside a message thread,
      those calls will be run in parallel. That means they will all start their own message thread,
      which means they need their own thread ID because all of these threads are actually set on a global
      messages object and the thread IDs are used to track the different message threads.
 */

      let promptNode: PromptLiteral | null = null;
      if (node.type === "prompt") promptNode = node as PromptLiteral;
      if (node.type === "assignment" && node.value.type === "prompt")
        promptNode = node.value as PromptLiteral;

      if (node.type === "returnStatement" && node.value.type === "prompt")
        promptNode = node.value as PromptLiteral;
      if (promptNode && !promptNode.threadId) {
        /* console.log(
          color.magenta("incrementing threadIdCounter for prompt, new value:"),
          this.threadIdCounter,
          "prompt content:",
          promptNode.segments,
        ); */
        promptNode.threadId = this.threadIdCounter.toString();
        functionOrGraphNode.threadIds?.push(promptNode.threadId);
        this.threadIdCounter++;
      }

      if (node.type === "functionCall") {
        if (!node.threadId) {
          node.threadId = this.threadIdCounter.toString();
          functionOrGraphNode.threadIds?.push(node.threadId);
          this.threadIdCounter++;
        }
      } else if (node.type === "specialVar") {
        // todo what to do about special vars here?
        // because technically they're not in a thread at all,
        // so there are no messages to access.
        if (!node.threadId) {
          node.threadId = "0";
          functionOrGraphNode.threadIds?.push(node.threadId);
        }
      }
    }
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
        const hasSyncTools = node.tools
          ? node.tools.toolNames.some(
              (t) => this.functionNameToAsync[t] === false,
            )
          : false;
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
    body.forEach((node) => {
      if (node.type === "usesTool") {
        toolsUsed.push(...node.toolNames);
      } else if (node.type === "prompt") {
        node.tools = { type: "usesTool", toolNames: toolsUsed };
        toolsUsed = [];
      } else if (node.type === "assignment" && node.value.type === "prompt") {
        node.value.tools = { type: "usesTool", toolNames: toolsUsed };
        toolsUsed = [];
      }
    });
  }

  protected collectSkills(): void {
    for (const node of this.program.nodes) {
      if (node.type === "function" || node.type === "graphNode") {
        this.collectSkillsInFunction(node.body);
        node.body = node.body.filter((n) => n.type !== "skill");
      }
    }
  }

  protected collectSkillsInFunction(body: AgencyNode[]): void {
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

    body.forEach((node) => {
      if (node.type === "skill") {
        skillsUsed.push(node);
      } else if (node.type === "prompt") {
        setSkillsForPrompt(node);
      } else if (node.type === "assignment" && node.value.type === "prompt") {
        setSkillsForPrompt(node.value);
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
      const isInMessageThread = ancestors.some(
        (a) => a.type === "messageThread",
      );
      const isInReturnStatement = ancestors.some(
        (a) => a.type === "returnStatement",
      );

      if (node.type === "functionCall") {
        // if in return, this is the last line of execution,
        // so we need to wait for it to finish
        if (isInReturnStatement) {
          node.async = false;
          continue;
        }

        if (this.isBuiltinFunction(node.functionName)) {
          node.async = BUILTIN_FUNCTIONS_TO_ASYNC[node.functionName] ?? false;
          continue;
        }

        const func = this.functionDefinitions[node.functionName];
        if (!func) {
          // see if it is explicitly marked async,
          // otherwise mark it sync since we don't know what it is.
          node.async = this.functionNameToAsync[node.functionName] || false;
          continue;
          // throw new Error(
          //   `Function ${node.functionName} not found for function call: ${JSON.stringify(node)}`,
          // );
        }

        const children = this.findChildren(func.body, "prompt");
        const containsPrompt = children.length > 0;

        // all prompts need to run synchronously within a message thread
        // to ensure correct ordering of messages, so if this function
        // calls any prompts and is being called within a message thread,
        // it also needs to be synchronous.
        if (isInMessageThread && containsPrompt) {
          node.async = false;
          continue;
        }

        const isAsync = this.functionNameToAsync[node.functionName];
        if (isAsync) {
          node.async = true;
        }
      } else if (node.type === "prompt") {
        // prompts in message threads are sync to preserve message order
        if (isInMessageThread) {
          node.async = false;
          continue;
        }

        // if in return, this is the last line of execution,
        // so we need to wait for it to finish
        if (isInReturnStatement) {
          node.async = false;
          continue;
        }

        if (node.async !== undefined) {
          continue; // already marked as async or sync
        }

        // check if any of its tools will throw an interrupt
        const toolThrowsInterrupt = node.tools
          ? node.tools?.toolNames.some((toolName) => {
              /*
            If we don't know whether this function uses an interrupt,
            that's probably because it was imported and we don't have this information.
            We need to assume it throws an interrupt. */
              const usesInterrupt =
                this.functionNameToUsesInterrupt[toolName] ?? true;
              return usesInterrupt;
            })
          : false;
        node.async = !toolThrowsInterrupt;
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

    for (const { node: subnode } of walkNodesArray(node.body)) {
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
    for (const { node } of walkNodesArray(body)) {
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
    /*     // First, recursively process nested function/node bodies
    // (functions and nodes create their own scope, so process them separately)
    for (const node of body) {
      if (node.type === "function" || node.type === "graphNode") {
        node.body = this._addPromiseAllCalls(node.body);
      } else if (node.type === "ifElse") {
        node.thenBody = this._addPromiseAllCalls(node.thenBody);
        if (node.elseBody) {
          node.elseBody = this._addPromiseAllCalls(node.elseBody);
        }
      }
    }
 */
    // Pass 1: Collect all async variables defined in this body and nested non-function bodies
    // Variables in MessageThread, TimeBlock, WhileLoop, IfElse are scoped to the containing function/node
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

    // Insert Promise.all calls before first usage
    return this._insertPromiseAllCalls(body, locationToVars);
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
          (node.value.type === "functionCall" && node.value.async) ||
          (node.value.type === "prompt" && node.value.async);

        if (isAsyncCall) {
          asyncVarToAssignment[node.variableName] = node;
        }
      }

      // Recursively collect from nested bodies that share the same scope
      if (node.type === "messageThread") {
        this._collectAsyncVariablesInScope(node.body, asyncVarToAssignment);
      } else if (node.type === "timeBlock") {
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
      } else if (node.type === "timeBlock") {
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
      node.type === "timeBlock" ||
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
   * Insert Promise.all calls at the appropriate locations in the body.
   */
  protected _insertPromiseAllCalls(
    body: AgencyNode[],
    locationToVars: Record<string, string[]>,
    currentPath: number[] = [],
  ): AgencyNode[] {
    const newBody: AgencyNode[] = [];

    for (let i = 0; i < body.length; i++) {
      const node = body[i];
      const locationKey = currentPath.join(",") + ":" + i;

      // Check if we need to insert Promise.all before this node
      if (locationToVars[locationKey]) {
        const vars = locationToVars[locationKey];
        const varArray = `[${vars.map((v) => `__self.${v}`).join(", ")}]`;
        const promiseAllCode: RawCode = {
          type: "rawCode",
          value: `${varArray} = await Promise.all(${varArray});`,
        };
        newBody.push(promiseAllCode);
      }

      // Recursively process nested bodies
      if (node.type === "messageThread") {
        node.body = this._insertPromiseAllCalls(node.body, locationToVars, [
          ...currentPath,
          i,
        ]);
      } else if (node.type === "timeBlock") {
        node.body = this._insertPromiseAllCalls(node.body, locationToVars, [
          ...currentPath,
          i,
        ]);
      } else if (node.type === "whileLoop") {
        node.body = this._insertPromiseAllCalls(node.body, locationToVars, [
          ...currentPath,
          i,
        ]);
      } else if (node.type === "ifElse") {
        node.thenBody = this._insertPromiseAllCalls(
          node.thenBody,
          locationToVars,
          [...currentPath, i, 0],
        );
        if (node.elseBody) {
          node.elseBody = this._insertPromiseAllCalls(
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
    | TimeBlock
    | MessageThread {
    return (
      node.type === "function" ||
      node.type === "graphNode" ||
      node.type === "ifElse" ||
      node.type === "whileLoop" ||
      node.type === "timeBlock" ||
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
      } else if (node.type === "timeBlock") {
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
      } else if (node.type === "timeBlock") {
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
   * Resolve variable scopes by annotating AST nodes with their scope.
   * After this pass, every VariableNameLiteral, InterpolationSegment, and Assignment
   * will have a `scope` property indicating whether the variable is global, local, or args.
   */
  protected resolveVariableScopes(): void {
    const varNameToScope: Record<string, ScopeType> = {};

    // First, for each variable name, we try to collect its scope.
    for (const { node, scopes } of walkNodesArray(this.program.nodes)) {
      if (scopes.length === 0) {
        throw new Error(
          `Top-level nodes should have at least the global scope in their scopes array. Node: ${JSON.stringify({ node })}, scopes: ${JSON.stringify({ scopes })}`,
        );
      }
      if (node.type === "assignment") {
        varNameToScope[node.variableName] = scopes.at(-1)?.type || "global";
      } else if (node.type === "function" || node.type === "graphNode") {
        // Parameters are in the function's scope
        for (const param of node.parameters) {
          varNameToScope[param.name] = "args";
        }
      } else if (node.type === "importStatement") {
        const importedNames = node.importedNames.map(getImportedNames).flat();
        importedNames.forEach((n) => {
          varNameToScope[n] = "global";
        });
      } else if (node.type === "importNodeStatement") {
        node.importedNodes.forEach((n) => {
          varNameToScope[n] = "global";
        });
      } else if (node.type === "importToolStatement") {
        node.importedTools.forEach((t) => {
          varNameToScope[t] = "global";
        });
      }
    }

    const lookupScope = (varName: string): Scope["type"] | "args" => {
      if (varName in varNameToScope) {
        return varNameToScope[varName];
      }
      return "global";
      // TODO enable this
      /* throw new Error(
        `Variable "${varName}" is referenced but not defined in any scope.`,
      ); */
    };

    // Then, whenever we see a variable being referenced,
    // we try to look up its scope and set it on that variable.
    for (const { node, scopes } of walkNodesArray(this.program.nodes)) {
      if (node.type === "assignment") {
        node.scope = lookupScope(node.variableName);
      } else if (node.type === "variableName") {
        node.scope = lookupScope(node.value);
      } else if (
        node.type === "prompt" ||
        node.type === "string" ||
        node.type === "multiLineString"
      ) {
        node.segments.forEach((seg) => {
          if (seg.type === "interpolation") {
            seg.scope = lookupScope(seg.variableName);
          }
        });
      }
    }
  }
}
