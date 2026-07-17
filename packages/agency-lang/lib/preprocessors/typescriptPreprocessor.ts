import { AgencyConfig, BUILTIN_FUNCTIONS } from "@/config.js";
import type { CompilationUnit, ImportedFunctionSignature } from "@/compilationUnit.js";
import {
  AgencyMultiLineComment,
  AgencyNode,
  AgencyProgram,
  Assignment,
  FunctionCall,
  FunctionDefinition,
  GraphNodeDefinition,
  getImportedNames,
  IfElse,
  RawCode,
  Scope,
  ScopeType,
  Tag,
  TypeAlias,
  WhileLoop,
} from "@/types.js";
import { BlockArgument } from "@/types/blockArgument.js";
import { EffectDeclaration } from "@/types/effectDeclaration.js";
import { BlockType } from "@/types/typeHints.js";
import { FunctionParameter } from "@/types/function.js";
import { MessageThread } from "@/types/messageThread.js";
// import { Skill } from "@/types/skill.js"; // Unused after llm() refactor
import {
  expressionToString,
  getAllVariablesInBodyArray,
  isInsideBlock,
  walkNodesArray,
  type WalkAncestor,
} from "@/utils/node.js";
import { desugarParallelInBody } from "./parallelDesugar.js";
import { desugarGuardsInBody } from "./guardDesugar.js";
import { injectSchemaArgsInProgram } from "./injectSchemaArgs.js";
import { prunePreludeShadows } from "./prunePreludeShadows.js";

/**
 * Recursively apply a transform function to all body arrays in a node tree.
 * Handles ifElse (thenBody/elseBody), loops, threads, match blocks, handle blocks, etc.
 */
function walkBody(
  body: AgencyNode[],
  fn: (body: AgencyNode[]) => AgencyNode[],
): AgencyNode[] {
  const walked = body.map((node) => {
    if (node.type === "ifElse") {
      node.thenBody = walkBody(node.thenBody, fn);
      if (node.elseBody) {
        node.elseBody = walkBody(node.elseBody, fn);
      }
    } else if (
      node.type === "forLoop" ||
      node.type === "whileLoop" ||
      node.type === "messageThread"
    ) {
      node.body = walkBody(node.body, fn);
    } else if (node.type === "matchBlock") {
      for (const caseItem of node.cases) {
        if (caseItem.type === "comment") continue;
        if (caseItem.type === "newLine") continue;
        caseItem.body = walkBody(caseItem.body, fn);
      }
    } else if (node.type === "handleBlock") {
      node.body = walkBody(node.body, fn);
      if (node.handler.kind === "inline") {
        node.handler.body = walkBody(node.handler.body, fn);
      }
    } else if (node.type === "withModifier") {
      node.statement = walkBody([node.statement], fn)[0];
    } else if (node.type === "functionCall" && node.block) {
      node.block.body = walkBody(node.block.body, fn);
    } else if (node.type === "parallelBlock" || node.type === "seqBlock") {
      node.body = walkBody(node.body, fn);
    }
    return node;
  });
  return fn(walked);
}

/** Check if a node is an llm() function call */
function isLlmCall(node: AgencyNode): node is FunctionCall {
  return node.type === "functionCall" && node.functionName === "llm";
}

/** Extract the llm() FunctionCall from a node, if present (handles assignments, returns, etc.) */
function getLlmCall(node: AgencyNode): FunctionCall | null {
  if (isLlmCall(node)) return node;
  if (node.type === "assignment" && isLlmCall(node.value)) return node.value;
  if (node.type === "returnStatement" && node.value && isLlmCall(node.value)) return node.value;
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

function attachTags(nodes: AgencyNode[]): AgencyNode[] {
  const result: AgencyNode[] = [];
  let pendingTags: Tag[] = [];

  for (const node of nodes) {
    if (node.type === "tag") {
      pendingTags.push(node);
      continue;
    }

    if (pendingTags.length > 0) {
      if (node.type === "graphNode" || node.type === "function" ||
        node.type === "assignment" || node.type === "functionCall" ||
        node.type === "typeAlias") {
        node.tags = [...(node.tags || []), ...pendingTags];
        pendingTags = [];
      } else {
        // No valid attach target — preserve tags as standalone nodes
        result.push(...pendingTags);
        pendingTags = [];
      }
    }

    result.push(node);
  }

  // Preserve any trailing tags (e.g., at end of block)
  if (pendingTags.length > 0) {
    result.push(...pendingTags);
  }

  return result;
}

function collectTags(nodes: AgencyNode[]): AgencyNode[] {
  // walkBody handles control-flow bodies (ifElse, loops, etc.) but not
  // graphNode/function bodies, so recurse into those explicitly.
  const withNestedBodies = nodes.map((node) => {
    if ((node.type === "graphNode" || node.type === "function") && node.body) {
      node.body = collectTags(node.body);
    }
    return node;
  });
  return walkBody(withNestedBodies, attachTags);
}

export class TypescriptPreprocessor {
  public program: AgencyProgram;
  protected config: AgencyConfig;
  protected functionDefinitions: Record<string, FunctionDefinition> = {};
  protected importedFunctions: Record<string, ImportedFunctionSignature> = {};
  protected graphNodeDefinitions: Record<string, AgencyNode> = {};
  constructor(
    program: AgencyProgram,
    config: AgencyConfig = {},
    info?: CompilationUnit,
  ) {
    this.program = program;
    this.config = config;
    if (info) {
      this.functionDefinitions = { ...info.functionDefinitions };
      this.importedFunctions = { ...info.importedFunctions };
      this.graphNodeDefinitions = Object.fromEntries(
        info.graphNodes.map((n) => [n.nodeName, n]),
      );
    }
  }

  /**
   * Move standalone `tag` nodes onto the next attach-target node
   * (function / graphNode / assignment / functionCall / typeAlias).
   * Public so consumers like the doc generator can run the same
   * tag-attachment that the full `preprocess()` pipeline runs without
   * also running every downstream transform.
   */
  attachTags(): void {
    this.program.nodes = collectTags(this.program.nodes);
  }

  attachDocComments(): void {
    const nodes = this.program.nodes;
    const DECLARATION_TYPES = ["function", "graphNode", "typeAlias", "effectDeclaration"];
    const SKIP_TYPES = ["newLine", "tag"];
    const PREAMBLE_TYPES = ["comment", "newLine", "importStatement"];

    // First pass: extract and validate @module doc comment.
    // It must appear before any non-import code, and there can be at most one.
    let seenNonPreamble = false;
    let foundModuleDoc = false;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.type === "multiLineComment") {
        const mc = node as AgencyMultiLineComment;
        if (mc.isModuleDoc) {
          const line = mc.loc?.line != null ? mc.loc.line + 1 : "unknown";
          if (foundModuleDoc) {
            throw new Error(
              `Only one @module doc comment is allowed per file (duplicate found at line ${line}).`
            );
          }
          if (seenNonPreamble) {
            throw new Error(
              `@module doc comment must appear before any code (found at line ${line}). ` +
              `Move it to the top of the file or right after the imports.`
            );
          }
          this.program.docComment = mc;
          nodes.splice(i, 1);
          i--;
          foundModuleDoc = true;
          continue;
        }
        // Non-module multiline comments in the preamble are fine
        if (!mc.isDoc) continue;
      }
      if (!PREAMBLE_TYPES.includes(node.type) && node.type !== "multiLineComment") {
        seenNonPreamble = true;
      }
    }

    // Second pass: attach remaining doc comments to declarations
    const result: AgencyNode[] = [];
    let pendingDocComment: AgencyMultiLineComment | null = null;

    for (const node of nodes) {
      if (node.type === "multiLineComment" && node.isDoc) {
        pendingDocComment = node as AgencyMultiLineComment;
        continue;
      }

      // Skip nodes that shouldn't break doc comment attachment
      if (pendingDocComment && SKIP_TYPES.includes(node.type)) {
        result.push(node);
        continue;
      }

      if (pendingDocComment && DECLARATION_TYPES.includes(node.type)) {
        const decl = node as
          | FunctionDefinition
          | GraphNodeDefinition
          | TypeAlias
          | EffectDeclaration;
        decl.docComment = pendingDocComment;
        pendingDocComment = null;
      } else if (pendingDocComment) {
        // Doc comment wasn't followed by a declaration — keep it as a regular comment
        result.push(pendingDocComment);
        pendingDocComment = null;
      }

      result.push(node);
    }

    // Handle trailing doc comment
    if (pendingDocComment) {
      result.push(pendingDocComment);
    }

    this.program.nodes = result;
  }

  /**
   * Look up the BlockType for a function's block parameter by function name.
   * Checks both local function definitions and imported function signatures.
   */
  private findBlockType(functionName: string): BlockType | null {
    const fnDef = this.functionDefinitions[functionName];
    const params = fnDef?.parameters ?? this.importedFunctions[functionName]?.parameters;
    if (!params) return null;
    const blockParam = params.find(p => p.typeHint?.type === "blockType");
    return (blockParam?.typeHint as BlockType) ?? null;
  }

  /**
   * Copy type annotations from a BlockType onto block params that lack them.
   */
  private applyBlockType(block: BlockArgument, blockType: BlockType): void {
    for (let i = 0; i < block.params.length; i++) {
      if (!block.params[i].typeHint && blockType.params[i]) {
        block.params[i].typeHint = blockType.params[i].typeAnnotation;
      }
    }
  }

  /**
   * Walk the AST and propagate block type annotations from function definitions
   * onto direct block arguments that lack type annotations.
   * e.g. map([1,2,3]) as x { ... } — copies param types from map's block type onto x.
   *
   * Note: blocks inside named args (e.g. fn.partial(func: \x -> x)) are not yet
   * handled — the preprocessor would need valueAccess chain resolution to find
   * the receiver function. The builder falls back to 'any' for untyped block params.
   */
  propagateBlockTypes(): void {
    for (const { node } of walkNodesArray(this.program.nodes)) {
      if (node.type !== "functionCall") continue;
      const call = node as FunctionCall;

      if (call.block) {
        const blockType = this.findBlockType(call.functionName);
        if (blockType) {
          this.applyBlockType(call.block, blockType);
        }
      }
    }
  }

  preprocess(): AgencyProgram {
    this.attachDocComments();
    this.program.nodes = collectTags(this.program.nodes);
    // Guard constructs lower to the legacy _guard call before the
    // LATER passes here — parallel desugar and callback lifting — so
    // those see the call+blockArgument shape they have always seen.
    // (Match-expr lowering is NOT one of them: `lowerPatterns` runs at
    // parse time, before SymbolTable.build, and meets the construct
    // directly — which is why patternLowering.ts has its own guardBlock
    // handling, including at assignment/return VALUE positions.)
    // Idempotent: the TypeChecker constructor may have desugared this
    // program already. See guardDesugar.ts.
    this.program.nodes = desugarGuardsInBody(this.program.nodes);
    this.desugarParallelBlocks();
    if (Object.keys(this.functionDefinitions).length === 0) {
      this.getFunctionDefinitions();
    }
    if (Object.keys(this.graphNodeDefinitions).length === 0) {
      this.getGraphNodeDefinitions();
    }
    prunePreludeShadows(this.program);
    this.propagateBlockTypes();
    injectSchemaArgsInProgram(
      this.program,
      this.functionDefinitions,
      this.importedFunctions,
    );
    this.collectSkills();
    this.addAwaitPendingCalls();
    this.validateNoAsyncInLoops();

    this.resolveVariableScopes();
    return this.program;
  }

  /**
   * Walk every function and graph-node body and desugar `parallel { ... }`
   * blocks into the existing `fork` primitive. Also inlines any `seq { ... }`
   * blocks that appear outside a parallel block (where they have no runtime
   * effect). See lib/preprocessors/parallelDesugar.ts.
   */
  protected desugarParallelBlocks(): void {
    for (const node of this.program.nodes) {
      if (node.type === "function" || node.type === "graphNode") {
        node.body = desugarParallelInBody(node.body);
      }
    }
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
      } else if (node.type === "handleBlock") {
        this._collectAsyncVariablesInScope(node.body, asyncVarToAssignment);
      } else if (node.type === "withModifier") {
        this._collectAsyncVariablesInScope([node.statement], asyncVarToAssignment);
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
      } else if (node.type === "handleBlock") {
        const found = this._findFirstUsageInScope(
          node.body,
          varName,
          assignmentNode,
          [...bodyPath, i],
        );
        if (found) return found;
      } else if (node.type === "withModifier") {
        const found = this._findFirstUsageInScope(
          [node.statement],
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
      node.type === "handleBlock" ||
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
        // Strict accessor — emitted inside function/node bodies that
        // run under the withAlsFrame wrap. Bare `__ctx` would still
        // work today (the setupEnv local is in scope), but using the
        // accessor keeps this consistent with the rest of the codegen
        // post-ALS migration and makes the no-frame failure mode
        // actionable.
        const awaitPendingCode: RawCode = {
          type: "rawCode",
          value: `await getRuntimeContext().ctx.pendingPromises.awaitPending([${keyArray}]);`,
        };
        newBody.push(awaitPendingCode);
      }

      // Recursively process nested bodies
      if (node.type === "messageThread") {
        node.body = this._insertAwaitPendingCalls(node.body, locationToVars, [
          ...currentPath,
          i,
        ]);
      } else if (node.type === "whileLoop") {
        node.body = this._insertAwaitPendingCalls(node.body, locationToVars, [
          ...currentPath,
          i,
        ]);
      } else if (node.type === "handleBlock") {
        node.body = this._insertAwaitPendingCalls(node.body, locationToVars, [
          ...currentPath,
          i,
        ]);
      } else if (node.type === "withModifier") {
        node.statement = this._insertAwaitPendingCalls([node.statement], locationToVars, [
          ...currentPath,
          i,
        ])[0];
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
      node.type === "messageThread" ||
      node.type === "handleBlock"
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
   * Get the scope name for a function-like node (function or graphNode).
   */
  private getScopeName(node: AgencyNode): string {
    if (node.type === "function") return node.functionName;
    if (node.type === "graphNode") return node.nodeName;
    return "unknown";
  }

  /**
   * Resolve variable scopes by annotating AST nodes with their scope.
   * After this pass, every VariableNameLiteral, InterpolationSegment, and Assignment
   * will have a `scope` property indicating whether the variable is global, local, or args.
   */
  /**
   * Resolve variable scopes inside block bodies with full lexical nesting.
   *
   * Each block in the function/node body gets a frame of declared names
   * (params -> "blockArgs", let/const + implicit locals -> "block"). A
   * reference resolves innermost-first across the block chain; the relative
   * distance to the owning block is recorded as `blockDepth` (0 = current
   * block). Names not owned by any block fall back to `lookupScope`
   * (node-local/global/imported) or are left unscoped for the node-body
   * pass / final imported pass.
   *
   * Blocks are identified by their `BlockArgument` AST-node identity, and a
   * node's block-ancestor chain (outermost-first) is read from the
   * `blockArgument` entries in its `walkNodes` ancestor list.
   */
  // eslint-disable-next-line max-lines-per-function -- self-contained lexical block resolver
  private resolveBlockScopes(
    body: AgencyNode[],
    nodeName: string,
    lookupScope: (funcName: string, varName: string) => ScopeType | null,
  ): void {
    // One frame per block, keyed by `BlockArgument` object identity (looked
    // up with `find` / `===`). Plain object + arrays per the repo coding
    // standards (no Map/Set). `params`/`locals` are name lists tested with
    // `includes`.
    type Frame = { block: BlockArgument; params: string[]; locals: string[] };
    const frames: Frame[] = [];

    // Outermost-first list of the block-ancestor chain for a walk result.
    const blockChain = (ancestors: WalkAncestor[]): BlockArgument[] =>
      ancestors.filter(
        (a): a is BlockArgument => (a as AgencyNode).type === "blockArgument",
      );

    const ensureFrame = (b: BlockArgument): Frame => {
      let f = frames.find((fr) => fr.block === b);
      if (!f) {
        f = { block: b, params: b.params.map((p) => p.name), locals: [] };
        frames.push(f);
      }
      return f;
    };

    const addLocal = (f: Frame, name: string): void => {
      if (!f.locals.includes(name)) f.locals.push(name);
    };

    // Resolve a name against a chain; returns owner scope + relative depth,
    // or null if not owned by any block in the chain.
    const resolveInChain = (
      name: string,
      chain: BlockArgument[],
    ): { scope: "block" | "blockArgs"; blockDepth: number } | null => {
      for (let i = chain.length - 1; i >= 0; i--) {
        const f = ensureFrame(chain[i]);
        const depth = chain.length - 1 - i;
        if (f.params.includes(name)) return { scope: "blockArgs", blockDepth: depth };
        if (f.locals.includes(name)) return { scope: "block", blockDepth: depth };
      }
      return null;
    };

    const walk = walkNodesArray(body);

    // Register every block frame (params) up front.
    for (const { ancestors } of walk) {
      for (const b of blockChain(ancestors)) ensureFrame(b);
    }

    // Pass A: let/const declarations always create a local in their own block.
    for (const { node, ancestors } of walk) {
      if (node.type !== "assignment" || !node.declKind) continue;
      const chain = blockChain(ancestors);
      if (chain.length === 0) continue; // node-body decl -> Phase 2 handles it
      addLocal(ensureFrame(chain[chain.length - 1]), node.variableName);
    }

    // Pass B: implicit locals from bare assignments, shallow blocks first so
    // an inner block can see an outer block's implicit local.
    const bareAssignments = walk
      .filter(({ node }) => node.type === "assignment" && !node.declKind)
      .map((r) => ({ node: r.node as Assignment, chain: blockChain(r.ancestors) }))
      .filter((r) => r.chain.length > 0)
      .sort((a, b) => a.chain.length - b.chain.length);
    for (const { node, chain } of bareAssignments) {
      const name = node.variableName;
      if (resolveInChain(name, chain)) continue; // existing block var
      if (lookupScope(nodeName, name) !== null) continue; // node-local/global
      addLocal(ensureFrame(chain[chain.length - 1]), name); // implicit local
    }

    // Resolve `name` against the block chain and, if owned by a block,
    // stamp `scope` + `blockDepth` onto `target`. When `lookupFallback` is
    // set, a name not owned by any block is resolved to its node-local /
    // global / imported scope (used for plain variable references); for
    // callee/handler names it is left for the later functionRef/imported
    // pass instead. A `target` that already has a scope is left untouched.
    const applyBlockScope = (
      target: { scope?: ScopeType; blockDepth?: number },
      name: string,
      chain: BlockArgument[],
      lookupFallback: boolean,
    ): void => {
      if (target.scope) return;
      const owned = resolveInChain(name, chain);
      if (owned) {
        target.scope = owned.scope;
        target.blockDepth = owned.blockDepth;
      } else if (lookupFallback) {
        const resolved = lookupScope(nodeName, name);
        if (resolved) target.scope = resolved;
      }
    };

    // Pass C: set scope + blockDepth on every reference inside a block.
    // Names appear in several node shapes: plain reads (`variableName`),
    // assignment targets, function-call callees, and `handle … with NAME`
    // handler refs. Each can name a block-local / block-param (e.g. a
    // `.partial(...)` result stored in a block `let`), which must resolve
    // to the owning block frame instead of a bare identifier.
    for (const { node, ancestors } of walk) {
      const chain = blockChain(ancestors);
      if (chain.length === 0) continue; // node-body node -> leave for Phase 2

      if (node.type === "assignment") {
        applyBlockScope(node, node.variableName, chain, true);
      } else if (node.type === "variableName") {
        applyBlockScope(node, node.value, chain, true);
      } else if (node.type === "functionCall") {
        applyBlockScope(node, node.functionName, chain, false);
      } else if (
        node.type === "handleBlock" &&
        node.handler.kind === "functionRef"
      ) {
        applyBlockScope(node.handler, node.handler.functionName, chain, false);
      }
    }
  }

  // eslint-disable-next-line max-lines-per-function -- multi-pass scope resolution; refactor tracked separately
  protected resolveVariableScopes(): void {
    const globalVars = new Set<string>();
    const staticVars = new Set<string>();
    const importedVars = new Set<string>();
    const funcArgs: Record<string, string[]> = {};
    const localVarsInFunction: Record<string, Set<string>> = {};

    // First, we collect all global and static variables
    for (const { node, scopes } of walkNodesArray(this.program.nodes)) {
      if (scopes.length === 0) {
        throw new Error(
          `Top-level nodes should have at least the global scope in their scopes array. Node: ${JSON.stringify({ node })}, scopes: ${JSON.stringify({ scopes })}`,
        );
      }
      if (scopes.at(-1)?.type !== "global") continue;
      if (node.type === "assignment") {
        if (node.static) {
          staticVars.add(node.variableName);
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
      }
    }

    const lookupScope = (
      funcName: string,
      varName: string,
    ): ScopeType | null => {
      // Local scopes (args, locals) take precedence over global scopes,
      // so that `let x` inside a function shadows a global `x`.
      if (funcArgs[funcName] && funcArgs[funcName].includes(varName)) {
        return "args";
      }
      if (
        localVarsInFunction[funcName] &&
        localVarsInFunction[funcName].has(varName)
      ) {
        return "local";
      }
      // imported takes precedence over global
      if (importedVars.has(varName)) {
        return "imported";
      }
      if (staticVars.has(varName)) {
        return "static";
      }
      if (globalVars.has(varName)) {
        return "global";
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
      const isFunctionLike = node.type === "function" || node.type === "graphNode";
      if (isFunctionLike) {
        const nodeName = this.getScopeName(node);
        // Parameters are in the function's scope
        funcArgs[nodeName] = [...node.parameters.map((p) => p.name)];
        localVarsInFunction[nodeName] = new Set();

        // Pre-register `let`/`const` declarations from the function/node body
        // (but NOT from inside block bodies) so that Phase 1's `lookupScope`
        // calls can correctly resolve outer-scope variables that are captured
        // by closures inside blocks. Without this, a block referencing an
        // outer `let`/`const` would treat the variable as block-local because
        // Phase 2 (which populates localVarsInFunction) hasn't run yet.
        for (const { node: declNode, ancestors } of walkNodesArray(node.body)) {
          if (
            declNode.type === "assignment" &&
            declNode.declKind &&
            !isInsideBlock(ancestors)
          ) {
            localVarsInFunction[nodeName].add(declNode.variableName);
          }
        }

        // Phase 1: Resolve block body variables first, with full lexical
        // nesting (see `resolveBlockScopes`). Block params get "blockArgs",
        // new block locals get "block", and references to a variable owned
        // by an *enclosing* block record the relative `blockDepth`. We do
        // this before the main walk so it sees these variables already
        // scoped and skips them.
        this.resolveBlockScopes(node.body, nodeName, lookupScope);

        // Phase 2: Resolve function/node body variables.
        // Variables inside blocks already have scopes from Phase 1, so they are skipped.
        const varsDefinedInFunction = getAllVariablesInBodyArray(node.body);
        for (const { node: varNode } of varsDefinedInFunction) {
          if (varNode.type === "assignment") {
            if (varNode.scope) continue; // already resolved in block Phase 1
            let scope: ScopeType;
            if (varNode.declKind) {
              // `let` or `const` declarations always create a new local variable,
              // even if a global with the same name exists.
              scope = "local";
              localVarsInFunction[nodeName].add(varNode.variableName);
            } else {
              scope = lookupScope(nodeName, varNode.variableName) ?? "local";
              if (scope === "static") {
                throw new Error(
                  `Cannot reassign static variable '${varNode.variableName}'. Static variables are immutable after initialization.`
                );
              }
              if (scope === "local") {
                localVarsInFunction[nodeName].add(varNode.variableName);
              }
            }
            varNode.scope = scope;
          } else if (varNode.type === "variableName") {
            if (varNode.scope) continue; // already resolved in block Phase 1
            const resolved = lookupScope(nodeName, varNode.value);
            if (resolved) {
              varNode.scope = resolved;
            } else if (this.graphNodeDefinitions[varNode.value]) {
              throw new Error(
                `Cannot use node "${varNode.value}" as a value. Nodes are graph transitions, not functions.`,
              );
            } else if (this.functionDefinitions[varNode.value]) {
              varNode.scope = "functionRef";
            } else {
              varNode.scope = "imported";
            }
          }
        }

        // Resolve scope on function call nodes in this function/node body
        for (const { node: callNode } of walkNodesArray(node.body)) {
          if (callNode.type === "functionCall" && !callNode.scope) {
            const name = callNode.functionName;
            if (this.functionDefinitions[name]) {
              callNode.scope = "functionRef";
            } else {
              const resolved = lookupScope(nodeName, name);
              callNode.scope = resolved ?? "imported";
            }
          }
        }

        // Resolve scope on `handle { } with NAME` handler refs in this
        // function/node body. Without this, codegen emits a bare
        // `__call(NAME, ...)` that misses local variables stored in
        // `__stack.locals.NAME`.
        for (const { node: handleNode } of walkNodesArray(node.body)) {
          if (
            handleNode.type === "handleBlock" &&
            handleNode.handler.kind === "functionRef" &&
            !handleNode.handler.scope
          ) {
            const name = handleNode.handler.functionName;
            const resolved = lookupScope(nodeName, name);
            if (resolved) {
              handleNode.handler.scope = resolved;
            } else if (this.graphNodeDefinitions[name]) {
              throw new Error(
                `Cannot use node "${name}" as a handler. Nodes are graph transitions, not functions.`,
              );
            } else if (this.functionDefinitions[name]) {
              handleNode.handler.scope = "functionRef";
            } else {
              handleNode.handler.scope = "imported";
            }
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
          if (scope) {
            node.scope = scope;
          } else if (node.type === "variableName" && this.graphNodeDefinitions[name]) {
            throw new Error(
              `Cannot use node "${name}" as a value. Nodes are graph transitions, not functions.`,
            );
          } else if (node.type === "variableName" && this.functionDefinitions[name]) {
            node.scope = "functionRef";
          } else {
            node.scope = "imported";
          }
        }
      }
    }

    // Resolve scope on top-level function call nodes
    for (const { node } of walkNodesArray(this.program.nodes)) {
      if (node.type === "functionCall" && !node.scope) {
        const name = node.functionName;
        if (this.functionDefinitions[name]) {
          node.scope = "functionRef";
        } else {
          const scope = lookupScope("", name);
          node.scope = scope ?? "imported";
        }
      }
    }

    // Resolve scope on expressions inside function/node doc string
    // interpolations. These execute at module load time when the tool
    // definition is constructed, so they only see top-level (global /
    // static / imported) names, never function parameters or locals.
    for (const node of this.program.nodes) {
      if (node.type !== "function" && node.type !== "graphNode") continue;
      if (!node.docString) continue;
      for (const seg of node.docString.segments) {
        if (seg.type !== "interpolation") continue;
        for (const { node: inner } of walkNodesArray([seg.expression])) {
          if (inner.type === "variableName" && !inner.scope) {
            const resolved = lookupScope("", inner.value);
            if (resolved) {
              inner.scope = resolved;
            } else if (this.functionDefinitions[inner.value]) {
              inner.scope = "functionRef";
            } else {
              inner.scope = "imported";
            }
          } else if (inner.type === "functionCall" && !inner.scope) {
            const name = inner.functionName;
            if (this.functionDefinitions[name]) {
              inner.scope = "functionRef";
            } else {
              inner.scope = lookupScope("", name) ?? "imported";
            }
          }
        }
      }
    }
  }

}
