import type {
  VariableType,
  FunctionDefinition,
  GraphNodeDefinition,
} from "../types.js";
import type { ImportedFunctionSignature } from "../compilationUnit.js";
import { STRING_T } from "./primitives.js";

/**
 * Wrap `t` in Result<T, string> when `validated` is true, mirroring the
 * runtime's __validateType wrapping. An already-Result type passes through
 * without re-wrapping.
 */
export function resultTypeForValidation(
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
 * Returns the un-set value (`null` for unannotated functions/nodes per the
 * parser, `undefined` if the field is absent) when there's no declared
 * return type — caller should look up the inferred return type instead.
 *
 * For ImportedFunctionSignature, the bang is already baked into `returnType`
 * at compilation-unit-build time (see compilationUnit.ts), so passing one
 * through here is a no-op wrap — the un-bang'd shape isn't reachable.
 */
export function effectiveReturnType(
  def: FunctionDefinition | GraphNodeDefinition | ImportedFunctionSignature,
): VariableType | null | undefined {
  if (!def.returnType) return def.returnType;
  const validated =
    "returnTypeValidated" in def ? def.returnTypeValidated : undefined;
  return resultTypeForValidation(def.returnType, validated);
}
