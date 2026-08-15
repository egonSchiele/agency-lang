/**
 * Reading one function body: what it raises directly, and what it calls.
 *
 * Split from the propagation pass so the "what does this body do" question has
 * one home. The type checker and the cross-file effect pass both ask it, and
 * two separate answers is how effects came to mean different things on either
 * side of an import (GitHub issue 680).
 *
 * Leaf module: it may import the walker and type declarations, nothing else.
 */
import { walkNodes, type WalkAncestor } from "../utils/node.js";
import type { AgencyNode, Expression } from "../types.js";
import type { FunctionCall } from "../types/function.js";
import type { ValueAccess } from "../types/access.js";
import type { InterruptStatement } from "../types/interruptStatement.js";
import type { GotoStatement } from "../types/gotoStatement.js";
import type { SplatExpression, NamedArgument } from "../types/dataStructures.js";

export type BodyFacts = {
  /** Effect labels raised by a literal `interrupt` in this body. */
  effects: string[];
  /** Local names of everything this body calls, unresolved. */
  callees: string[];
  /** Every call node seen. Handed back so the type checker can read call
   *  arguments without walking the body a second time. */
  calls: FunctionCall[];
};

/** One yielded step of the walk. walkNodes also hands back `scopes`, which
 *  nothing here needs. */
type Visit = { node: AgencyNode; ancestors: WalkAncestor[] };

const isInterrupt = (visit: Visit): visit is Visit & { node: InterruptStatement } =>
  visit.node.type === "interruptStatement";

const isCall = (visit: Visit): visit is Visit & { node: FunctionCall } =>
  visit.node.type === "functionCall";

const isGoto = (visit: Visit): visit is Visit & { node: GotoStatement } =>
  visit.node.type === "gotoStatement";

/** A guard becomes a `_guard` call in the TypeChecker constructor. The symbol
 *  table walks the tree before that, so the call is not there yet. */
const isGuard = (visit: Visit): boolean => visit.node.type === "guardBlock";

export function collectBodyFacts(body: AgencyNode[]): BodyFacts {
  const visits: Visit[] = [...walkNodes(body)];
  const calls = visits.filter(isCall);
  return {
    effects: unique(visits.filter(isInterrupt).map((visit) => visit.node.effect)),
    callees: unique([
      ...visits.filter(isGuard).map(() => "_guard"),
      ...calls
        .map((visit) => calledName(visit.node, visit.ancestors))
        .filter((name): name is string => name !== null),
      ...visits.filter(isGoto).map((visit) => visit.node.nodeCall.functionName),
    ]),
    calls: calls.map((visit) => visit.node),
  };
}

/**
 * The name a call site names, or null when it names nothing this analysis can
 * use.
 *
 * A plain `g(...)` names `g`. A method call inside an access chain names
 * nothing global: `xs.map(...)` and `f.partial(method: "GET")` call methods on
 * a value, so recording `map` or `partial` would collide with any function of
 * that name and attribute its effects to an unrelated call. The type checker
 * excludes these for the same reason (functionTypeRaises.ts:106).
 *
 * Working out what a method call reaches needs the receiver's type, which this
 * walk does not have. That makes it one of the blind spots the splice
 * eligibility check refuses on.
 */
export function calledName(node: FunctionCall, ancestors: WalkAncestor[]): string | null {
  return isChainLink(node, ancestors) ? null : node.functionName;
}

/**
 * Whether this call is a link in an access chain rather than a standalone call.
 *
 * Scans the ancestors backwards rather than trusting the last one, because
 * walkNodes descends an assignment's own access chain passing the assignment as
 * the ancestor, so the access is not always adjacent. Identity of the call node
 * is what distinguishes the link we are standing on from its neighbours.
 */
function isChainLink(node: FunctionCall, ancestors: WalkAncestor[]): boolean {
  return [...ancestors]
    .reverse()
    .filter((ancestor): ancestor is ValueAccess => ancestor.type === "valueAccess")
    .some((access) =>
      access.chain.some((link) => link.kind === "methodCall" && link.functionCall === node),
    );
}

/**
 * The expression inside a call argument, whatever shape the argument takes.
 *
 * `f(x)`, `f(name: x)` and `f(...xs)` all carry an expression, and anything
 * inspecting arguments has to unwrap all three or it silently skips the two
 * that are most likely to carry a callback.
 */
export function argumentExpression(arg: Expression | SplatExpression | NamedArgument): Expression {
  if (arg.type === "splat") return arg.value;
  if (arg.type === "namedArgument") return arg.value;
  return arg;
}

/** Deduplicate, preserving first-seen order. The declarative counterpart to
 *  addUnique, for code that builds a list rather than growing one. */
export function unique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

/** Grow a list in place. For code that accumulates rather than builds. */
export function addUnique(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}
