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
 * Structure comes from `expressionSlots` (lib/utils/expressionSlots.ts)
 * — positions and eval modes are data there, completeness-checked
 * against EXPRESSION_NODE_TYPES; an unregistered kind THROWS here
 * rather than falling into a silent generic walk.
 * Statement-body recursion is driven by `bodySlots` (the single source
 * of truth for which fields hold statements); only the expression
 * interior uses a generic child walk. Rulings are data, not control
 * flow. Everything copies;
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
import {
  expressionSlots,
  isRegisteredExpressionKind,
  type ExpressionSlot,
} from "../utils/expressionSlots.js";

type Counter = { n: number };

type Extraction = { temps: AgencyNode[]; expr: any };

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

/** Statement kinds whose LAST slot is the statement value position:
 *  its outermost call (or call-bearing chain) is the statement tail and
 *  stays in place — hoisting the tail is pointless (it is the pending
 *  call itself) and node calls even throw in value position. */
const TAIL_VALUE_KINDS = ["assignment", "returnStatement", "matchYield"];

/** The statement kinds extraction applies to — the pre-slots dispatch
 *  set, kept exactly for behavior identity. functionCall /
 *  interruptStatement / whileLoop / withModifier / staticStatement /
 *  valueAccess have their own cases above the default. */
const EXTRACTED_STATEMENT_KINDS = [
  "assignment",
  "returnStatement",
  "matchYield",
  "gotoStatement",
  "ifElse",
  "forLoop",
  "matchBlock",
  "messageThread",
];

// eslint-disable-next-line max-lines-per-function -- ordered policy cases over the slot iteration; splitting would scatter the dispatch
function rewriteStatement(stmt: any, counter: Counter): AgencyNode[] {
  switch (stmt.type) {
    case "functionCall":
    case "interruptStatement": {
      // A bare call statement: the call itself is the tail; its
      // argument slots (and block body, via the bodySlots recursion
      // inside walk) still hoist.
      const walked = walk(stmt, counter, false);
      return [...walked.temps, walked.expr];
    }
    case "whileLoop": {
      // The one perIteration position with a restructure strategy —
      // keyed on the STATEMENT KIND, not the mode: the mode only says
      // "cannot hoist before the owner". Why this position matters
      // most: Runner.whileLoop awaits the condition BEFORE the
      // completed-iteration skip, so pre-pass a condition call re-ran
      // once per completed iteration on resume.
      const [conditionSlot] = expressionSlots(stmt);
      const cond = walk(conditionSlot.expr, counter, true);
      if (cond.temps.length === 0) {
        return [recurseSlots(stmt, counter)];
      }
      // while (COND) { BODY } becomes
      //   while (true) { <temps>; if (COND') { BODY' } else { break } }
      // No synthesized negation on purpose: the parser cannot produce
      // `!(<comparison>)`, and a hand-rolled unary emission prints
      // `(!h) < 5` silently. `continue` still lands on the re-check.
      const loc = conditionSlot.expr.loc ?? stmt.loc;
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
    case "valueAccess":
      // A bare method-call statement (`result.push(transform(item))`).
      // The pre-slots pass never extracted from these — a recorded
      // coverage hole kept for behavior identity, tripwire-covered like
      // the other residuals. Extraction here would also need a
      // dedicated tail rule for the chain itself; revisit deliberately,
      // with fixtures, not as a refactor side effect.
      return [recurseSlots(stmt, counter)];
    case "withModifier":
    case "staticStatement":
      // Fully opaque, including the statement body bodySlots exposes:
      // rewriting inside a `with` region would move work across the
      // modifier boundary, and `static` belongs to init-topsort. Their
      // single-statement slot could not hold temps anyway.
      return [stmt];
    default: {
      // Slot iteration for the statement kinds the pass extracts from;
      // bare EXPRESSION statements (a naked binOp like the parsed form
      // of `print(...) + greet`, a naked string) are recursed for
      // bodies but never extracted — the pre-slots pass did not touch
      // them, and behavior identity is the contract of this refactor.
      // A recorded hole, tripwire-covered like the others.
      if (!EXTRACTED_STATEMENT_KINDS.includes(stmt.type)) {
        return [recurseSlots(stmt, counter)];
      }
      // Hoist from every unconditionally-evaluated position, in
      // evaluation order, then recurse statement bodies via bodySlots.
      const slots = expressionSlots(stmt);
      const temps: AgencyNode[] = [];
      let out: any = stmt;
      slots.forEach((slot: ExpressionSlot, i: number) => {
        if (slot.mode === "conditional" || slot.mode === "opaque") return;
        if (slot.mode === "perIteration") {
          // whileLoop is handled above; any other carrier appearing
          // here means a construct this pass has no restructure
          // strategy for — fail by name rather than mis-apply the
          // while rewrite. (Comprehension slots never reach the pass:
          // parse-time desugar. This throw is dead by construction
          // today and stays honest if that ever changes.)
          throw new Error(
            `hoistCalls: no restructure strategy for a perIteration ` +
              `slot on "${stmt.type}" — see expressionSlots.ts`,
          );
        }
        const isTail =
          TAIL_VALUE_KINDS.includes(stmt.type) &&
          i === slots.length - 1 &&
          (slot.expr as any).type !== undefined &&
          ["functionCall", "valueAccess"].includes((slot.expr as any).type);
        const walked = walk(slot.expr, counter, !isTail);
        temps.push(...walked.temps);
        out = slot.write(out, walked.expr);
      });
      return [...temps, recurseSlots(out, counter)];
    }
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

/** The expression walker. Returns fresh nodes; never mutates.
 *  `hoistSelf` is true everywhere except the single statement-tail
 *  node, which the statement dispatcher withholds. Structure comes from
 *  expressionSlots; the policy that stays HERE: which nodes become
 *  temps (calls, and access chains that still contain a method call),
 *  and the chain unit-hoist decision. */
function walk(node: any, counter: Counter, hoistSelf: boolean): Extraction {
  if (!node || typeof node !== "object") return { temps: [], expr: node };

  if (node.type === "functionCall" || node.type === "interruptStatement") {
    const temps: AgencyNode[] = [];
    let call: any = node;
    for (const slot of expressionSlots(node)) {
      const inner = walk(slot.expr, counter, true);
      temps.push(...inner.temps);
      call = slot.write(call, inner.expr);
    }
    if (node.block) {
      // The block body is a new frame-owning scope; its temps stay
      // inside it.
      call = {
        ...call,
        block: { ...node.block, body: hoistCallsInScope(node.block.body) },
      };
    }
    if (!hoistSelf || node.type === "interruptStatement") {
      // An interrupt expression is never hoisted as a unit (matching
      // the pre-slots behavior, where only plain calls self-hoisted).
      return { temps, expr: call };
    }
    return { temps, expr: makeTemp(call, temps, counter) };
  }

  if (node.type === "valueAccess") {
    // The base and every argument/index/bound hoist; chain METHOD
    // calls stay attached (their slot expr is the whole functionCall,
    // walked args-only), and a chain that still contains one hoists as
    // a UNIT — splitting a chain mid-way would mean rebuilding it
    // across statements. A pause inside a later segment re-running an
    // earlier method call is the documented residual (tripwire).
    const methodCalls = (node.chain ?? [])
      .filter((en: any) => en?.kind === "methodCall" && en.functionCall)
      .map((en: any) => en.functionCall);
    const temps: AgencyNode[] = [];
    let out: any = node;
    for (const slot of expressionSlots(node)) {
      const isMethodCall = methodCalls.includes(slot.expr);
      const inner = walk(slot.expr, counter, !isMethodCall);
      temps.push(...inner.temps);
      out = slot.write(out, inner.expr);
    }
    if (!hoistSelf || methodCalls.length === 0) return { temps, expr: out };
    return { temps, expr: makeTemp(out, temps, counter) };
  }

  // Statement-bearing constructs in EXPRESSION position (a thread block
  // as an assignment value is the live case). Their bodies recurse as
  // statement lists per the seam rule in expressionSlots.ts /
  // bodySlots.ts — walking them as expressions would hoist inner calls
  // OUT of the construct. After functionCall (which owns its
  // block-argument slot above).
  if (bodySlots(node).length > 0) {
    return { temps: [], expr: recurseSlots(node, counter) };
  }

  // An unregistered kind must fail by name, not fall into a silent
  // generic walk — that walk is how three drift holes stayed hidden in
  // one week. The completeness test guarantees this never fires for
  // known kinds; in production it can only fire for a genuinely new,
  // unregistered node kind, which is exactly when loud is right.
  if (!isRegisteredExpressionKind(node.type)) {
    throw new Error(
      `hoistCalls: unregistered expression kind "${node.type}" — ` +
        `register it in expressionSlots.ts`,
    );
  }

  // Everything else: slot iteration. Hoist from unconditionally-
  // evaluated positions; conditional and opaque positions are skipped
  // (the first inline call in a conditional position is resume-aligned
  // by construction; only calls nested under it remain residual).
  const temps: AgencyNode[] = [];
  let expr: any = node;
  for (const slot of expressionSlots(node)) {
    if (slot.mode !== "once") continue;
    const inner = walk(slot.expr, counter, true);
    temps.push(...inner.temps);
    if (inner.expr !== slot.expr) expr = slot.write(expr, inner.expr);
  }
  return { temps, expr };
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
