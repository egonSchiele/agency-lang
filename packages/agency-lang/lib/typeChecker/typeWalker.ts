import type { VariableType } from "../types.js";

/**
 * Post-order transform of a VariableType tree. `fn` is invoked on each
 * node AFTER its children have been transformed, so children are already
 * in their new form when `fn` sees the parent. Returns a new tree; the
 * input is not mutated.
 *
 * Sibling of `visitTypes` (observer). Every VariableType variant must be
 * enumerated here — adding a new variant means updating both functions.
 *
 * Useful for type substitution, normalization, and any "rewrite this
 * tree" operation. Encapsulates the recursion so callers express the
 * "what" (a single-node transform) without re-walking every variant.
 */
export function mapTypes(
  t: VariableType,
  fn: (t: VariableType) => VariableType,
): VariableType {
  switch (t.type) {
    case "arrayType":
      return fn({ ...t, elementType: mapTypes(t.elementType, fn) });
    case "unionType":
      return fn({ ...t, types: t.types.map((m) => mapTypes(m, fn)) });
    case "objectType":
      return fn({
        ...t,
        properties: t.properties.map((p) => ({
          ...p,
          value: mapTypes(p.value, fn),
        })),
      });
    case "resultType":
      return fn({
        ...t,
        successType: mapTypes(t.successType, fn),
        failureType: mapTypes(t.failureType, fn),
      });
    case "schemaType":
      return fn({ ...t, inner: mapTypes(t.inner, fn) });
    case "keyofType":
      return fn({ ...t, operand: mapTypes(t.operand, fn) });
    case "indexedAccessType":
      return fn({
        ...t,
        objectType: mapTypes(t.objectType, fn),
        index: mapTypes(t.index, fn),
      });
    case "blockType":
      return fn({
        ...t,
        params: t.params.map((p) => ({
          ...p,
          typeAnnotation: mapTypes(p.typeAnnotation, fn),
        })),
        returnType: mapTypes(t.returnType, fn),
      });
    case "functionRefType":
      return fn({
        ...t,
        params: t.params.map((p) =>
          p.typeHint ? { ...p, typeHint: mapTypes(p.typeHint, fn) } : p,
        ),
        returnType: t.returnType ? mapTypes(t.returnType, fn) : t.returnType,
      });
    case "genericType":
      return fn({ ...t, typeArgs: t.typeArgs.map((a) => mapTypes(a, fn)) });
    default:
      // primitives, literals, typeAliasVariable — no children to recurse into
      return fn(t);
  }
}

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
    case "schemaType":
      return visitTypes(t.inner, visit);
    case "keyofType":
      return visitTypes(t.operand, visit);
    case "indexedAccessType":
      if (visitTypes(t.objectType, visit)) return true;
      return visitTypes(t.index, visit);
    case "blockType":
      for (const p of t.params)
        if (visitTypes(p.typeAnnotation, visit)) return true;
      return visitTypes(t.returnType, visit);
    case "functionRefType":
      for (const p of t.params) {
        if (p.typeHint && visitTypes(p.typeHint, visit)) return true;
      }
      return t.returnType ? visitTypes(t.returnType, visit) : false;
    case "genericType":
      for (const a of t.typeArgs) if (visitTypes(a, visit)) return true;
      return false;
    default:
      return false;
  }
}
