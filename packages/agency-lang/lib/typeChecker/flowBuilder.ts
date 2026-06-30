import type { AgencyNode } from "../types.js";
import { Scope, type ScopeType } from "./scope.js";
import { expressionChildren, walkNodes } from "../utils/node.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import { analyzeCondition } from "./narrowing.js";
import {
  type FlowNode,
  type FlowEnvironment,
  wrapFacts,
  mergeFlows,
  widenAtLoopBackEdge,
} from "./flow.js";

/**
 * Attach `flow` to every variable-referencing node inside an expression. The
 * leaf rule (set `flowOf` on `variableName`/`valueAccess`) plus a recurse over
 * `expressionChildren` is the whole walk. Short-circuit operators get per-side
 * flow in Task 4 as a special case ahead of this general path.
 */
export function attachExpressionsToFlow(
  node: AgencyNode | null | undefined,
  flow: FlowNode,
  env: FlowEnvironment,
): void {
  if (!node) {
    return;
  }
  // Short-circuit: the RHS of `&&` runs only when the LHS is truthy (then-facts);
  // the RHS of `||` only when the LHS is falsy (else-facts). Recurse through
  // this same function (not the flow-agnostic child walk) so the split holds at
  // any nesting depth.
  if (
    node.type === "binOpExpression" &&
    (node.operator === "&&" || node.operator === "||")
  ) {
    attachExpressionsToFlow(node.left as AgencyNode, flow, env);
    const leftFacts = analyzeCondition(node.left);
    const rightFlow = wrapFacts(
      flow,
      node.operator === "&&" ? leftFacts.then : leftFacts.else,
    );
    attachExpressionsToFlow(node.right as AgencyNode, rightFlow, env);
    return;
  }
  if (node.type === "variableName" || node.type === "valueAccess") {
    env.flowOf.set(node, flow);
  }
  for (const child of expressionChildren(node)) {
    attachExpressionsToFlow(child, flow, env);
  }
}

/**
 * Names of variables a body rebinds (for loop widening). Bare `x = …` only —
 * access-chain mutations and destructuring patterns are excluded, matching the
 * `assignment` rule below.
 */
export function assignedNames(body: AgencyNode[]): string[] {
  const names: string[] = [];
  for (const { node, ancestors } of walkNodes(body)) {
    // Assignments inside a nested function/graphNode rebind a variable in THAT
    // definition's scope, not the loop's — skip them so the back-edge doesn't
    // widen names unnecessarily.
    const insideNestedDef = ancestors.some(
      (a) => a.type === "function" || a.type === "graphNode",
    );
    const isBareRebind =
      node.type === "assignment" && !node.accessChain && !node.pattern;
    if (!insideNestedDef && isBareRebind && !names.includes(node.variableName)) {
      names.push(node.variableName);
    }
  }
  return names;
}

/** statement kind → its flow transformation. The "what". */
type StatementRuleTable = {
  [K in AgencyNode["type"]]?: (
    node: Extract<AgencyNode, { type: K }>,
    flow: FlowNode,
    env: FlowEnvironment,
  ) => FlowNode;
};

const statementRules: StatementRuleTable = {
  assignment: (node, flow, env) => {
    // Attaches the RHS and any access-chain operands (e.g. `obj[i()] = v`),
    // both covered by expressionChildren(assignment).
    attachExpressionsToFlow(node, flow, env);
    // Record the pre-assignment flow on the assignment node itself. The Phase B
    // access-chain target check (checkAssignmentValue) builds a *synthetic* base
    // `variableName` node to resolve `obj.field`/`obj[k]` writes; that synthetic
    // node has no flowOf entry of its own, so without this the base would resolve
    // to its flat (un-narrowed) scope type. The check reads this entry to narrow
    // the base via typeAt.
    env.flowOf.set(node, flow);
    // Only a bare `x = …` / `let x = …` rebinds the variable. Skip access-chain
    // writes (`obj.x = 5` — a mutation, not a rebind; matches walkScopeBody)
    // and destructuring patterns (`node.variableName` not meaningful). The RHS
    // is still attached above; PR 2 must not trust assign nodes for these.
    if (node.accessChain || node.pattern) {
      return flow;
    }
    return {
      kind: "assign",
      prev: flow,
      ref: { variable: node.variableName, chain: [] },
      type: env.scope.lookup(node.variableName) ?? "any",
    };
  },

  returnStatement: (node, flow, env) => {
    attachExpressionsToFlow(node.value, flow, env);
    return { kind: "exit" };
  },

  ifElse: (node, flow, env) => {
    attachExpressionsToFlow(node.condition as AgencyNode, flow, env);
    const facts = analyzeCondition(node.condition);
    const thenEnd = buildFlowGraph(node.thenBody, wrapFacts(flow, facts.then), env);
    const elseStart = wrapFacts(flow, facts.else);
    const elseEnd = node.elseBody
      ? buildFlowGraph(node.elseBody, elseStart, env)
      : elseStart;
    // Post-guard narrowing falls out: a returning branch ends in `exit`, which
    // mergeFlows drops, leaving the surviving branch's (narrowed) flow.
    return mergeFlows([thenEnd, elseEnd]);
  },

  whileLoop: (node, flow, env) => {
    attachExpressionsToFlow(node.condition as AgencyNode, flow, env);
    const facts = analyzeCondition(node.condition);
    const bodyEnd = buildFlowGraph(node.body, wrapFacts(flow, facts.then), env);
    return wrapFacts(
      widenAtLoopBackEdge(flow, bodyEnd, assignedNames(node.body), env),
      facts.else,
    );
  },
  forLoop: (node, flow, env) => {
    attachExpressionsToFlow(node.iterable as AgencyNode, flow, env);
    const bodyEnd = buildFlowGraph(node.body, flow, env);
    return widenAtLoopBackEdge(flow, bodyEnd, assignedNames(node.body), env);
  },

  // Intra-scope blocks thread flow through their body.
  messageThread: (node, flow, env) => buildFlowGraph(node.body, flow, env),
  parallelBlock: (node, flow, env) => buildFlowGraph(node.body, flow, env),
  seqBlock: (node, flow, env) => buildFlowGraph(node.body, flow, env),

  handleBlock: (node, flow, env) => {
    const afterBody = buildFlowGraph(node.body, flow, env);
    if (node.handler.kind === "inline") {
      buildFlowGraph(node.handler.body, afterBody, env);
    }
    return afterBody;
  },

  // Match arms are conservative: the scrutinee's refs attach to the current
  // flow, each arm builds from it, and the post-match flow is unchanged
  // (match-arm narrowing is a separate track). `c.body` is a single node
  // (matchBlock.ts:12), wrapped in `[]` to reuse buildFlowGraph — same shape as
  // walkScopeBody (scopes.ts:470).
  matchBlock: (node, flow, env) => {
    attachExpressionsToFlow(node.expression as AgencyNode, flow, env);
    for (const c of node.cases) {
      if (c.type !== "comment" && c.type !== "newLine") {
        buildFlowGraph([c.body], flow, env);
      }
    }
    return flow;
  },

  functionCall: (node, flow, env) => {
    attachExpressionsToFlow(node, flow, env);
    if (node.block) {
      buildFlowGraph(node.block.body, flow, env);
    }
    return flow;
  },

  // `with …` / `static …` wrap a single statement — thread flow through it so a
  // wrapped if/loop/assignment is modeled properly (walkScopeBody handles
  // neither, so this is the only place their bodies get flow).
  withModifier: (node, flow, env) => buildFlowGraph([node.statement], flow, env),
  staticStatement: (node, flow, env) => buildFlowGraph([node.statement], flow, env),
};

/**
 * Statements with no explicit flow semantics (`interruptStatement`,
 * `gotoStatement`, `newExpression`, bare expression statements, …) leave the
 * flow unchanged but STILL attach their expression references — otherwise their
 * `variableName`/`valueAccess` nodes would miss the `flowOf` invariant. Any node
 * kind not in `statementRules` routes here, so the invariant is robust to node
 * kinds not individually enumerated.
 */
const passThrough = (node: AgencyNode, flow: FlowNode, env: FlowEnvironment): FlowNode => {
  attachExpressionsToFlow(node, flow, env);
  return flow;
};

/**
 * Build the flow graph for one body. A pure fold: each statement's rule maps
 * the incoming flow to the next. Once `flow` is `exit`, the remaining
 * statements are unreachable, so the rule is not applied (no node is built
 * rooted at `exit`, where typeAt throws; dead-code refs go unattached, which
 * is harmless — PR 2 falls back to scope.lookup for nodes with no flow).
 */
export function buildFlowGraph(
  nodes: AgencyNode[],
  entry: FlowNode,
  env: FlowEnvironment,
): FlowNode {
  return nodes.reduce<FlowNode>((flow, node) => {
    if (flow.kind === "exit") {
      return flow;
    }
    const rule = (statementRules[node.type] ?? passThrough) as (
      node: AgencyNode,
      flow: FlowNode,
      env: FlowEnvironment,
    ) => FlowNode;
    return rule(node, flow, env);
  }, entry);
}

/**
 * Pass entry: build a flow graph per scope, sharing one `flowOf`/`memo` across
 * the whole check so PR 2 can look up any node. Each scope's build env carries
 * that scope (typeAt reads scope from `start` nodes, not `env.scope`, so the
 * shared graph state is safe). Stores a representative env on `ctx`; nothing
 * consults it yet (PR 1b is behavior-preserving).
 */
export function buildFlowGraphs(scopes: ScopeInfo[], ctx: TypeCheckerContext): void {
  const flowOf: WeakMap<AgencyNode, FlowNode> = new WeakMap();
  const memo: WeakMap<FlowNode, Record<string, ScopeType>> = new WeakMap();
  const typeAliases = ctx.getTypeAliases();
  for (const info of scopes) {
    const env: FlowEnvironment = { scope: info.scope, flowOf, typeAliases, memo };
    buildFlowGraph(info.body, { kind: "start", scope: info.scope }, env);
  }
  const rootScope = scopes[0]?.scope ?? new Scope("global");
  ctx.flowEnv = { scope: rootScope, flowOf, typeAliases, memo };
}
