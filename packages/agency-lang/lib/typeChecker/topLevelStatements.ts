import { isLegalAtTopLevel } from "../utils/topLevel.js";
import { diagnostic } from "./diagnostics.js";
import type { AgencyNode, StaticStatement } from "../types.js";
import type { TypeCheckerContext } from "./types.js";

/**
 * AG3017 / AG3018 — the top-level rule, reported where the user can see it.
 *
 * Top level only: this walks `ctx.programNodes` directly rather than
 * recursing, because a node's own body is a different context entirely.
 */
export function checkTopLevelStatements(ctx: TypeCheckerContext): void {
  for (const node of ctx.programNodes) {
    if (isLegalAtTopLevel(node)) continue;
    // `static interrupt(...)` should say "interrupt", not "staticStatement":
    // the predicate defers to the inner node, so the message must too.
    const offender =
      node.type === "staticStatement" ? (node as StaticStatement).statement : node;
    ctx.errors.push(
      diagnostic(
        offender.type === "handleBlock"
          ? "topLevelHandlerNotAllowed"
          : "topLevelStatementNotAllowed",
        { kind: describeKind(offender.type) },
        node.loc ?? null,
      ),
    );
  }
}

/** `ifElse` reads as "if statement" to a user, not as a node type. Unmapped
 *  types fall back to their own name, so this fails ugly rather than wrong.
 *  Each entry carries its own article so the message reads as English. */
function describeKind(type: AgencyNode["type"]): string {
  // Null-prototype: keyed by node type strings (house pattern).
  const names: Record<string, string> = Object.assign(Object.create(null), {
    ifElse: "An `if` statement",
    whileLoop: "A `while` loop",
    forLoop: "A `for` loop",
    matchBlock: "A `match` block",
    messageThread: "A `thread` block",
    guardBlock: "A `guard` block",
    finalizeBlock: "A `finalize` block",
    returnStatement: "A `return`",
    gotoStatement: "A `goto`",
    interruptStatement: "An interrupt",
    debuggerStatement: "A `debugger(...)` statement",
  });
  return Object.hasOwn(names, type) ? names[type] : `A \`${type}\``;
}
