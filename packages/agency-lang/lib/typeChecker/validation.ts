import type { VariableType, FunctionDefinition, GraphNodeDefinition } from "../types.js";
import type { ImportedFunctionSignature } from "../compilationUnit.js";

const STRING_T: VariableType = { type: "primitiveType", value: "string" };

/**
 * Wrap `t` in Result<T, string> when `validated` is true, mirroring the
 * runtime's __validateType wrapping. Per the no-rewrap rule in
 * docs-new/guide/schemas.md, an already-Result type passes through.
 */
export function applyValidationFlag(
  t: VariableType,
  validated: boolean | undefined,
): VariableType {
  if (!validated) return t;
  if (t.type === "resultType") return t;
  return {
    type: "resultType",
    successType: t,
    failureType: STRING_T,
  };
}

/**
 * The caller-visible return type of a function/node, after applying any `!`
 * on the declared return type. Does NOT auto-wrap based on validated params —
 * the auto-wrap for unannotated returns happens during inference.
 *
 * Returns undefined for functions with no declared return type and no
 * inference yet — caller should look up the inferred return type instead.
 */
export function effectiveReturnType(
  def: FunctionDefinition | GraphNodeDefinition | ImportedFunctionSignature,
): VariableType | null | undefined {
  if (!def.returnType) return def.returnType;
  const validated = "returnTypeValidated" in def ? def.returnTypeValidated : undefined;
  return applyValidationFlag(def.returnType, validated);
}
