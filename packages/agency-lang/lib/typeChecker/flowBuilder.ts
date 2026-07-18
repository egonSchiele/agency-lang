import { ANY_T } from "./primitives.js";
import type { AgencyNode, Expression, VariableType } from "../types.js";
import type { AccessChainElement } from "../types/access.js";
import { Scope, type ScopeType } from "./scope.js";
import { expressionChildren, walkNodes } from "../utils/node.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import { analyzeCondition } from "./narrowing.js";
import {
  type FlowNode,
  type FlowEnvironment,
  type Reference,
  wrapFacts,
  mergeFlows,
  widenAtLoopBackEdge,
  chainToSegments,
  declaredPathType,
  freshMemo,
  typeAt,
  uniteTypes,
  referenceKey,
} from "./flow.js";
import { isAnyType } from "./utils.js";
import { NULL_T } from "./primitives.js";

/**
 * The flow node after an access-chain write (`obj.field = x`, `arr[0] = x`): a
 * path-keyed `assign` so the path's narrowing is dropped (the field/element was
 * rebound). Returns `null` for an UNSTABLE target (`obj[i()] = x`) — it can't be
 * keyed, so it passes through (a known soundness gap; no aliasing analysis). The
 * assigned type is the path's DECLARED (un-narrowed) type, matching the
 * bare-rebind case.
 */
function assignNodeForAccessChainWrite(
  variableName: string,
  accessChain: AccessChainElement[],
  flow: FlowNode,
  env: FlowEnvironment,
): FlowNode | null {
  const chain = chainToSegments(accessChain);
  if (chain === null) return null;
  const ref = { variable: variableName, chain };
  return { kind: "assign", prev: flow, ref, type: declaredPathType(env.scope, ref, env.typeAliases) };
}

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
  // Block bodies narrow with the enclosing flow, regardless of where the
  // block-bearing call sits (statement, assignment value, pipe operand,
  // argument). A trailing block is `functionCall.block`; an inline `\… -> …`
  // block is a `blockArgument` reached via the call's arguments. Walk the body
  // as statements (buildFlowGraph) so declarations + nested guards inside the
  // block get flow nodes. The statement-level `functionCall` rule relies on this
  // (it no longer walks the block itself), so the body is walked exactly once.
  // CAVEAT: this narrows as if the block runs in the enclosing flow — a deferred
  // callback that runs after a later reassignment is the classic closure-
  // staleness limitation (pre-existing for statement-position blocks; not
  // addressed here).
  if (node.type === "functionCall" && node.block) {
    buildFlowGraph(node.block.body, flow, env);
  }
  if (node.type === "blockArgument") {
    buildFlowGraph(node.body, flow, env);
    return; // body walked as statements; no expression children to attach
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

/** The literal condition `true` — no constant folding (`1 == 1` doesn't count). */
function isLiteralTrue(cond: AgencyNode): boolean {
  return cond.type === "boolean" && cond.value === true;
}

/** A `break` that can exit the loop whose body this is: found anywhere in the
 *  body except (a) inside a nested loop — break binds to the nearest loop,
 *  (b) inside a nested function/node definition (same ancestor filter as
 *  assignedNames), or (c) inside an INLINE HANDLER body — handler bodies are
 *  codegen'd as separate arrow functions (`insideHandlerBody`;
 *  typescriptBuilder.ts processKeyword emits a bare `break` there), so a
 *  break in a `with (e) { ... }` body can never reach the enclosing Agency
 *  loop. Everything else counts, conservative toward the loop being
 *  escapable — a break in the guarded `handle { ... }` body or in a callback
 *  block compiles to runner.breakLoop(), which genuinely breaks the loop when
 *  it runs during an iteration. Traversal note (verified): walkNodes descends
 *  into every statement-bearing construct that could carry a loop-bound
 *  break — ifElse, loops, handleBlock body + inline handler body,
 *  thread/parallel/seq blocks, match arm bodies, withModifier — the only
 *  non-descended wrapper is staticStatement, which cannot meaningfully
 *  contain a break. */
function hasReachableBreak(body: AgencyNode[]): boolean {
  // Breaks under inline handler bodies can't escape the loop (see (c) above).
  // Collected by node identity so the main walk can skip exactly those.
  const handlerBodyBreaks: AgencyNode[] = [];
  for (const { node } of walkNodes(body)) {
    if (node.type !== "handleBlock" || node.handler.kind !== "inline") continue;
    for (const { node: inner } of walkNodes(node.handler.body)) {
      if (inner.type === "keyword" && inner.value === "break") {
        handlerBodyBreaks.push(inner);
      }
    }
  }
  for (const { node, ancestors } of walkNodes(body)) {
    if (node.type !== "keyword" || node.value !== "break") continue;
    if (handlerBodyBreaks.includes(node)) continue;
    const bindsElsewhere = ancestors.some(
      (a) =>
        a.type === "whileLoop" ||
        a.type === "forLoop" ||
        a.type === "function" ||
        a.type === "graphNode",
    );
    if (!bindsElsewhere) return true;
  }
  return false;
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
    // env.flowOf.set(node, flow) above records the PRE-write flow on the node
    // for the Phase-B access-chain target check — DO NOT reorder it below the
    // branches.
    env.flowOf.set(node, flow);
    if (node.pattern) {
      return flow; // destructuring — variableName not meaningful
    }
    if (node.accessChain) {
      // A write to a STABLE path (`obj.field = x`, `arr[0] = x`) emits a
      // path-keyed assign so the path's narrowing drops. Unstable targets
      // (`obj[i()] = x`) can't be keyed → pass through unchanged.
      return assignNodeForAccessChainWrite(node.variableName, node.accessChain, flow, env) ?? flow;
    }
    const assignFlow: FlowNode = {
      kind: "assign",
      prev: flow,
      ref: { variable: node.variableName, chain: [] },
      type: env.scope.lookup(node.variableName) ?? ANY_T,
    };
    // Expression-match consumer (`const x = match(...)`): the type snapshotted
    // above is stale — the union isn't computed until computeMatchExprTypes
    // runs AFTER this pass. Register the assign node so that pass can patch its
    // `type` in place. See FlowEnvironment.matchConsumerAssignFlows.
    if (node.matchExprSource) {
      env.matchConsumerAssignFlows?.set(node, assignFlow);
    }
    return assignFlow;
  },

  returnStatement: (node, flow, env) => {
    attachExpressionsToFlow(node.value, flow, env);
    // `return interrupt effect(...)` may RESUME: on approval, execution falls
    // through to the next statement (the gated-work idiom — see stdlib
    // git/wikipedia/memory). Treating it as `exit` would leave every statement
    // after it flow-less, silently degrading narrowing to bare scope.lookup.
    // Same passThrough-on-may-resume convention as `raise` (whileLoop note).
    if ((node.value as AgencyNode | undefined)?.type === "interruptStatement") {
      return flow;
    }
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
    // `while (true)` with no break that can exit THIS loop never falls
    // through: the post-loop flow is unreachable, so the loop diverges like a
    // `return` (definite-return §5b; also makes trailing statements dead code
    // to downstream consumers). The body was still built above so its refs
    // keep their flowOf entries; skipping widenAtLoopBackEdge here is
    // deliberate — widening only shapes the POST-loop flow, which does not
    // exist for a diverging loop (do not "restore" it). Scope note: only the
    // literal-true condition counts; `while (cond) { raise ... }` is out of
    // scope (raise is passThrough / may resume — same convention as
    // alwaysExits).
    if (isLiteralTrue(node.condition as AgencyNode) && !hasReachableBreak(node.body)) {
      return { kind: "exit" };
    }
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

  // Match arms narrow by the scrutinee condition. For each literal arm we build
  // the flow as if guarded by `scrutinee == <arm literal>` and feed that through
  // the SAME analyzeCondition/wrapFacts path an `if` uses — so a member-path
  // scrutinee like `e.effect` narrows its receiver `e` (D1 discriminant), making
  // `e.data` the matching member's payload inside the arm. Only POSITIVE (.then)
  // facts, each from the base flow (arms are independent — no cross-arm/negative
  // narrowing). Non-literal / `_` arms get the base flow unchanged. Post-match
  // flow is unchanged. `c.body` is an array of nodes (matchBlock.ts) fed directly
  // to buildFlowGraph — same shape as walkScopeBody (scopes.ts).
  matchBlock: (node, flow, env) => {
    attachExpressionsToFlow(node.expression as AgencyNode, flow, env);
    const scrutinee = node.expression as Expression;
    for (const c of node.cases) {
      if (c.type === "comment" || c.type === "newLine") continue;
      let armFlow = flow;
      // Narrow only plain literal arms. `_` is the default (no fact); a guarded
      // arm can't reach here today (guards force lowering to a temp+if-chain —
      // patternLowering.ts:256-265), but gate on `c.guard === undefined` so a
      // future lowering change can't silently feed a guarded arm through.
      if (c.caseValue !== "_" && c.guard === undefined) {
        // SYNTHETIC condition `scrutinee == <arm literal>`, never produced by the
        // parser. Safe because analyzeCondition is a pure structural read of only
        // `.operator`/`.left`/`.right` (no `loc`/parent pointers). It returns no
        // facts for a non-literal RHS or a non-path scrutinee → safe no-op there.
        const cond: Expression = {
          type: "binOpExpression",
          operator: "==",
          left: scrutinee,
          right: c.caseValue as Expression,
        };
        armFlow = wrapFacts(flow, analyzeCondition(cond).then);
      }
      buildFlowGraph(c.body, armFlow, env);
    }
    return flow;
  },

  functionCall: (node, flow, env) => {
    // attachExpressionsToFlow now descends into node.block / blockArgument
    // bodies itself, so the block body is walked exactly once here. Do NOT
    // re-add an explicit `buildFlowGraph(node.block.body, …)` — that would
    // double-walk the body.
    attachExpressionsToFlow(node, flow, env);
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
    if (node.type === "finalizeBlock") {
      // A finalize is a declaration: position-free, and NOT dead code
      // after an unconditional return (which turns `flow` to exit). Its
      // body is a side branch off the scope's START — when the finalize
      // runs, any statement might not have executed, so no positional
      // narrowing applies. Every scope-declared local is widened to
      // `T | null` (reusing the loop-widening node); a `!= null` check
      // inside the finalize narrows back through ordinary machinery.
      // The main flow passes through untouched, so a finalize `return`
      // never satisfies checkDefiniteReturns.
      const start: FlowNode = { kind: "start", scope: env.scope };
      const widened: Record<string, ScopeType> = Object.create(null);
      for (const name of env.scope.declaredNames()) {
        const ref: Reference = { variable: name, chain: [] };
        const declared = typeAt(ref, start, env);
        // Flatten a union-typed local before re-uniting: uniteTypes
        // dedupes but does not flatten, and presence narrowing only
        // drops TOP-LEVEL null members — `(T | null) | null` would
        // keep its inner null through an `if (x != null)` guard.
        const members =
          !isAnyType(declared) && (declared as VariableType).type === "unionType"
            ? (declared as { types: VariableType[] }).types
            : [declared];
        widened[referenceKey(ref)] = isAnyType(declared)
          ? declared
          : uniteTypes([...members, NULL_T], env.typeAliases);
      }
      buildFlowGraph(node.body, { kind: "loop", prev: start, widened }, env);
      return flow;
    }
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
  const memo = freshMemo();
  const matchConsumerAssignFlows: WeakMap<AgencyNode, FlowNode> = new WeakMap();
  const typeAliases = ctx.getTypeAliases();
  // Null-prototype: scopeKeys derive from user-controlled function/node names, so
  // a reserved key ("__proto__"/"toString"/…) must not collide with
  // Object.prototype on write or read (mirrors the flow memo dicts in flow.ts).
  const scopeTerminals: Record<string, FlowNode> = Object.create(null);
  for (const info of scopes) {
    if (info.scope.detached) {
      throw new Error(
        `buildFlowGraphs: scope for ${info.scopeKey} is a detached child scope. Flow start nodes must be built over function/top-level scopes only - detached scopes do not bump the generation counter, so a start node over one would silently un-protect the typeAt memo.`,
      );
    }
    const env: FlowEnvironment = {
      scope: info.scope,
      flowOf,
      typeAliases,
      memo,
      matchConsumerAssignFlows,
    };
    scopeTerminals[info.scopeKey] = buildFlowGraph(
      info.body,
      { kind: "start", scope: info.scope },
      env,
    );
  }
  // Empty scopes list fallback: an orphan root whose generation never moves.
  // Harmless — no flow nodes exist to memoize against in that case.
  const rootScope = scopes[0]?.scope ?? new Scope("global");
  ctx.flowEnv = {
    scope: rootScope,
    flowOf,
    typeAliases,
    memo,
    scopeTerminals,
    matchConsumerAssignFlows,
  };
}
