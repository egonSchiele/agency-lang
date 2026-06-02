import type { BaseNode } from "./base.js";
import type { AgencyNode } from "../types.js";

/**
 * `static <expression-statement>` at module top level. Marks a bare
 * top-level statement (function call, etc.) as Phase A (init-once-per-
 * process) instead of Phase B (re-run per agent execution).
 *
 * Parsing: only legal at top level. The parser admits any
 * expression-statement on the right-hand side except an assignment —
 * `static const x = 1` is the *declaration* form, parsed by
 * `modifiedAssignmentParser` and represented as an `assignment` with
 * `static: true`; `static let x = 1` is rejected there. By the time
 * the AST sees a `staticStatement`, the inner is guaranteed to be a
 * bare expression statement.
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
