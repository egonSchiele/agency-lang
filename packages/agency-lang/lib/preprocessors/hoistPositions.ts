import type { AgencyNode } from "../types.js";
import { bodySlots, type BodySlot } from "../utils/bodySlots.js";
import { expressionSlots } from "../utils/expressionSlots.js";
import { EXTRACTING_STATEMENT_KINDS } from "./hoistCalls.js";

/** - "liftable": the pass lifts a call or checked cast out of here.
 *  - "stuck": inside a body the pass rewrites, in a position it leaves
 *    inline. Moving the expression to its own statement makes it liftable.
 *  - "outsideBodies": a module-level initializer or a parameter default.
 *    The pass never enters these, so there is no statement to move to.
 *  - "handlerBody": inside a handler body, which the pass never touches. */
export type HoistStatus = "liftable" | "stuck" | "outsideBodies" | "handlerBody";
export type HoistPosition = { node: AgencyNode; status: HoistStatus };

const SKIPPED_MODES: readonly string[] = ["opaque", "conditional"];
const ENTERED_TOP_LEVEL_KINDS: readonly string[] = ["function", "graphNode"];

/**
 * Every node under `nodes` with where it stands for the hoist pass.
 * hoistPositions.test.ts checks this against the pass itself.
 *
 * Which AST this reads. The type checker calls this with guards already
 * desugared and with `parallel` and `seq` blocks still present. The pass runs
 * later, after a parallel block has become a fork call and a seq block has
 * been inlined. Ruling: statements inside a parallel or seq block are treated
 * as ordinary body statements, which is what they become. The agreement test
 * runs the production desugars before the pass, so this ruling is checked.
 *
 * What "liftable" means. The pass MAY lift from this position. The last value
 * of an assignment, return, or match yield is liftable and still not lifted,
 * because it is already the statement's own step (the tail rule in
 * hoistCalls.ts). That is safe, and it is not drift.
 *
 * What is never examined. `hole` and `codeLiteral` are leaves in
 * expressionSlots, so a cast inside quoted code is not listed here. It is
 * checked when the completed program compiles.
 */
export function hoistPositions(nodes: AgencyNode[]): HoistPosition[] {
  return nodes.flatMap((node) => {
    const entered = ENTERED_TOP_LEVEL_KINDS.includes(node.type);
    return [
      { node, status: "outsideBodies" as const },
      ...ownExpressions(node, "outsideBodies"),
      ...parameterDefaults(node),
      ...bodies(node, entered ? "liftable" : "outsideBodies"),
    ];
  });
}

/** A default value runs when the function is called, outside any statement
 *  the pass rewrites, so nothing in it is lifted. Defaults are literals, but
 *  an array or object literal can hold any expression. */
function parameterDefaults(node: AgencyNode): HoistPosition[] {
  if (node.type !== "function" && node.type !== "graphNode") {
    return [];
  }
  return node.parameters
    .map((parameter) => parameter.defaultValue)
    .filter((defaultValue) => defaultValue !== undefined)
    .flatMap((defaultValue) =>
      expressionPositions(defaultValue as unknown as AgencyNode, "outsideBodies"),
    );
}

/** A node in statement position. Its own expressions are liftable only when
 *  the pass extracts from this kind of statement. */
function statementPositions(statement: AgencyNode, status: HoistStatus): HoistPosition[] {
  const extracts = EXTRACTING_STATEMENT_KINDS.includes(statement.type);
  const ownStatus = status === "liftable" && !extracts ? "stuck" : status;
  return [
    { node: statement, status },
    ...ownExpressions(statement, ownStatus),
    ...bodies(statement, status),
  ];
}

/** A node in expression position. */
function expressionPositions(expression: AgencyNode, status: HoistStatus): HoistPosition[] {
  return [
    { node: expression, status },
    ...ownExpressions(expression, status),
    ...bodies(expression, status),
  ];
}

function ownExpressions(node: AgencyNode, status: HoistStatus): HoistPosition[] {
  // `with` and `static` expose their one statement both as an opaque
  // expression slot and as a body slot. It is visited once, as a body.
  const bodyStatements = bodySlots(node).flatMap((slot) => slot.body);
  return expressionSlots(node)
    .filter((slot) => !bodyStatements.includes(slot.expr))
    .flatMap((slot) => {
      const skipped = SKIPPED_MODES.includes(slot.mode);
      const slotStatus = status === "liftable" && skipped ? "stuck" : status;
      return expressionPositions(slot.expr, slotStatus);
    });
}

function bodies(node: AgencyNode, status: HoistStatus): HoistPosition[] {
  return bodySlots(node).flatMap((slot) =>
    slot.body.flatMap((statement) => statementPositions(statement, bodyStatus(node, slot, status))),
  );
}

function bodyStatus(owner: AgencyNode, slot: BodySlot, status: HoistStatus): HoistStatus {
  // The pass's own condition, copied exactly (recurseSlots in hoistCalls.ts).
  // `retargetsReturn` alone is also set on every block argument.
  if (owner.type === "handleBlock" && slot.retargetsReturn) {
    return "handlerBody";
  }
  // `with` and `static`: fully opaque, including the statement they wrap.
  if (slot.single && status === "liftable") {
    return "stuck";
  }
  return status;
}
