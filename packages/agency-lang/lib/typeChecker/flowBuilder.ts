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
  for (const { node } of walkNodes(body)) {
    const isBareRebind =
      node.type === "assignment" && !node.accessChain && !node.pattern;
    if (isBareRebind && !names.includes(node.variableName)) {
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
    attachExpressionsToFlow(node.value as AgencyNode, flow, env);
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

  // Match arms are conservative: each arm builds from the current flow, and the
  // post-match flow is unchanged (match-arm narrowing is a separate track).
  // `c.body` is a single node (matchBlock.ts:12), wrapped in `[]` to reuse
  // buildFlowGraph — same shape as walkScopeBody (scopes.ts:470).
  matchBlock: (node, flow, env) => {
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
};

/** Statements with no rule (e.g. `importStatement`) leave the flow unchanged. */
const passThrough = (_node: AgencyNode, flow: FlowNode): FlowNode => flow;

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
