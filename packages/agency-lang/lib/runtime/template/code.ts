import { AgencyNode } from "../../types.js";

/**
 * A first-class piece of Agency code: the existing `AST` shape plus a
 * fragment kind. The kind exists because a bare expression is not a
 * parseable program — `AST` alone cannot represent "one expression", and
 * an `expr` hole must be fillable with `Code`. A missing `kind` (a value
 * built by `parseAST` rather than the template module) means `"program"`.
 */
export type Code = {
  type: "agencyProgram";
  kind?: "program" | "statements" | "expr";
  nodes: AgencyNode[];
  docComment?: unknown;
};

/** The fragment kind, with the parseAST escape hatch normalized. */
export function kindOf(code: Code): "program" | "statements" | "expr" {
  return code.kind ?? "program";
}

/** True for a value produced by loadTemplate, parseExpr, parseStatements,
 *  a previous fill, or parseAST (the escape hatch). */
export function isCode(value: unknown): value is Code {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: string }).type === "agencyProgram" &&
    Array.isArray((value as { nodes?: unknown }).nodes)
  );
}
