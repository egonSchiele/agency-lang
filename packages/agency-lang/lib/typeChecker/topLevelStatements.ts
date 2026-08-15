import { describeNodeKind, isLegalAtTopLevel } from "../utils/topLevel.js";
import { diagnostic } from "./diagnostics.js";
import type { StaticStatement } from "../types.js";
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
    const offender = node.type === "staticStatement" ? (node as StaticStatement).statement : node;
    ctx.errors.push(
      diagnostic(
        offender.type === "handleBlock"
          ? "topLevelHandlerNotAllowed"
          : "topLevelStatementNotAllowed",
        { kind: describeNodeKind(offender.type) },
        node.loc ?? null,
      ),
    );
  }
}
