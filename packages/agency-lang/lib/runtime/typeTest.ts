export type CoarseKind = "string" | "number" | "boolean" | "null" | "object" | "array";

/** Tier 1 type-pattern check (`x is string`, `is object`, `is any[]`).
 *  A function rather than inlined codegen so the tested value is evaluated
 *  exactly once even for the multi-reference object case. */
export function __coarseTypeTest(value: unknown, kind: CoarseKind): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      // Loose on purpose: the literal null pattern lowers to `== null`, and
      // the runtime already normalizes undefined to null elsewhere (__nn).
      return value === null || value === undefined;
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
  }
}
