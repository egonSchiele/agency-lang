import type { BaseNode } from "./base.js";
import type { AgencyNode } from "../types.js";

/**
 * `static <expression-statement>` at module top level. Marks a bare
 * top-level statement (function call, etc.) as Phase A (init-once-per-
 * process) instead of Phase B (re-run per agent execution).
 *
 * Parsing: only legal at top level. The parser
 * (`staticStatementParser`) admits exactly three inner shapes:
 *   - `functionCall`        → `static foo()`
 *   - `valueAccess`         → `static logger.flush()` (method-call chain)
 *   - `interruptStatement`  → `static interrupt(...)`
 * Other shapes (arithmetic like `static 1 + 2`, plain identifiers,
 * literals) are intentionally not supported — `static` is a routing
 * marker for side-effecting statements, not arbitrary expressions.
 * `static const x = ...` is the *declaration* form, parsed by
 * `modifiedAssignmentParser` and represented as an `assignment` with
 * `static: true`. `static let x = ...` and `static <name> = ...` are
 * fatally rejected by `staticStatementParser` with actionable error
 * messages.
 *
 * Codegen: the section assembler (`partitionProgram`) unwraps the
 * wrapper and routes the inner statement into `staticInitTagged`
 * instead of the default `globalInitTagged`. After partition the
 * wrapper never appears again in the IR — downstream codegen sees
 * only the inner statement.
 */
export type StaticStatement = BaseNode & {
  type: "staticStatement";
  statement: AgencyNode;
};
