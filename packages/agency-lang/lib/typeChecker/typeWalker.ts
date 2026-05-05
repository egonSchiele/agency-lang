import type { VariableType } from "../types.js";

/**
 * Pre-order walk of every nested VariableType. The visitor is invoked once
 * per node, root first. Returning `true` from the visitor halts the walk
 * and propagates `true` back to the caller (used for short-circuiting
 * "does any nested type satisfy P?" predicates).
 */
export function visitTypes(
  t: VariableType,
  visit: (t: VariableType) => boolean | void,
): boolean {
  if (visit(t) === true) return true;
  switch (t.type) {
    case "arrayType":
      return visitTypes(t.elementType, visit);
    case "unionType":
      for (const m of t.types) if (visitTypes(m, visit)) return true;
      return false;
    case "objectType":
      for (const p of t.properties) if (visitTypes(p.value, visit)) return true;
      return false;
    case "resultType":
      return (
        visitTypes(t.successType, visit) || visitTypes(t.failureType, visit)
      );
    case "blockType":
      for (const p of t.params)
        if (visitTypes(p.typeAnnotation, visit)) return true;
      return visitTypes(t.returnType, visit);
    default:
      return false;
  }
}
