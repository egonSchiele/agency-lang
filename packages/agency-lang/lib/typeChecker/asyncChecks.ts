import type { AgencyNode, Expression } from "../types.js";
import type { ValueAccess } from "../types/access.js";
import { hasUnwrap, isUnwrapElement } from "../types/access.js";
import { hoistPositions, type HoistStatus } from "../preprocessors/hoistPositions.js";
import { asyncArm, asAsyncStatement } from "../preprocessors/asyncDesugar.js";
import { isLiftedCallbackName } from "../runtime/blockNames.js";
import { bodySlots } from "../utils/bodySlots.js";
import { expressionToString, walkNodes } from "../utils/node.js";
import { diagnostic } from "./diagnostics.js";
import type { TypeCheckError } from "./types.js";

/** A node carrying the `async` flag, whatever its shape. */
type Flagged = AgencyNode & { async?: boolean };

const isFlagged = (node: AgencyNode): node is Flagged =>
  (node.type === "functionCall" || node.type === "valueAccess" || node.type === "variableName") &&
  (node as Flagged).async === true;

/** The two `hoistPositions` statuses a statement-position `async` call is
 *  refused in. */
const POSITION_REFUSALS: Partial<Record<HoistStatus, "asyncOutsideBody" | "asyncInHandlerBody">> = {
  outsideBodies: "asyncOutsideBody",
  handlerBody: "asyncInHandlerBody",
};

/** One `async` statement in a statement list, with where it sits. */
type Placed = {
  call: AgencyNode;
  list: AgencyNode[];
  index: number;
  /** The node whose body the list is; undefined for the program itself. */
  owner: AgencyNode | undefined;
  /** The top-level def or node the statement is inside, if any. */
  topLevel: AgencyNode | undefined;
};

/**
 * Where `async f()` cannot go. Each refusal marks a position the lowering
 * (asyncDesugar.ts) cannot take, so, like `unwrapRefusals`, these need only
 * the tree, and the compile path calls this even when the type checker is
 * off. The lowering reports none of them; it trusts that they were checked.
 *
 * - AG1026: `async` inside an expression. It must start a statement or the
 *   right-hand side of a `let` or `const`.
 * - AG1027, AG1028: at global initialization or in a parameter default,
 *   and in a handler body. Read from `hoistPositions`, which already sorts
 *   every node into those two places.
 * - AG1029: in a callback body, which is lifted into a `__cb_*` function
 *   before this runs.
 * - AG1030: as a direct arm of a `parallel` block.
 * - AG1031: `?` on the async call itself.
 * - AG1032: `async` on something that is not a call.
 * - AG1033: a `goto`, `break`, or `continue` nested inside the statements
 *   that run beside the call. A top-level one ends the arm instead, so only
 *   a nested one is refused, and a `break` or `continue` inside a loop that
 *   is itself inside the arm is fine.
 */
export function asyncRefusals(programNodes: AgencyNode[]): TypeCheckError[] {
  const placed = placedAsyncStatements(programNodes);
  const statementCalls = placed.map((entry) => entry.call);
  const errors: TypeCheckError[] = [];

  for (const { node } of walkNodes(programNodes)) {
    if (!isFlagged(node)) {
      continue;
    }
    const params = { expr: callText(node) };
    if (node.type === "valueAccess" && hasUnwrap(node)) {
      errors.push(diagnostic("asyncUnwrap", params, node.loc ?? null));
    } else if (!isCall(node)) {
      errors.push(diagnostic("asyncNonCall", params, node.loc ?? null));
    } else if (!statementCalls.includes(node)) {
      errors.push(diagnostic("asyncInExpression", params, node.loc ?? null));
    }
  }

  const callable = placed.filter((entry) => isCall(entry.call) && !hasUnwrapAccess(entry.call));
  const callableNodes = callable.map((entry) => entry.call);
  // `hoistPositions` already sorts every node into module-level code and
  // handler bodies. Its third refused status, "stuck", means "an expression
  // the hoist pass leaves inline", which says nothing about a call that is
  // already a statement (a `with` statement's inner call is stuck, and
  // fine), so only the two statuses below are read.
  for (const position of hoistPositions(programNodes)) {
    if (!callableNodes.includes(position.node)) {
      continue;
    }
    const name = POSITION_REFUSALS[position.status];
    if (name === undefined) {
      continue;
    }
    errors.push(
      diagnostic(name, { expr: callText(position.node as Flagged) }, position.node.loc ?? null),
    );
  }

  const reported: AgencyNode[] = [];
  for (const entry of callable) {
    const params = { expr: callText(entry.call) };
    const loc = entry.call.loc ?? null;
    if (entry.owner?.type === "parallelBlock") {
      errors.push(diagnostic("asyncAsParallelArm", params, loc));
      continue;
    }
    if (entry.topLevel?.type === "function" && isCallbackBody(entry.topLevel)) {
      errors.push(diagnostic("asyncInCallback", params, loc));
      continue;
    }
    for (const exit of nestedExits(asyncArm(entry.list, entry.index))) {
      if (reported.includes(exit)) {
        continue;
      }
      reported.push(exit);
      errors.push(
        diagnostic(
          "asyncBranchExit",
          { ...params, keyword: exitKeyword(exit) },
          exit.loc ?? entry.call.loc ?? null,
        ),
      );
    }
  }
  return errors;
}

/** Every `async` statement in every statement list of the program. */
function placedAsyncStatements(programNodes: AgencyNode[]): Placed[] {
  const placed: Placed[] = [];
  const visitList = (
    list: AgencyNode[],
    owner: AgencyNode | undefined,
    topLevel: AgencyNode | undefined,
  ) => {
    list.forEach((stmt, index) => {
      const asyncStatement = asAsyncStatement(stmt);
      if (asyncStatement) {
        placed.push({ call: asyncStatement.call, list, index, owner, topLevel });
      }
    });
  };
  visitList(programNodes, undefined, undefined);
  for (const top of programNodes) {
    for (const { node } of walkNodes([top])) {
      for (const slot of bodySlots(node)) visitList(slot.body, node, top);
    }
  }
  return placed;
}

function isCall(node: AgencyNode): boolean {
  if (node.type === "functionCall") {
    return true;
  }
  if (node.type !== "valueAccess") {
    return false;
  }
  const elements = node.chain.filter((element) => !isUnwrapElement(element));
  if (elements.length === 0) {
    return node.base.type === "functionCall";
  }
  const last = elements[elements.length - 1];
  return last.kind === "methodCall" || last.kind === "call";
}

function hasUnwrapAccess(node: AgencyNode): boolean {
  return node.type === "valueAccess" && hasUnwrap(node as ValueAccess);
}

function isCallbackBody(def: AgencyNode & { type: "function" }): boolean {
  return typeof def.functionName === "string" && isLiftedCallbackName(def.functionName);
}

/** The `goto`, `break`, and `continue` statements inside `arm` that the
 *  arm cannot run: every `goto`, and each `break` or `continue` that is not
 *  inside a loop that is itself inside the arm. */
function nestedExits(arm: AgencyNode[]): AgencyNode[] {
  return [...walkNodes(arm)]
    .filter(({ node, ancestors }) => {
      if (node.type === "gotoStatement") {
        return true;
      }
      if (node.type !== "keyword" || (node.value !== "break" && node.value !== "continue")) {
        return false;
      }
      return !ancestors.some((a) => a.type === "forLoop" || a.type === "whileLoop");
    })
    .map(({ node }) => node);
}

function exitKeyword(node: AgencyNode): string {
  return node.type === "keyword" ? node.value : "goto";
}

/** The call as the user wrote it, without the keyword and without any
 *  `?` (messages add the `?` back where they mean it). */
function callText(node: Flagged): string {
  const { async: _flag, ...call } = node;
  if (call.type !== "valueAccess") {
    return expressionToString(call as Expression);
  }
  const access = call as ValueAccess;
  const firstUnwrap = access.chain.findIndex(isUnwrapElement);
  if (firstUnwrap === -1) {
    return expressionToString(access);
  }
  if (firstUnwrap === 0) {
    return expressionToString(access.base as Expression);
  }
  return expressionToString({ ...access, chain: access.chain.slice(0, firstUnwrap) });
}
