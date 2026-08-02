import type { AgencyNode, FunctionCall, VariableNameLiteral } from "../types.js";
import type { WalkAncestor } from "../utils/node.js";

/**
 * Which AST positions hold a lexical name that has to resolve.
 *
 * Shared by the ordinary undefined-name diagnostics and the template one,
 * so all three make the same call. Not every `variableName` is a lookup
 * and not every `functionCall` is a bare call, and a pass that gets those
 * rules half right reports correct code.
 */

/** Is this node inside a `def` or `node` body?
 *
 *  Those bodies have their own scope, so the top-level walk skips them or
 *  every name in them fires twice. */
export function hasFunctionOrNodeAncestor(
  ancestors: readonly unknown[],
): boolean {
  for (const ancestor of ancestors) {
    const type = (ancestor as AgencyNode | undefined)?.type;
    if (type === "function" || type === "graphNode") {
      return true;
    }
  }
  return false;
}

/**
 * Is this `variableName` a real read that has to resolve?
 *
 * Three positions look like reads and are not. A property name in
 * `obj.x` is not a lookup. A `for` binder is a declaration. A block-call
 * parameter, as in `xs.map(\(item) -> item)`, is a binding the
 * typechecker's `Scope` does not track at all, so resolving it would
 * always fail.
 */
export function isResolvableVariableReference(
  ref: VariableNameLiteral,
  ancestors: readonly WalkAncestor[],
): boolean {
  const parent = ancestors[ancestors.length - 1] as AgencyNode | undefined;
  if (!parent) {
    return false;
  }
  // The base of `obj.x` is a real reference. The property is not, and
  // walkNodes does not yield it as a standalone name anyway.
  if (parent.type === "valueAccess" && parent.base !== ref) {
    return false;
  }
  for (const ancestor of ancestors) {
    const node = ancestor as AgencyNode;
    if (node.type === "forLoop") {
      if (ref.value === node.itemVar || ref.value === node.indexVar) {
        return false;
      }
    }
    if ((ancestor as { type: string }).type === "blockArgument") {
      const block = ancestor as {
        type: "blockArgument";
        params: { name: string }[];
      };
      if (block.params.some((param) => param.name === ref.value)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Is this `functionCall` a bare call whose name has to resolve?
 *
 * A synthetic call has no declaration to find, and the builder compiles
 * it away. A call under a `valueAccess` is `obj.foo()`, where `foo` is a
 * method rather than a lexical name; the access chain checks it instead.
 */
export function isResolvableBareCall(
  call: FunctionCall,
  ancestors: readonly WalkAncestor[],
): boolean {
  if (call.synthetic) {
    return false;
  }
  const parent = ancestors[ancestors.length - 1] as AgencyNode | undefined;
  return parent?.type !== "valueAccess";
}
