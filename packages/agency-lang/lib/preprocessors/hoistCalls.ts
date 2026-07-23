/**
 * hoistCalls — rewrite every statement so helper calls become their own
 * `const __hoist_N = ...` statements.
 *
 * Why: resume replay re-executes the statement that was in progress at a
 * pause, including helper calls that already completed. Those helpers
 * re-claim frames from the positional restore queue and desync it (the
 * still-live owner gets a blank frame and re-issues work). A hoisted
 * helper is its own runner step: completed steps are skipped on resume
 * and their value is read back from `__stack.locals`, so the helper
 * never re-runs. Spec:
 * docs/superpowers/specs/2026-07-22-hoist-calls-resume-safety-design.md
 *
 * The invariant this pass establishes: after preprocessing, a statement
 * re-executes no completed frame-pushing call on resume — the only call
 * remaining in unconditionally-evaluated position is the statement's own
 * tail. Tails stay deliberately: hoisting them uniformly would need a
 * graph-node-call exclusion (node calls are control flow and THROW in
 * value position — typescriptBuilder's processNodeCall), while at tail
 * position they need no rule at all.
 *
 * Statement-body recursion is driven by `bodySlots` (the single source
 * of truth for which fields hold statements); only the expression
 * interior uses a generic child walk. Rulings are data, not control
 * flow — see RULINGS / OPERATOR_RULINGS below. Everything copies;
 * parsed AST is never mutated (in-place mutation burned this repo via
 * the parse cache clone-on-read fix).
 *
 * Temp naming: `__hoist_N`, ONE counter per frame-owning scope
 * (function, node, lifted block, fork branch), shared by every nested
 * statement list inside it. Frame locals are flat, so per-list
 * numbering would let a loop-body temp clobber the temp a loop
 * iterable re-reads on resume. Blocks own frames (blockSetup.mustache
 * pushes one), so block bodies restart at 0. Finalize bodies run on
 * the CONTAINER's frame (bodySlots documents this) and therefore share
 * the container's counter. Seeding scans the scope for existing
 * `__hoist_N` names and starts above the max — this seeding is the
 * collision protection; there is deliberately no lint rule (no other
 * compiler-reserved prefix has one).
 *
 * Known residuals (tripwire territory, not silent corruption): calls
 * nested inside opaque positions (short-circuit right sides, catch
 * expressions, try operands, `with`/`static` wrappers, mid-chain method
 * calls inside a hoisted chain), and block bodies nested inside opaque
 * expressions.
 */
import type { AgencyNode, AgencyProgram } from "../types.js";
import { bodySlots } from "../utils/bodySlots.js";
import { createKeyword } from "../types/keyword.js";

type Counter = { n: number };

type Extraction = { temps: AgencyNode[]; expr: any };

/** Expression-node rulings the walker consults before descending.
 *  "opaque" = never descend, hoist nothing inside (each row says why).
 *  Unlisted expression node types default to a generic child walk. */
const NODE_RULINGS: Record<string, "opaque"> = {
  // The whole operand compiles into the __tryCall thunk; hoisting an
  // argument out would run it outside the catch boundary and let its
  // throw escape uncaught.
  tryExpression: "opaque",
};

/** binOpExpression rulings by operator.
 *  - "catch": opaque. The fallback runs only on Failure (__catchResult);
 *    the left side is excluded too, purely for boundary simplicity — a
 *    temp for it would be semantically identical.
 *  - "|>": input-only. Stages are already resume-safe (memoized
 *    __pipe_result_<path>) AND conditional (__pipeBind skips them on
 *    Failure); the input is evaluated inline at statement level, outside
 *    the memoization, so it hoists.
 *  - "&&" / "||" / "??": left-only. The right side may never execute.
 *    The first inline call there is resume-aligned by construction
 *    (nothing before it consumes a frame on replay), so only calls
 *    NESTED under it remain residual.
 */
const OPERATOR_RULINGS: Record<string, "opaque" | "leftOnly"> = {
  catch: "opaque",
  "|>": "leftOnly",
  "&&": "leftOnly",
  "||": "leftOnly",
  "??": "leftOnly",
};

const SKIP_TYPES = ["comment", "newLine"];

export function hoistCallsInProgram(program: AgencyProgram): AgencyProgram {
  // Only function and graphNode bodies. Module-level initializers are
  // excluded by construction: they run through the per-variable init
  // dependency graph (docs/dev/init-topsort.md), cannot pause, and a
  // synthesized variable would be invisible to the topsort.
  return {
    ...program,
    nodes: program.nodes.map((node) => {
      if (node.type === "function" || node.type === "graphNode") {
        return { ...node, body: hoistCallsInScope((node as any).body) } as AgencyNode;
      }
      return node;
    }),
  };
}

/** Rewrite one frame-owning scope's statements. Pass `counter` when
 *  recursing into a nested statement list of the SAME frame (loop and
 *  if bodies, finalize bodies, thread blocks); omit it at a frame
 *  boundary (function, node, lifted block, fork branch) so numbering
 *  restarts against that frame's own flat locals. */
export function hoistCallsInScope(
  body: AgencyNode[],
  counter?: Counter,
): AgencyNode[] {
  const c = counter ?? { n: seedCounter(body) };
  const out: AgencyNode[] = [];
  for (const stmt of body) {
    if (!stmt || typeof stmt !== "object" || SKIP_TYPES.includes(stmt.type)) {
      out.push(stmt);
      continue;
    }
    out.push(...rewriteStatement(stmt, c));
  }
  return out;
}

/** Start numbering above any __hoist_N DECLARED in the scope's subtree
 *  (user-declared or from an earlier run of the pass). This scan is the
 *  collision protection; it also makes the pass idempotent. Walks the
 *  tree for assignment declarations rather than regexing serialized
 *  JSON, so a string literal containing "__hoist_5" cannot bump the
 *  counter and the cost stays one linear visit per scope. */
function seedCounter(body: AgencyNode[]): number {
  let max = -1;
  const visit = (n: any): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const item of n) visit(item);
      return;
    }
    if (n.type === "assignment" && typeof n.variableName === "string") {
      const m = n.variableName.match(/^__hoist_(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    for (const key of Object.keys(n)) {
      if (key !== "loc") visit(n[key]);
    }
  };
  visit(body);
  return max + 1;
}

// eslint-disable-next-line max-lines-per-function -- one case per statement kind; splitting would scatter the dispatch
function rewriteStatement(stmt: any, counter: Counter): AgencyNode[] {
  switch (stmt.type) {
    case "assignment": {
      // Indexed-assignment TARGETS carry expressions too:
      // `arr[pick(i)] = compute(i)` evaluates the index before the
      // value, so index temps come first and order is preserved.
      const chainTemps: AgencyNode[] = [];
      let out: any = stmt;
      if (Array.isArray(stmt.accessChain) && stmt.accessChain.length > 0) {
        const chain = walkChainEntries(stmt.accessChain, chainTemps, counter);
        out = { ...out, accessChain: chain };
      }
      const value = extractValue(stmt.value, counter);
      return [...chainTemps, ...value.temps, { ...out, value: value.expr }];
    }
    case "returnStatement": {
      if (!stmt.value) return [stmt];
      const value = extractValue(stmt.value, counter);
      return [...value.temps, { ...stmt, value: value.expr }];
    }
    case "functionCall":
    case "interruptStatement": {
      // A bare call statement: the call itself is the tail; its
      // arguments (and block body, via the slot recursion inside
      // walk) still hoist.
      const walked = walk(stmt, counter, false);
      return [...walked.temps, walked.expr];
    }
    case "gotoStatement": {
      // The node call is control flow (it transfers, and node calls
      // throw in value position), so it stays; its ARGUMENTS are
      // ordinary expressions evaluated before the transfer and hoist.
      const nodeCall = walk(stmt.nodeCall, counter, false);
      return [...nodeCall.temps, { ...stmt, nodeCall: nodeCall.expr }];
    }
    case "matchYield": {
      // Match-expression arm values (synthesized by lowerPatterns).
      // Same shape as returnStatement: the value's tail stays, nested
      // calls hoist — into the arm body, which is conditional-correct
      // because arms are their own statement lists. typeSource is a
      // typing-only mirror and stays untouched.
      if (!stmt.value) return [stmt];
      const value = extractValue(stmt.value, counter);
      return [...value.temps, { ...stmt, value: value.expr }];
    }
    case "messageThread": {
      // thread(label: makeLabel()) { ... } — the named-arg expressions
      // evaluate once at thread open. Hoisted temps sit right before
      // the statement; on a halted or resume-skipped runner both the
      // temp steps and the thread step are skipped together, matching
      // the lazy opts-thunk semantics.
      const temps: AgencyNode[] = [];
      let out: any = stmt;
      for (const key of ["label", "summarize", "continueExpr", "sessionExpr", "hidden"]) {
        const arg = out[key];
        if (arg && typeof arg === "object") {
          const inner = walk(arg, counter, true);
          temps.push(...inner.temps);
          if (inner.expr !== arg) out = { ...out, [key]: inner.expr };
        }
      }
      return [...temps, recurseSlots(out, counter)];
    }
    case "ifElse": {
      // The runtime memoizes the chosen branch (__condbranch_ on the
      // frame), so the condition already evaluates once; hoisting it
      // fixes the pause-INSIDE-the-condition replay. Conditions of
      // `else if` arms are nested ifElse statements inside elseBody,
      // so their temps land in that conditional list — correct by
      // construction.
      const cond = walk(stmt.condition, counter, true);
      const recursed = recurseSlots({ ...stmt, condition: cond.expr }, counter);
      return [...cond.temps, recursed];
    }
    case "whileLoop": {
      const cond = walk(stmt.condition, counter, true);
      if (cond.temps.length === 0) {
        return [recurseSlots(stmt, counter)];
      }
      // while (COND) { BODY } with calls in COND becomes
      //   while (true) { <temps>; if (COND') { BODY' } else { break } }
      // No synthesized negation on purpose: the parser cannot even
      // produce `!(<comparison>)`, and a hand-rolled unary emission
      // prints `(!h) < 5` silently. The if/else form has no operator
      // to get wrong. `continue` in BODY still lands on the re-check
      // (loop top). Why this position matters most: Runner.whileLoop
      // awaits the condition BEFORE the completed-iteration skip, so
      // today a condition call re-runs once per completed iteration
      // on resume.
      const loc = stmt.condition.loc ?? stmt.loc;
      const innerBody = hoistCallsInScope(stmt.body, counter);
      const gate: any = {
        type: "ifElse",
        condition: cond.expr,
        thenBody: innerBody,
        elseBody: [{ ...createKeyword("break"), loc }],
        loc,
      };
      return [
        {
          ...stmt,
          condition: { type: "boolean", value: true, loc },
          body: [...cond.temps, gate],
        },
      ];
    }
    case "forLoop": {
      // The iterable is materialized once at loop entry (runner.loop),
      // so a single evaluation before the loop is equivalent — and the
      // temp's step makes it resume-safe.
      const iter = walk(stmt.iterable, counter, true);
      const recursed = recurseSlots({ ...stmt, iterable: iter.expr }, counter);
      return [...iter.temps, recursed];
    }
    case "matchBlock": {
      // The scrutinee evaluates once; case bodies recurse via slots.
      const subject = walk(stmt.expression, counter, true);
      const recursed = recurseSlots(
        { ...stmt, expression: subject.expr },
        counter,
      );
      return [...subject.temps, recursed];
    }
    case "withModifier":
    case "staticStatement":
      // Opaque: hoisting out of a `with` region would move the call
      // outside the modifier's approval scope; `static` initializers
      // belong to init-topsort. Both wrap exactly one statement
      // (bodySlots `single`), which a multi-statement rewrite would
      // break anyway.
      return [stmt];
    default:
      return [recurseSlots(stmt, counter)];
  }
}

/** Recurse into a statement's nested statement bodies via bodySlots —
 *  the drift-proof enumeration of which fields hold statements. Slot
 *  policy:
 *  - handleBlock's inline handler body: skipped. Handler bodies compile
 *    to plain JavaScript without steps and cannot pause (#616), and
 *    handlers are safety infrastructure this pass has no license to
 *    restructure.
 *  - lifted-block slots (a functionCall's block argument, standalone
 *    blockArgument): a NEW frame-owning scope — fresh counter, and
 *    temps land inside the block body, never the enclosing one.
 *  - everything else (if/loop/match/finalize/thread bodies): same
 *    frame, same counter.
 */
function recurseSlots(stmt: any, counter: Counter): AgencyNode {
  let out: AgencyNode = stmt;
  for (const slot of bodySlots(out)) {
    if (stmt.type === "handleBlock" && slot.retargetsReturn) {
      continue;
    }
    const ownFrame =
      slot.blockAncestor !== undefined || stmt.type === "blockArgument";
    const newBody = ownFrame
      ? hoistCallsInScope(slot.body)
      : hoistCallsInScope(slot.body, counter);
    out = slot.write(out, newBody);
  }
  return out;
}

/** Extract from a statement's value position: the outermost call (or
 *  call-bearing access chain) is the statement's tail and stays; every
 *  other unconditionally-evaluated call hoists. */
function extractValue(expr: any, counter: Counter): Extraction {
  if (expr?.type === "functionCall" || expr?.type === "valueAccess") {
    return walk(expr, counter, false);
  }
  return walk(expr, counter, true);
}

/** The expression walker. Returns fresh nodes; never mutates. `hoistSelf`
 *  is true everywhere except the single statement-tail node, which the
 *  statement dispatcher withholds by calling with false. */
// eslint-disable-next-line max-lines-per-function -- ruling dispatch + one case per expression family
function walk(node: any, counter: Counter, hoistSelf: boolean): Extraction {
  if (!node || typeof node !== "object") return { temps: [], expr: node };

  if (NODE_RULINGS[node.type] === "opaque") {
    return { temps: [], expr: node };
  }

  if (node.type === "binOpExpression") {
    const ruling = OPERATOR_RULINGS[node.operator];
    if (ruling === "opaque") return { temps: [], expr: node };
    if (ruling === "leftOnly") {
      const left = walk(node.left, counter, true);
      return { temps: left.temps, expr: { ...node, left: left.expr } };
    }
    const left = walk(node.left, counter, true);
    const right = walk(node.right, counter, true);
    return {
      temps: [...left.temps, ...right.temps],
      expr: { ...node, left: left.expr, right: right.expr },
    };
  }

  if (node.type === "ifElse") {
    // A value-position if-expression (normally lowered at parse time;
    // defensive): condition is unconditional, branches are not.
    const cond = walk(node.condition, counter, true);
    return { temps: cond.temps, expr: { ...node, condition: cond.expr } };
  }

  if (node.type === "functionCall") {
    const temps: AgencyNode[] = [];
    const args = (node.arguments ?? []).map((arg: any) => {
      const inner =
        arg?.type === "namedArgument"
          ? walk(arg.value, counter, true)
          : walk(arg, counter, true);
      temps.push(...inner.temps);
      return arg?.type === "namedArgument"
        ? { ...arg, value: inner.expr }
        : inner.expr;
    });
    let call: any = { ...node, arguments: args };
    if (node.block) {
      // The block body is a new frame-owning scope; its temps stay
      // inside it. Recursed here (not via recurseSlots) because in
      // expression position the call is not a statement.
      call = {
        ...call,
        block: { ...node.block, body: hoistCallsInScope(node.block.body) },
      };
    }
    if (!hoistSelf) return { temps, expr: call };
    const ref = makeTemp(call, temps, counter);
    return { temps, expr: ref };
  }

  if (node.type === "valueAccess") {
    // The BASE walks like any expression, so a call base hoists into
    // its own step: `getConfig().model` becomes `const __h =
    // getConfig()` then `__h.model` — the natural boundary, and its
    // arguments extract with it. Chain segments then hoist as a UNIT
    // when a method call remains: splitting a chain mid-way would mean
    // rebuilding it across statements. Method-call arguments, index
    // expressions, and slice bounds hoist first; a pause inside a
    // later chain segment re-running an earlier method call is a
    // documented residual (tripwire-covered).
    const temps: AgencyNode[] = [];
    const base = walk(node.base, counter, true);
    temps.push(...base.temps);
    const chain = walkChainEntries(node.chain ?? [], temps, counter);
    const chainHasMethodCall = (node.chain ?? []).some(
      (entry: any) => entry?.kind === "methodCall" && entry.functionCall,
    );
    const rebuilt = { ...node, base: base.expr, chain };
    if (!hoistSelf || !chainHasMethodCall) return { temps, expr: rebuilt };
    const ref = makeTemp(rebuilt, temps, counter);
    return { temps, expr: ref };
  }

  // Statement-bearing constructs in EXPRESSION position (a thread block
  // as an assignment value is the live case; bodySlots is the
  // authoritative enumeration). Their bodies recurse as statement
  // lists — walking them as expressions would hoist inner calls OUT of
  // the construct and change where they run. Placed after functionCall
  // (which owns its block-argument slot above) so ordinary calls keep
  // their argument walking.
  if (bodySlots(node).length > 0) {
    return { temps: [], expr: recurseSlots(node, counter) };
  }

  // Generic descent for every other expression family (arrays, objects,
  // splats, string interpolations, unary forms, named wrappers). Copies
  // each object-valued child through the walker; `loc` is data, not a
  // node. Statement lists cannot appear below this point: bodySlots
  // just claimed every construct that carries one.
  const temps: AgencyNode[] = [];
  let expr = node;
  for (const key of Object.keys(node)) {
    if (key === "loc") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      let changed = false;
      const mapped = child.map((item) => {
        if (item && typeof item === "object") {
          const inner = walk(item, counter, true);
          temps.push(...inner.temps);
          if (inner.expr !== item) changed = true;
          return inner.expr;
        }
        return item;
      });
      if (changed) expr = { ...expr, [key]: mapped };
    } else if (child && typeof child === "object") {
      const inner = walk(child, counter, true);
      temps.push(...inner.temps);
      if (inner.expr !== child) expr = { ...expr, [key]: inner.expr };
    }
  }
  return { temps, expr };
}

/** Walk the expression operands of an access chain (`a[i]`, `a[i:j]`,
 *  `a.m(x)`): method-call arguments extract with the call withheld as
 *  the segment's own operation, index expressions and slice bounds
 *  extract fully. Shared by valueAccess expressions and indexed
 *  assignment targets so the two cannot diverge. */
function walkChainEntries(
  chain: any[],
  temps: AgencyNode[],
  counter: Counter,
): any[] {
  return chain.map((entry: any) => {
    if (entry?.kind === "methodCall" && entry.functionCall) {
      const inner = walk(entry.functionCall, counter, false);
      temps.push(...inner.temps);
      return { ...entry, functionCall: inner.expr };
    }
    if (entry?.kind === "index" && entry.index) {
      const inner = walk(entry.index, counter, true);
      temps.push(...inner.temps);
      return { ...entry, index: inner.expr };
    }
    if (entry?.kind === "slice") {
      let e = entry;
      for (const key of ["start", "end"]) {
        if (e[key]) {
          const inner = walk(e[key], counter, true);
          temps.push(...inner.temps);
          if (inner.expr !== e[key]) e = { ...e, [key]: inner.expr };
        }
      }
      return e;
    }
    return entry;
  });
}

/** Emit `const __hoist_N = <call>` into temps and return the reference
 *  that replaces the call. loc is copied from the hoisted expression so
 *  diagnostics, the source map, and the debugger keep pointing at the
 *  original line (SourceMap.record drops loc-less entries). */
function makeTemp(call: any, temps: AgencyNode[], counter: Counter): any {
  const name = `__hoist_${counter.n++}`;
  temps.push({
    type: "assignment",
    declKind: "const",
    variableName: name,
    value: call,
    loc: call.loc,
  } as unknown as AgencyNode);
  return { type: "variableName", value: name, loc: call.loc };
}
