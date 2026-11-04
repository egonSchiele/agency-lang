/**
 * The `async` lowering: `async f()` runs `f` beside the statements that
 * follow it, by rewriting the block into an ordinary `parallel` block.
 *
 *   let name = async nameConversation(msg)
 *   const reply = llm(msg)
 *   print(reply)
 *   print(name)
 *
 * becomes
 *
 *   const __async_arg_0 = msg
 *   parallel(shared: true) {            // origin: "async"
 *     let name = nameConversation(__async_arg_0)
 *     seq {
 *       const reply = llm(msg)
 *       print(reply)
 *     }
 *   }
 *   print(name)
 *
 * which `parallelDesugar` then turns into a `fork`. Because the block is
 * marked `origin: "async"`, that pass also gives the `seq` arm the parent's
 * conversation thread, marks the arm's normal completion, and writes the
 * join check that returns an early `return` from the enclosing function.
 *
 * Where the join is:
 *   - `let x = async f()`: just before the first later statement that
 *     mentions `x`, or the end of the block.
 *   - `async f()`: the end of the block.
 *   - Either way, never after a top-level `goto`, `break`, or `continue`,
 *     which cannot run inside a fork arm. The join moves to just before the
 *     first one.
 *
 * Calls lower from the first in a block to the last, each arm lowered
 * after it is formed, so a second `async` inside the first one's arm runs
 * beside the rest of that arm. Lowering last to first would put the first
 * call's first use inside the second call's block and leave it nothing to
 * overlap with.
 *
 * The positions the lowering cannot take (an `async` in an expression, at
 * global initialization, in a handler function or callback body, as a
 * direct arm of `parallel`, with `?` on the call, of a non-call, or with a
 * `goto`, `break`, or `continue` nested in its arm) are refused by
 * `asyncRefusals` before this pass runs. This pass trusts that.
 *
 * Every walk here goes through the slot tables (`bodySlots` through
 * `mapBodies`, `expressionSlots`, and `walkNodes`), so a node kind added
 * later is covered without a case here. See docs/dev/runtime/async.md.
 */
import type { AgencyNode, AgencyProgram, Assignment, Expression, FunctionCall } from "@/types.js";
import type { ValueAccess } from "@/types/access.js";
import type { ParallelBlock } from "@/types/parallelBlock.js";
import type { WithModifier } from "@/types/withModifier.js";
import { mapBodies } from "@/utils/mapBodies.js";
import { expressionSlots } from "@/utils/expressionSlots.js";
import { walkNodes } from "@/utils/node.js";
import { isAsyncFlagged } from "@/types/asyncCall.js";
import { namesMentioned } from "./parallelDesugar.js";

/** The call an `async` statement starts. */
type AsyncCall = FunctionCall | ValueAccess;

/** One `async` statement, taken apart. */
type AsyncStatement = {
  /** The name bound by `let x = async f()`; absent for the statement form. */
  name?: string;
  call: AsyncCall;
  /** The statement again, around a new call with the flag cleared. */
  rebuild: (call: AsyncCall) => AgencyNode;
};

type LowerContext = {
  /** The names whose calls go through a variable: every name a frame of
   *  the enclosing function or node can hold (its parameters, loop binders,
   *  and `let`/`const` declarations) and every module-level `let`/`const`,
   *  minus the names of known functions. A call to a known function's name
   *  resolves to the function even when a variable of the same name is
   *  declared elsewhere, so copying that name into a temporary would copy
   *  the wrong thing. */
  variableCallees: string[];
  counter: { n: number };
};

/** Lower every `async` statement in the program's function and node
 *  bodies. Mutates each definition's `body` in place, like the other
 *  preprocessor passes, so the definition tables keep pointing at them. */
export function desugarAsyncInProgram(program: AgencyProgram, functionNames: string[]): void {
  const globalNames = program.nodes
    .filter((node) => node.type === "assignment" && node.declKind !== undefined)
    .map((node) => (node as Assignment).variableName);
  for (const node of program.nodes) {
    if (node.type !== "function" && node.type !== "graphNode") {
      continue;
    }
    const variableCallees = [...frameNames(node), ...globalNames].filter(
      (name) => !functionNames.includes(name),
    );
    const ctx: LowerContext = { variableCallees, counter: { n: 0 } };
    node.body = lowerList(node.body, ctx);
  }
}

/** Lower one statement list: find its first `async` statement, split the
 *  list there, and lower each piece. */
function lowerList(list: AgencyNode[], ctx: LowerContext): AgencyNode[] {
  const index = list.findIndex((stmt) => asAsyncStatement(stmt) !== null);
  if (index === -1) {
    return list.map((stmt) => lowerNested(stmt, ctx));
  }

  const before = list.slice(0, index).map((stmt) => lowerNested(stmt, ctx));
  const asyncStmt = asAsyncStatement(list[index])!;
  const arm = asyncArm(list, index);
  const after = lowerList(list.slice(index + 1 + arm.length), ctx);

  // The block is formed even when the arm is empty. The side call's model
  // messages stay off the conversation thread (its arm runs on a
  // subthread), and that must not depend on whether a statement happens
  // to follow the `async` line.
  const snapshot = snapshotCall(lowerNestedCall(clearFlag(asyncStmt.call), ctx), ctx);
  const sideStatement = asyncStmt.rebuild(snapshot.call);
  // A `with` statement is not an allowed arm shape; a `seq` around it is.
  const sideArm: AgencyNode =
    sideStatement.type === "withModifier"
      ? ({ type: "seqBlock", body: [sideStatement] } as AgencyNode)
      : sideStatement;
  const block: ParallelBlock = {
    type: "parallelBlock",
    origin: "async",
    // Globals stay shared, as they are between a plain call and the code
    // after it.
    shared: { type: "boolean", value: true },
    body: [sideArm, { type: "seqBlock", body: lowerList(arm, ctx) } as AgencyNode],
    loc: list[index].loc,
  };
  return [...before, ...snapshot.temps, block, ...after];
}

/** Lower every `async` statement nested inside `stmt`: in its statement
 *  bodies, and in bodies reached through its expressions (a block argument
 *  passed to a call, say). A `parallel` block's body is a list of arms, not
 *  a statement sequence, so only the bodies of its `seq` arms are lowered
 *  as lists. */
function lowerNested(stmt: AgencyNode, ctx: LowerContext): AgencyNode {
  let out: AgencyNode;
  if (stmt.type === "parallelBlock") {
    out = {
      ...stmt,
      body: stmt.body.map((arm) =>
        arm.type === "seqBlock"
          ? { ...arm, body: lowerList(arm.body, ctx) }
          : lowerNested(arm, ctx),
      ),
    };
  } else {
    out = mapBodies(stmt, (body) => lowerList(body, ctx));
  }
  for (const slot of expressionSlots(out)) {
    out = slot.write(out, lowerNested(slot.expr, ctx));
  }
  return out;
}

function lowerNestedCall(call: AsyncCall, ctx: LowerContext): AsyncCall {
  return lowerNested(call, ctx) as AsyncCall;
}

/** The statements that run beside the `async` statement at `list[index]`:
 *  everything after it up to its join. The type checker's refusals read the
 *  arm through this too, so the two never disagree about where it ends. */
export function asyncArm(list: AgencyNode[], index: number): AgencyNode[] {
  const asyncStmt = asAsyncStatement(list[index]);
  const rest = list.slice(index + 1);
  return rest.slice(0, joinIndex(rest, asyncStmt?.name));
}

/** Recognize the two `async` statement shapes, with or without a `with`
 *  suffix. Returns null for anything else. */
export function asAsyncStatement(stmt: AgencyNode): AsyncStatement | null {
  if (stmt.type === "withModifier") {
    const inner = asAsyncStatement(stmt.statement);
    if (inner === null) {
      return null;
    }
    const wrapper: WithModifier = stmt;
    return {
      ...inner,
      rebuild: (call) => ({ ...wrapper, statement: inner.rebuild(call) }) as AgencyNode,
    };
  }
  if (isAsyncCall(stmt)) {
    return { call: stmt, rebuild: (call) => call };
  }
  if (stmt.type === "assignment" && stmt.declKind !== undefined && isAsyncCall(stmt.value)) {
    const assignment: Assignment = stmt;
    return {
      name: assignment.variableName,
      call: assignment.value as AsyncCall,
      rebuild: (call) => ({ ...assignment, value: call as Expression }),
    };
  }
  return null;
}

function isAsyncCall(node: AgencyNode | undefined): node is AsyncCall {
  return node !== undefined && isAsyncFlagged(node) && node.type !== "variableName";
}

function clearFlag(call: AsyncCall): AsyncCall {
  const { async: _flag, ...rest } = call;
  return rest as AsyncCall;
}

/** Where the arm ends, as an index into the statements after the `async`
 *  statement. */
function joinIndex(rest: AgencyNode[], name: string | undefined): number {
  let join = rest.length;
  if (name !== undefined) {
    const firstUse = rest.findIndex((stmt) => namesMentioned([stmt]).includes(name));
    if (firstUse !== -1) {
      join = firstUse;
    }
  }
  const firstExit = rest.findIndex(isBranchExit);
  if (firstExit !== -1 && firstExit < join) {
    join = firstExit;
  }
  return join;
}

/** A statement that leaves the block in a way a fork arm cannot: a node
 *  transition, or a loop's `break` or `continue`. */
function isBranchExit(stmt: AgencyNode): boolean {
  if (stmt.type === "gotoStatement") {
    return true;
  }
  return stmt.type === "keyword" && (stmt.value === "break" || stmt.value === "continue");
}

/** Hoist what the side call reads into `const` temporaries before the
 *  block, so it reads what a plain call at that line would have read:
 *  each argument that names anything, the receiver of a method call when
 *  it is a variable, and the callee when it is a function value held in a
 *  variable. Otherwise the side arm evaluates them inside its first step,
 *  after several awaits, and a write in the main arm's first statements
 *  could land first. Objects stay aliased, as they do for any call. A
 *  block argument stays where it is.
 *
 *  A call is never hoisted, only what it reads. In `async a().b()`, `a()`
 *  is part of the work that runs beside the block, so it stays in the arm
 *  and its arguments are the ones copied. */
function snapshotCall(
  call: AsyncCall,
  ctx: LowerContext,
): { temps: AgencyNode[]; call: AsyncCall } {
  const temps: AgencyNode[] = [];
  const hoist = (expr: AgencyNode): AgencyNode => {
    if (namesMentioned([expr]).length === 0) {
      return expr;
    }
    const name = `__async_arg_${ctx.counter.n++}`;
    temps.push({
      type: "assignment",
      declKind: "const",
      variableName: name,
      value: expr as Expression,
      loc: expr.loc ?? call.loc,
    } as AgencyNode);
    return { type: "variableName", value: name, loc: expr.loc ?? call.loc } as AgencyNode;
  };
  const snapshotArguments = (fnCall: FunctionCall): FunctionCall => {
    let out: AgencyNode = fnCall;
    for (const slot of expressionSlots(out)) {
      out = slot.write(out, hoist(slot.expr));
    }
    return out as FunctionCall;
  };
  const snapshotFunctionCall = (fnCall: FunctionCall): FunctionCall => {
    let out = fnCall;
    if (ctx.variableCallees.includes(fnCall.functionName)) {
      const callee = hoist({ type: "variableName", value: fnCall.functionName } as AgencyNode);
      out = { ...out, functionName: (callee as { value: string }).value };
    }
    return snapshotArguments(out);
  };

  if (call.type === "functionCall") {
    return { temps, call: snapshotFunctionCall(call) };
  }

  // A method call: the receiver, then the arguments of each call in the
  // chain. The chain's index expressions are hoisted like arguments.
  const base =
    call.base.type === "functionCall" ? snapshotFunctionCall(call.base) : hoist(call.base);
  let out: AgencyNode = { ...call, base };
  for (const slot of expressionSlots(out)) {
    if (slot.expr === (out as ValueAccess).base) {
      continue;
    }
    const replacement =
      slot.expr.type === "functionCall" ? snapshotArguments(slot.expr) : hoist(slot.expr);
    out = slot.write(out, replacement);
  }
  return { temps, call: out as ValueAccess };
}

/** The names the frames of `def` can hold. */
function frameNames(def: AgencyNode & { parameters: { name: string }[] }): string[] {
  const names = def.parameters.map((param) => param.name);
  for (const { node } of walkNodes([def])) {
    if (node.type === "assignment" && node.declKind !== undefined) {
      names.push(node.variableName);
    } else if (node.type === "forLoop") {
      if (typeof node.itemVar === "string") {
        names.push(node.itemVar);
      }
      if (node.indexVar !== undefined) {
        names.push(node.indexVar);
      }
    } else if (node.type === "blockArgument") {
      for (const param of node.params) names.push(param.name);
    }
  }
  return names;
}
